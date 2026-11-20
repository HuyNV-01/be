import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import {
  ChannelTypeEnum,
  ConversationSupportStatusEnum,
  ConversationTypeEnum,
  MembershipStatusEnum,
  MessageStatusEnum,
  MessageTypeEnum,
  ShopRoleEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { envs } from 'src/config/envs/envs';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { ChannelIntegrationEntity } from 'src/entity/channel-integration.entity';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { MessageDirectionEnum, MessageEntity } from 'src/entity/message.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { MessageCryptoService } from 'src/modules/chat/services/message-crypto.service';
import { In, Repository } from 'typeorm';

import {
  NormalizedOmnichannelAttachment,
  extractMetaAttachmentsFromPayload,
  extractZaloAttachmentsFromPayload,
  resolveMessageTypeAndAttachments,
} from '../helpers/omnichannel-attachment-normalizer.helper';
import { OmnichannelAvatarAndMediaService } from './omnichannel-avatar-and-media.service';

export interface HistoricalSyncJobState {
  jobId: string;
  shopId: string;
  channelId: string;
  pageName: string;
  pageShortCode: string;
  channelType: ChannelTypeEnum;
  lookbackDays: number;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  stage: 'DISCOVERING_THREADS' | 'SYNCING_MESSAGES' | 'SYNCING_POST_COMMENTS' | 'DONE' | 'ERROR';
  progressPercent: number;
  conversationsScanned: number;
  conversationsProcessed: number;
  inboundMessagesSynced: number;
  outboundEchoMessagesSynced: number;
  postsScanned: number;
  adPostsScanned: number;
  commentsSynced: number;
  warnings: string[];
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  sinceIso: string;
}

const META_RATE_LIMIT_ERROR_CODES = new Set([4, 17, 32, 613, 80001]);
const META_TRANSIENT_ERROR_CODES = new Set([1, 2]);
const META_BUSINESS_SUITE_APP_ID = '263902037430900';

@Injectable()
export class ChannelHistoricalSyncService {
  private readonly logger = new Logger(ChannelHistoricalSyncService.name);

  constructor(
    @InjectRepository(ChannelIntegrationEntity)
    private readonly channelRepo: Repository<ChannelIntegrationEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(ConversationParticipantEntity)
    private readonly participantRepo: Repository<ConversationParticipantEntity>,
    @InjectRepository(MessageEntity)
    private readonly messageRepo: Repository<MessageEntity>,
    @InjectRepository(ShopMemberEntity)
    private readonly shopMemberRepo: Repository<ShopMemberEntity>,
    @InjectRedis()
    private readonly redis: Redis,
    private readonly messageCryptoService: MessageCryptoService,
    private readonly avatarAndMediaService: OmnichannelAvatarAndMediaService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private buildJobStateKey(shopId: string, channelId: string): string {
    return `channel:hist_sync_job:${shopId}:${channelId}`;
  }

  private buildJobLockKey(shopId: string, channelId: string): string {
    return `channel:hist_sync_lock:${shopId}:${channelId}`;
  }

  private buildCancelFlagKey(shopId: string, channelId: string): string {
    return `channel:hist_sync_cancel:${shopId}:${channelId}`;
  }

  private async saveAndEmitJobState(state: HistoricalSyncJobState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await this.redis
      .set(this.buildJobStateKey(state.shopId, state.channelId), JSON.stringify(state), 'EX', 86400)
      .catch(() => null);

    this.realtimeEmitter.emitToRoom(
      SOCKET_CONFIG.namespaces.CHAT,
      `shop:${state.shopId}`,
      'channels:historical_sync_progress',
      state,
    );
  }

  public async getHistoricalSyncStatus(
    shopId: string,
    channelId: string,
  ): Promise<HistoricalSyncJobState | null> {
    const raw = await this.redis.get(this.buildJobStateKey(shopId, channelId)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as HistoricalSyncJobState;
    } catch {
      return null;
    }
  }

  public async cancelHistoricalSyncJob(
    shopId: string,
    channelId: string,
  ): Promise<{ cancelled: boolean }> {
    await this.redis
      .set(this.buildCancelFlagKey(shopId, channelId), '1', 'EX', 600)
      .catch(() => null);
    return { cancelled: true };
  }

  /**
   * Khởi chạy tiến trình đồng bộ lịch sử 90 ngày ở chế độ nền (không bao giờ gây HTTP Timeout).
   */
  public async startChannelHistoricalSyncJob(params: {
    shopId: string;
    channelId: string;
    lookbackDays?: number;
    actorUserId?: string;
  }): Promise<{ accepted: boolean; alreadyRunning: boolean; state: HistoricalSyncJobState }> {
    const channel = await this.channelRepo.findOne({
      where: { id: params.channelId, shopId: params.shopId },
    });
    if (!channel) {
      throw new NotFoundException('CHANNEL_INTEGRATION_NOT_FOUND');
    }

    const lockKey = this.buildJobLockKey(params.shopId, params.channelId);
    const acquired = await this.redis.set(lockKey, '1', 'EX', 1800, 'NX');
    if (!acquired) {
      const existing = await this.getHistoricalSyncStatus(params.shopId, params.channelId);
      if (existing && existing.status === 'RUNNING') {
        return { accepted: true, alreadyRunning: true, state: existing };
      }
      await this.redis.set(lockKey, '1', 'EX', 1800);
    }

    await this.redis
      .del(this.buildCancelFlagKey(params.shopId, params.channelId))
      .catch(() => null);

    const clampedDays = Math.min(180, Math.max(1, Number(params.lookbackDays || 90)));
    const nowIso = new Date().toISOString();
    const sinceIso = new Date(Date.now() - clampedDays * 86_400_000).toISOString();

    const initialState: HistoricalSyncJobState = {
      jobId: `hsync_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      shopId: params.shopId,
      channelId: channel.id,
      pageName: channel.pageName,
      pageShortCode: channel.pageShortCode,
      channelType: channel.channelType,
      lookbackDays: clampedDays,
      status: 'RUNNING',
      stage: 'DISCOVERING_THREADS',
      progressPercent: 2,
      conversationsScanned: 0,
      conversationsProcessed: 0,
      inboundMessagesSynced: 0,
      outboundEchoMessagesSynced: 0,
      postsScanned: 0,
      adPostsScanned: 0,
      commentsSynced: 0,
      warnings: [],
      startedAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
      sinceIso,
    };

    await this.saveAndEmitJobState(initialState);

    // Chạy nền tách biệt khỏi vòng đời HTTP Request để tránh timeout 30-60s
    void this.executeHistoricalSyncPipeline(channel, initialState)
      .catch(async (err) => {
        initialState.status = 'FAILED';
        initialState.stage = 'ERROR';
        initialState.warnings.push(err instanceof Error ? err.message : String(err));
        initialState.completedAt = new Date().toISOString();
        await this.saveAndEmitJobState(initialState);
      })
      .finally(async () => {
        await this.redis.del(lockKey).catch(() => null);
      });

    return { accepted: true, alreadyRunning: false, state: initialState };
  }

  private async isJobCancelled(shopId: string, channelId: string): Promise<boolean> {
    const flag = await this.redis.get(this.buildCancelFlagKey(shopId, channelId)).catch(() => null);
    return flag === '1';
  }

  private computeAppSecretProof(accessToken: string, appSecret?: string | null): string | null {
    const cleanToken = (accessToken || '').trim();
    const cleanSecret = (appSecret || '').trim();
    if (!cleanToken || !cleanSecret) return null;
    return crypto.createHmac('sha256', cleanSecret).update(cleanToken).digest('hex');
  }

  private normalizeGraphVersion(rawVersion?: string | null): string {
    const v = String(rawVersion || '').trim();
    if (/^v\d+\.\d+$/.test(v)) {
      const major = Number(v.slice(1).split('.')[0]);
      if (major >= 19 && major <= 25) return v;
    }
    return 'v22.0';
  }

  /**
   * Gọi Meta Graph API (đường dẫn tương đối hoặc `paging.next` tuyệt đối) có tự động backoff khi gặp Rate Limit (#4/#17/#32/#613).
   */
  private async callMetaWithBackoff<T = any>(params: {
    absoluteUrl?: string | null;
    apiVersion?: string;
    path?: string;
    queryParams?: Record<string, string>;
    accessToken: string;
    appSecret?: string | null;
    timeoutMs?: number;
    maxRetries?: number;
  }): Promise<{ ok: boolean; data: T | null; errorCode?: number; errorMessage?: string }> {
    const cleanToken = params.accessToken.trim().replace(/^Bearer\s+/i, '');
    const proof = this.computeAppSecretProof(cleanToken, params.appSecret);
    const timeoutMs = params.timeoutMs || 20000;
    const maxRetries = params.maxRetries ?? 3;

    const buildTargetUrl = (includeProof: boolean): string => {
      if (params.absoluteUrl) {
        const parsed = new URL(params.absoluteUrl);
        if (!parsed.searchParams.has('access_token')) {
          parsed.searchParams.set('access_token', cleanToken);
        }
        if (includeProof && proof) {
          parsed.searchParams.set('appsecret_proof', proof);
        } else if (!includeProof) {
          parsed.searchParams.delete('appsecret_proof');
        }
        return parsed.toString();
      }
      const ver = this.normalizeGraphVersion(params.apiVersion);
      const qs = new URLSearchParams(params.queryParams || {});
      qs.set('access_token', cleanToken);
      if (includeProof && proof) {
        qs.set('appsecret_proof', proof);
      }
      return `https://graph.facebook.com/${ver}/${String(params.path || '').replace(/^\/+/, '')}?${qs.toString()}`;
    };

    let useProof = Boolean(proof);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const targetUrl = buildTargetUrl(useProof);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(targetUrl, { method: 'GET', signal: controller.signal });
        clearTimeout(timer);
        const json = (await res.json().catch(() => ({}))) as any;

        if (res.ok && !json?.error) {
          return { ok: true, data: json as T };
        }

        const errorCode = Number(json?.error?.code || res.status);
        const errorMessage = String(json?.error?.message || `HTTP ${res.status}`);

        if (useProof && errorMessage.toLowerCase().includes('appsecret_proof')) {
          useProof = false;
          continue;
        }

        if (
          (META_RATE_LIMIT_ERROR_CODES.has(errorCode) ||
            META_TRANSIENT_ERROR_CODES.has(errorCode)) &&
          attempt < maxRetries
        ) {
          const delayMs = Math.min(12000, 1500 * Math.pow(2, attempt));
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        return { ok: false, data: null, errorCode, errorMessage };
      } catch (err) {
        clearTimeout(timer);
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        return {
          ok: false,
          data: null,
          errorCode: 0,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { ok: false, data: null, errorCode: 0, errorMessage: 'MAX_RETRIES_EXCEEDED' };
  }

  private async getShopActiveMemberIdsForChannel(
    shopId: string,
    channelId: string,
  ): Promise<string[]> {
    const members = await this.shopMemberRepo.find({
      where: { shopId, membershipStatus: MembershipStatusEnum.ACTIVE },
    });
    return members
      .filter((m) => {
        if (m.role === ShopRoleEnum.SHOP_OWNER || m.role === ShopRoleEnum.SHOP_MANAGER) {
          return true;
        }
        const allowed = Array.isArray(m.allowedChannelIdsJson) ? m.allowedChannelIdsJson : [];
        return allowed.length === 0 || allowed.includes(channelId);
      })
      .map((m) => m.userId);
  }

  private async ensureParticipants(conversationId: string, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    const uniqueIds = Array.from(new Set(userIds));
    const existing = await this.participantRepo.find({
      where: { conversationId, userId: In(uniqueIds) },
      select: ['userId'],
    });
    const existingSet = new Set(existing.map((e) => e.userId));
    const missing = uniqueIds.filter((uid) => !existingSet.has(uid));
    if (missing.length > 0) {
      await this.participantRepo.save(
        missing.map((userId) =>
          this.participantRepo.create({
            conversationId,
            userId,
          }),
        ),
      );
    }
  }

  private async executeHistoricalSyncPipeline(
    channel: ChannelIntegrationEntity,
    state: HistoricalSyncJobState,
  ): Promise<void> {
    const rawToken = channel.accessTokenEncrypted
      ? this.messageCryptoService.decryptForConversation(
          channel.accessTokenEncrypted,
          channel.shopId,
        )
      : '';
    if (!rawToken || rawToken.startsWith('oauth2_tok_') || rawToken.startsWith('sandbox_')) {
      state.status = 'FAILED';
      state.stage = 'ERROR';
      state.warnings.push('Kênh đang dùng token sandbox hoặc chưa cấp quyền API thực tế.');
      state.completedAt = new Date().toISOString();
      await this.saveAndEmitJobState(state);
      return;
    }

    const rawAppSecret = channel.appSecretEncrypted
      ? this.messageCryptoService.decryptForConversation(channel.appSecretEncrypted, channel.shopId)
      : envs.omnichannelSaas.metaAppSecret || null;
    const sinceMs = Date.now() - state.lookbackDays * 86_400_000;
    const sinceUnixSec = Math.floor(sinceMs / 1000);
    const activeMemberIds = await this.getShopActiveMemberIdsForChannel(channel.shopId, channel.id);

    if (
      channel.channelType === ChannelTypeEnum.FACEBOOK_PAGE ||
      channel.channelType === ChannelTypeEnum.INSTAGRAM
    ) {
      await this.syncMetaInboxThreadsStreaming({
        channel,
        rawToken,
        rawAppSecret,
        sinceMs,
        activeMemberIds,
        state,
      });

      if (!(await this.isJobCancelled(channel.shopId, channel.id))) {
        await this.syncMetaPostAndAdCommentsStreaming({
          channel,
          rawToken,
          rawAppSecret,
          sinceMs,
          sinceUnixSec,
          activeMemberIds,
          state,
        });
      }
    } else if (channel.channelType === ChannelTypeEnum.ZALO_OA) {
      await this.syncZaloOaHistoricalMessages({
        channel,
        rawToken,
        sinceMs,
        activeMemberIds,
        state,
      });
    } else {
      state.warnings.push(
        `Kênh ${channel.channelType} đồng bộ lịch sử qua Webhook và Marketplace Bridge định kỳ.`,
      );
    }

    const cancelled = await this.isJobCancelled(channel.shopId, channel.id);
    state.status = cancelled ? 'CANCELLED' : 'COMPLETED';
    state.stage = 'DONE';
    state.progressPercent = 100;
    state.completedAt = new Date().toISOString();
    await this.saveAndEmitJobState(state);
  }

  private async syncMetaInboxThreadsStreaming(params: {
    channel: ChannelIntegrationEntity;
    rawToken: string;
    rawAppSecret: string | null;
    sinceMs: number;
    activeMemberIds: string[];
    state: HistoricalSyncJobState;
  }): Promise<void> {
    const { channel, rawToken, rawAppSecret, sinceMs, activeMemberIds, state } = params;
    const isIg = channel.channelType === ChannelTypeEnum.INSTAGRAM;
    const apiVer = this.normalizeGraphVersion(channel.apiVersion);

    // Progressive field fallback: IG không hỗ trợ `senders`, FB hỗ trợ cả `participants` và `senders`
    let convFields = isIg
      ? 'id,updated_time,participants{id,name,username}'
      : 'id,updated_time,participants{id,name},senders{id,name}';
    let convLimit = 25;
    let nextConvUrl: string | null = null;
    const discoveredThreads: Array<{
      id: string;
      updated_time?: string;
      participants?: { data?: Array<{ id?: string; name?: string; username?: string }> };
      senders?: { data?: Array<{ id?: string; name?: string; username?: string }> };
    }> = [];

    const MAX_CONV_PAGES = 100;
    for (let pageIdx = 0; pageIdx < MAX_CONV_PAGES; pageIdx++) {
      if (await this.isJobCancelled(channel.shopId, channel.id)) return;

      const convRes = await this.callMetaWithBackoff<{
        data?: typeof discoveredThreads;
        paging?: { next?: string };
      }>({
        absoluteUrl: nextConvUrl,
        apiVersion: apiVer,
        path: `${channel.externalPageId}/conversations`,
        queryParams: {
          platform: isIg ? 'instagram' : 'messenger',
          fields: convFields,
          limit: String(convLimit),
        },
        accessToken: rawToken,
        appSecret: rawAppSecret,
      });

      if (!convRes.ok) {
        if (pageIdx === 0 && convRes.errorCode === 100 && convFields.includes('senders')) {
          convFields = 'id,updated_time,participants{id,name}';
          pageIdx = -1;
          continue;
        }
        if (
          pageIdx === 0 &&
          convLimit > 10 &&
          (convRes.errorCode === 1 || convRes.errorCode === 2)
        ) {
          convLimit = 10;
          pageIdx = -1;
          continue;
        }
        state.warnings.push(
          `Dừng quét danh sách hội thoại ở trang #${pageIdx + 1}: [${convRes.errorCode}] ${convRes.errorMessage}`,
        );
        break;
      }

      const rows = Array.isArray(convRes.data?.data) ? convRes.data.data : [];
      if (rows.length === 0) break;

      let reachedOldThread = false;
      for (const th of rows) {
        const updatedMs = th.updated_time ? Date.parse(th.updated_time) : Date.now();
        if (!Number.isNaN(updatedMs) && updatedMs < sinceMs) {
          reachedOldThread = true;
          continue;
        }
        discoveredThreads.push(th);
      }

      state.conversationsScanned = discoveredThreads.length;
      state.progressPercent = Math.min(20, 5 + Math.floor((pageIdx + 1) * 1.5));
      await this.saveAndEmitJobState(state);

      if (reachedOldThread || !convRes.data?.paging?.next) break;
      nextConvUrl = convRes.data.paging.next;
    }

    state.stage = 'SYNCING_MESSAGES';
    await this.saveAndEmitJobState(state);

    // Progressive message fields: đảm bảo lấy đầy đủ subfields của `attachments`, `sticker`, `shares`
    const fullMsgFields = isIg
      ? 'id,message,created_time,from,to,attachments{id,mime_type,name,size,file_url,image_data{url,preview_url,width,height},video_data{url,preview_url,width,height,length}}'
      : 'id,message,created_time,from,to,sticker,shares{id,link,name,description},attachments{id,mime_type,name,size,file_url,image_data{url,preview_url,width,height,animated_gif_url,animated_gif_preview_url},video_data{url,preview_url,width,height,length}}';
    const liteMsgFields =
      'id,message,created_time,from,to,attachments{id,mime_type,name,file_url,image_data,video_data}';

    let activeMsgFields = fullMsgFields;

    for (let tIdx = 0; tIdx < discoveredThreads.length; tIdx++) {
      if (await this.isJobCancelled(channel.shopId, channel.id)) return;

      const threadObj = discoveredThreads[tIdx];
      const pool = [...(threadObj.participants?.data || []), ...(threadObj.senders?.data || [])];
      const customerPart = pool.find((p) => p?.id && String(p.id) !== channel.externalPageId);

      const threadMessages: Array<{
        mid: string;
        customerPsid: string;
        customerName: string;
        isEchoFromPage: boolean;
        rawText: string;
        attachments: NormalizedOmnichannelAttachment[];
        createdTimeMs: number;
      }> = [];

      let nextMsgUrl: string | null = null;
      const MAX_MSG_PAGES = 40;

      for (let mPage = 0; mPage < MAX_MSG_PAGES; mPage++) {
        const msgRes = await this.callMetaWithBackoff<{
          data?: Array<{
            id: string;
            message?: string;
            created_time?: string;
            from?: { id?: string; name?: string; username?: string };
            to?: { data?: Array<{ id?: string; name?: string; username?: string }> };
            attachments?: { data?: any[] };
            shares?: { data?: any[] };
            sticker?: string;
          }>;
          paging?: { next?: string };
        }>({
          absoluteUrl: nextMsgUrl,
          apiVersion: apiVer,
          path: `${threadObj.id}/messages`,
          queryParams: {
            fields: activeMsgFields,
            limit: '50',
          },
          accessToken: rawToken,
          appSecret: rawAppSecret,
        });

        if (!msgRes.ok) {
          if (msgRes.errorCode === 100 && activeMsgFields !== liteMsgFields) {
            activeMsgFields = liteMsgFields;
            mPage = -1;
            continue;
          }
          state.warnings.push(
            `Lỗi lấy tin nhắn luồng ${threadObj.id}: [${msgRes.errorCode}] ${msgRes.errorMessage}`,
          );
          break;
        }

        const batch = Array.isArray(msgRes.data?.data) ? msgRes.data.data : [];
        if (batch.length === 0) break;

        let reachedOldMsg = false;
        for (const m of batch) {
          if (!m?.id) continue;
          const createdMs = m.created_time ? Date.parse(m.created_time) : Date.now();
          if (!Number.isNaN(createdMs) && createdMs < sinceMs) {
            reachedOldMsg = true;
            continue;
          }

          const fromId = String(m.from?.id || '').trim();
          const isEcho = Boolean(fromId && fromId === channel.externalPageId);
          const customerPsid = String(
            (!isEcho ? fromId : customerPart?.id || m.to?.data?.[0]?.id) || '',
          ).trim();
          if (!customerPsid) continue;

          const customerName = String(
            (!isEcho
              ? m.from?.name || m.from?.username
              : customerPart?.name || customerPart?.username) ||
              `Khách ${channel.pageShortCode} #${customerPsid.slice(-4)}`,
          );

          const normalizedAtts = extractMetaAttachmentsFromPayload({
            rawAttachments: m.attachments?.data,
            stickerUrl: m.sticker || null,
            shares: m.shares?.data,
            fallbackIdPrefix: m.id,
          });

          if (!String(m.message || '').trim() && normalizedAtts.length === 0) continue;

          threadMessages.push({
            mid: m.id,
            customerPsid,
            customerName,
            isEchoFromPage: isEcho,
            rawText: String(m.message || ''),
            attachments: normalizedAtts,
            createdTimeMs: !Number.isNaN(createdMs) ? createdMs : Date.now(),
          });
        }

        if (reachedOldMsg || !msgRes.data?.paging?.next) break;
        nextMsgUrl = msgRes.data.paging.next;
      }

      // Lưu ngay lập tức toàn bộ tin nhắn của luồng này theo thứ tự cũ -> mới (Streaming Flush)
      if (threadMessages.length > 0) {
        threadMessages.sort((a, b) => a.createdTimeMs - b.createdTimeMs);
        const existingRows = await this.messageRepo.find({
          where: {
            shopId: channel.shopId,
            externalMessageId: In(threadMessages.map((x) => x.mid)),
          },
          select: ['externalMessageId'],
        });
        const existingMidSet = new Set(
          existingRows.map((r) => r.externalMessageId).filter(Boolean),
        );

        for (const msgItem of threadMessages) {
          if (existingMidSet.has(msgItem.mid)) continue;
          existingMidSet.add(msgItem.mid);

          const inserted = await this.upsertSingleHistoricalMessage({
            channel,
            externalThreadId: `inbox_${msgItem.customerPsid}`,
            externalCustomerPsid: msgItem.customerPsid,
            externalMessageId: msgItem.mid,
            customerName: msgItem.customerName,
            interactionType: 'INBOX',
            isEchoFromPage: msgItem.isEchoFromPage,
            rawText: msgItem.rawText,
            attachments: msgItem.attachments,
            createdTimeMs: msgItem.createdTimeMs,
            activeMemberIds,
          });

          if (inserted) {
            if (msgItem.isEchoFromPage) state.outboundEchoMessagesSynced += 1;
            else state.inboundMessagesSynced += 1;
          }
        }
      }

      state.conversationsProcessed = tIdx + 1;
      state.progressPercent =
        discoveredThreads.length > 0
          ? 20 + Math.floor(((tIdx + 1) / discoveredThreads.length) * 55)
          : 75;
      if ((tIdx + 1) % 5 === 0 || tIdx === discoveredThreads.length - 1) {
        await this.saveAndEmitJobState(state);
      }
    }
  }

  private async syncMetaPostAndAdCommentsStreaming(params: {
    channel: ChannelIntegrationEntity;
    rawToken: string;
    rawAppSecret: string | null;
    sinceMs: number;
    sinceUnixSec: number;
    activeMemberIds: string[];
    state: HistoricalSyncJobState;
  }): Promise<void> {
    const { channel, rawToken, rawAppSecret, sinceMs, sinceUnixSec, activeMemberIds, state } =
      params;
    if (channel.channelType !== ChannelTypeEnum.FACEBOOK_PAGE) return;

    state.stage = 'SYNCING_POST_COMMENTS';
    await this.saveAndEmitJobState(state);

    const apiVer = this.normalizeGraphVersion(channel.apiVersion);
    const discoveredPostIds = new Set<string>();
    const adPostIds = new Set<string>();

    const postEdges: Array<{ path: string; isAd: boolean; extra: Record<string, string> }> = [
      { path: `${channel.externalPageId}/published_posts`, isAd: false, extra: {} },
      { path: `${channel.externalPageId}/feed`, isAd: false, extra: {} },
      {
        path: `${channel.externalPageId}/ads_posts`,
        isAd: true,
        extra: { include_inline_create: 'true' },
      },
    ];

    for (const edge of postEdges) {
      let nextUrl: string | null = null;
      for (let pPage = 0; pPage < 15; pPage++) {
        if (await this.isJobCancelled(channel.shopId, channel.id)) return;
        const postRes = await this.callMetaWithBackoff<{
          data?: Array<{ id: string; created_time?: string }>;
          paging?: { next?: string };
        }>({
          absoluteUrl: nextUrl,
          apiVersion: apiVer,
          path: edge.path,
          queryParams: {
            fields: 'id,created_time',
            since: String(sinceUnixSec),
            limit: '50',
            ...edge.extra,
          },
          accessToken: rawToken,
          appSecret: rawAppSecret,
        });

        if (!postRes.ok || !Array.isArray(postRes.data?.data)) break;
        for (const p of postRes.data.data) {
          if (!p?.id) continue;
          discoveredPostIds.add(p.id);
          if (edge.isAd) adPostIds.add(p.id);
        }
        if (!postRes.data.paging?.next) break;
        nextUrl = postRes.data.paging.next;
      }
    }

    state.postsScanned = discoveredPostIds.size;
    state.adPostsScanned = adPostIds.size;
    await this.saveAndEmitJobState(state);

    const postIdArray = Array.from(discoveredPostIds);
    for (let idx = 0; idx < postIdArray.length; idx++) {
      if (await this.isJobCancelled(channel.shopId, channel.id)) return;
      const postId = postIdArray[idx];

      let nextCmtUrl: string | null = null;
      for (let cPage = 0; cPage < 15; cPage++) {
        const cmtRes = await this.callMetaWithBackoff<{
          data?: Array<{
            id: string;
            message?: string;
            created_time?: string;
            from?: { id?: string; name?: string; picture?: { data?: { url?: string } } };
            parent?: { id?: string };
            attachment?: any;
          }>;
          paging?: { next?: string };
        }>({
          absoluteUrl: nextCmtUrl,
          apiVersion: apiVer,
          path: `${postId}/comments`,
          queryParams: {
            filter: 'stream',
            since: String(sinceUnixSec),
            limit: '100',
            fields:
              'id,message,created_time,from{id,name,picture.type(large)},parent{id},attachment,is_hidden',
          },
          accessToken: rawToken,
          appSecret: rawAppSecret,
        });

        if (!cmtRes.ok || !Array.isArray(cmtRes.data?.data)) break;

        const batch = cmtRes.data.data;
        const existingRows = await this.messageRepo.find({
          where: { shopId: channel.shopId, externalMessageId: In(batch.map((c) => c.id)) },
          select: ['externalMessageId'],
        });
        const existingSet = new Set(existingRows.map((r) => r.externalMessageId).filter(Boolean));

        for (const cmt of batch) {
          if (!cmt?.id || existingSet.has(cmt.id)) continue;
          const cmtMs = cmt.created_time ? Date.parse(cmt.created_time) : Date.now();
          if (!Number.isNaN(cmtMs) && cmtMs < sinceMs) continue;

          const commenterId = String(cmt.from?.id || `fb_cmt_${cmt.id.slice(-6)}`);
          const commenterName = String(
            cmt.from?.name || `Khách bình luận #${commenterId.slice(-4)}`,
          );
          const isEcho = Boolean(channel.externalPageId && commenterId === channel.externalPageId);
          const atts = cmt.attachment
            ? extractMetaAttachmentsFromPayload({
                rawAttachments: [cmt.attachment],
                fallbackIdPrefix: cmt.id,
              })
            : [];

          if (cmt.from?.picture?.data?.url && !isEcho) {
            await this.redis
              .set(
                `psid_avatar_raw:${channel.id}:${commenterId}`,
                cmt.from.picture.data.url,
                'EX',
                21600,
              )
              .catch(() => null);
          }

          const inserted = await this.upsertSingleHistoricalMessage({
            channel,
            externalThreadId: `cmt_${postId}_${commenterId}`,
            externalCustomerPsid: commenterId,
            externalMessageId: cmt.id,
            customerName: commenterName,
            interactionType: 'COMMENT',
            isEchoFromPage: isEcho,
            rawText: String(cmt.message || ''),
            attachments: atts,
            createdTimeMs: !Number.isNaN(cmtMs) ? cmtMs : Date.now(),
            activeMemberIds,
            sourcePostId: postId,
            externalCommentId: cmt.id,
            parentCommentId: cmt.parent?.id || null,
          });
          if (inserted) state.commentsSynced += 1;
        }

        if (!cmtRes.data.paging?.next) break;
        nextCmtUrl = cmtRes.data.paging.next;
      }

      state.progressPercent =
        postIdArray.length > 0 ? 75 + Math.floor(((idx + 1) / postIdArray.length) * 24) : 99;
      if ((idx + 1) % 5 === 0 || idx === postIdArray.length - 1) {
        await this.saveAndEmitJobState(state);
      }
    }
  }

  private async syncZaloOaHistoricalMessages(params: {
    channel: ChannelIntegrationEntity;
    rawToken: string;
    sinceMs: number;
    activeMemberIds: string[];
    state: HistoricalSyncJobState;
  }): Promise<void> {
    const { channel, rawToken, sinceMs, activeMemberIds, state } = params;
    const discoveredUserIds = new Set<string>();

    for (let offset = 0; offset < 500; offset += 10) {
      if (await this.isJobCancelled(channel.shopId, channel.id)) return;
      const listUrl = `https://openapi.zalo.me/v2.0/oa/listrecentchat?data=${encodeURIComponent(
        JSON.stringify({ offset, count: 10 }),
      )}`;
      const res = await fetch(listUrl, {
        method: 'GET',
        headers: { access_token: rawToken },
      }).catch(() => null);
      if (!res || !res.ok) break;
      const json = (await res.json().catch(() => ({}))) as any;
      if (Number(json?.error) !== 0 || !Array.isArray(json?.data) || json.data.length === 0) break;

      let reachedOld = false;
      for (const item of json.data) {
        const ts = Number(item.time || Date.now());
        if (ts < sinceMs) {
          reachedOld = true;
          continue;
        }
        const uid = String(item.src === 1 ? item.from_id : item.to_id || '').trim();
        if (uid) discoveredUserIds.add(uid);
      }
      state.conversationsScanned = discoveredUserIds.size;
      if (reachedOld || json.data.length < 10) break;
    }

    state.stage = 'SYNCING_MESSAGES';
    await this.saveAndEmitJobState(state);

    const userIds = Array.from(discoveredUserIds);
    for (let uIdx = 0; uIdx < userIds.length; uIdx++) {
      const uid = userIds[uIdx];
      const profile = await this.avatarAndMediaService.resolveBuyerProfileAcrossChannels({
        channel,
        externalCustomerPsid: uid,
        fallbackName: `Khách Zalo #${uid.slice(-4)}`,
      });

      for (let offset = 0; offset < 200; offset += 10) {
        const convUrl = `https://openapi.zalo.me/v2.0/oa/conversation?data=${encodeURIComponent(
          JSON.stringify({ user_id: uid, offset, count: 10 }),
        )}`;
        const res = await fetch(convUrl, {
          method: 'GET',
          headers: { access_token: rawToken },
        }).catch(() => null);
        if (!res || !res.ok) break;
        const json = (await res.json().catch(() => ({}))) as any;
        if (Number(json?.error) !== 0 || !Array.isArray(json?.data) || json.data.length === 0)
          break;

        let reachedOld = false;
        for (const msg of json.data) {
          const ts = Number(msg.time || Date.now());
          if (ts < sinceMs) {
            reachedOld = true;
            continue;
          }
          const isEcho = Number(msg.src) === 0;
          const atts = extractZaloAttachmentsFromPayload({
            rawAttachments: msg.attachments,
            fallbackIdPrefix: String(msg.message_id || `${uid}_${ts}`),
          });
          const inserted = await this.upsertSingleHistoricalMessage({
            channel,
            externalThreadId: `zalo_${uid}`,
            externalCustomerPsid: uid,
            externalMessageId: String(msg.message_id || `zalo_${uid}_${ts}`),
            customerName: profile.name,
            interactionType: 'INBOX',
            isEchoFromPage: isEcho,
            rawText: String(msg.message || ''),
            attachments: atts,
            createdTimeMs: ts,
            activeMemberIds,
          });
          if (inserted) {
            if (isEcho) state.outboundEchoMessagesSynced += 1;
            else state.inboundMessagesSynced += 1;
          }
        }
        if (reachedOld || json.data.length < 10) break;
      }

      state.conversationsProcessed = uIdx + 1;
      state.progressPercent =
        userIds.length > 0 ? 20 + Math.floor(((uIdx + 1) / userIds.length) * 78) : 98;
      await this.saveAndEmitJobState(state);
    }
  }

  private async upsertSingleHistoricalMessage(params: {
    channel: ChannelIntegrationEntity;
    externalThreadId: string;
    externalCustomerPsid: string;
    externalMessageId: string;
    customerName: string;
    interactionType: 'INBOX' | 'COMMENT' | 'LIVESTREAM';
    isEchoFromPage: boolean;
    rawText: string;
    attachments: NormalizedOmnichannelAttachment[];
    createdTimeMs: number;
    activeMemberIds: string[];
    sourcePostId?: string | null;
    externalCommentId?: string | null;
    parentCommentId?: string | null;
  }): Promise<boolean> {
    const { channel } = params;
    const msgTime = new Date(params.createdTimeMs);
    const msgTimeIso = msgTime.toISOString();

    // Đăng ký Media Proxy cho mọi URL ảnh/sticker/video/audio để không hết hạn chữ ký CDN
    const proxiedUrls: string[] = [];
    for (const att of params.attachments) {
      const proxied = await this.avatarAndMediaService.registerProxiedMediaUrl({
        shopId: channel.shopId,
        channelId: channel.id,
        sourceUrl: att.url,
        mimeType: att.mimeType,
        fileName: att.fileName,
        externalMessageId: params.externalMessageId,
      });
      proxiedUrls.push(proxied);
    }

    const mediaResolution = resolveMessageTypeAndAttachments({
      rawText: params.rawText,
      attachments: params.attachments,
      rewriteUrl: (_att, idx) => proxiedUrls[idx] || _att.url,
    });

    const stableAvatar = this.avatarAndMediaService.buildStableAvatarProxyPath(
      channel.shopId,
      channel.id,
      params.externalCustomerPsid,
    );

    let conversation = await this.conversationRepo.findOne({
      where: {
        shopId: channel.shopId,
        channelIntegrationId: channel.id,
        externalThreadId: params.externalThreadId,
      },
      withDeleted: true,
    });

    if (!conversation) {
      conversation = await this.conversationRepo.save(
        this.conversationRepo.create({
          type: ConversationTypeEnum.DIRECT,
          shopId: channel.shopId,
          channelType: channel.channelType,
          channelIntegrationId: channel.id,
          externalThreadId: params.externalThreadId,
          interactionType: params.interactionType,
          name: params.customerName,
          avatar: stableAvatar,
          lastMessage: mediaResolution.displayText,
          lastMessageType: mediaResolution.messageType,
          lastMessageAt: msgTime,
          lastCustomerMessageAt: params.isEchoFromPage ? null : msgTime,
          lastAgentReplyAt: params.isEchoFromPage ? msgTime : null,
          supportStatus: params.isEchoFromPage
            ? ConversationSupportStatusEnum.WAITING_CUSTOMER_REPLY
            : ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
          firstSeenAt: params.isEchoFromPage ? msgTime : null,
          isGhostedByAgent: false,
          hasPhoneCollected: false,
          sourcePostId: params.sourcePostId || null,
          activeTagIdsJson: [],
        }),
      );

      const encLast = this.messageCryptoService.encryptForConversation(
        mediaResolution.displayText,
        conversation.id,
      );
      await this.conversationRepo.update(conversation.id, { lastMessage: encLast.ciphertext });
      await this.ensureParticipants(conversation.id, params.activeMemberIds);
    } else {
      if (conversation.deletedAt) {
        await this.conversationRepo.restore(conversation.id);
      }
      const patch: Partial<ConversationEntity> = {};
      if (
        params.customerName &&
        !params.customerName.includes('#') &&
        (!conversation.name || conversation.name.includes('#'))
      ) {
        patch.name = params.customerName;
      }
      if (
        !conversation.avatar ||
        this.avatarAndMediaService.isExpiredMetaOrThirdPartyUrl(conversation.avatar)
      ) {
        patch.avatar = stableAvatar;
      }
      const currentLastMs = conversation.lastMessageAt
        ? new Date(conversation.lastMessageAt).getTime()
        : 0;
      if (msgTime.getTime() >= currentLastMs) {
        const encLast = this.messageCryptoService.encryptForConversation(
          mediaResolution.displayText,
          conversation.id,
        );
        patch.lastMessage = encLast.ciphertext;
        patch.lastMessageType = mediaResolution.messageType;
        patch.lastMessageAt = msgTime;
        if (params.isEchoFromPage) {
          patch.lastAgentReplyAt = msgTime;
          patch.supportStatus = ConversationSupportStatusEnum.WAITING_CUSTOMER_REPLY;
        } else {
          patch.lastCustomerMessageAt = msgTime;
        }
      }
      if (Object.keys(patch).length > 0) {
        await this.conversationRepo.update(conversation.id, patch);
      }
      await this.ensureParticipants(conversation.id, params.activeMemberIds);
    }

    const encryptedContent = this.messageCryptoService.encryptForConversation(
      mediaResolution.displayText,
      conversation.id,
    );

    const senderId = params.isEchoFromPage
      ? `page:${channel.externalPageId || channel.id}`
      : `ext:${channel.channelType.toLowerCase()}:${params.externalThreadId.slice(0, 18)}`;

    await this.messageRepo.save(
      this.messageRepo.create({
        shopId: channel.shopId,
        conversationId: conversation.id,
        senderId,
        content: encryptedContent.ciphertext,
        type: mediaResolution.messageType,
        direction: params.isEchoFromPage
          ? MessageDirectionEnum.OUTBOUND
          : MessageDirectionEnum.INBOUND,
        status: MessageStatusEnum.DELIVERED,
        externalMessageId: params.externalMessageId,
        readBy: [],
        deliveredTo: params.activeMemberIds,
        isPinned: false,
        metadata: {
          isEncrypted: encryptedContent.isEncrypted,
          encryptionAlg: encryptedContent.algorithm,
          channelType: channel.channelType,
          channelIntegrationId: channel.id,
          pageShortCode: channel.pageShortCode,
          pageName: channel.pageName,
          channelAvatarUrl: channel.avatarUrl || null,
          interactionType: params.interactionType,
          externalCustomerPsid: params.externalCustomerPsid,
          externalCustomerName: params.customerName,
          externalCustomerAvatar: stableAvatar,
          externalCommentId: params.externalCommentId || null,
          parentCommentId: params.parentCommentId || null,
          sourcePostId: params.sourcePostId || null,
          attachments: mediaResolution.attachments,
          mediaAttachmentUrl: mediaResolution.primaryMediaUrl,
          hasSticker: mediaResolution.hasSticker,
          stickerId: mediaResolution.stickerId,
          isEchoFromPage: params.isEchoFromPage,
          echoSourceAppId: params.isEchoFromPage ? META_BUSINESS_SUITE_APP_ID : null,
          syncedHistorical3m: true,
          historicalCreatedAtIso: msgTimeIso,
        } as any,
        createdAt: msgTime,
        updatedAt: msgTime,
      }),
    );

    return true;
  }
}
