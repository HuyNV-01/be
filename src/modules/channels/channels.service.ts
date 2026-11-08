import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import {
  ChannelTypeEnum,
  ConversationSupportStatusEnum,
  ConversationTypeEnum,
  GroupRoleEnum,
  MembershipStatusEnum,
  MessageStatusEnum,
  MessageTypeEnum,
  NotificationResourceTypeEnum,
  NotificationTypeEnum,
  ShopRoleEnum,
  WebhookIntegrationStatusEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  ConnectChannelOAuthDto,
  MergedInboxQueryDto,
  UpdateChannelIntegrationDto,
  WebhookLogQueryDto,
} from 'src/dto/channels/channels.dto';
import { ChannelIntegrationEntity } from 'src/entity/channel-integration.entity';
import { ChannelWebhookLogEntity } from 'src/entity/channel-webhook-log.entity';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity, ConversationInteractionType } from 'src/entity/conversation.entity';
import { MessageDirectionEnum, MessageEntity } from 'src/entity/message.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { MessageCryptoService } from 'src/modules/chat/services/message-crypto.service';
import { DataScopeQueryHelper } from 'src/modules/iam/helpers/data-scope-query.helper';
import { EffectiveMemberContext } from 'src/modules/iam/iam.service';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import { In, Repository } from 'typeorm';

import { ConversationRoutingEngine } from './routing/conversation-routing.engine';
import { MarketplaceBridgeService } from './services/marketplace-bridge.service';

export interface NormalizedOmnichannelEvent {
  externalPageId: string;
  externalThreadId: string;
  externalMessageId: string;
  customerName: string;
  messageText: string;
  interactionType: ConversationInteractionType;
  verb: 'add' | 'edited' | 'remove';
  sourcePostId: string | null;
  sourceAdId: string | null;
  ctwaClickId: string | null;
  externalCommentId: string | null;
  parentCommentId: string | null;
  mediaAttachmentUrl: string | null;
}

const TOKEN_BUCKET_LUA_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRatePerSec = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
local tokens = tonumber(data[1])
local lastRefillMs = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  lastRefillMs = nowMs
else
  local elapsedSec = math.max(0, (nowMs - lastRefillMs) / 1000.0)
  tokens = math.min(capacity, tokens + (elapsedSec * refillRatePerSec))
  lastRefillMs = nowMs
end

if tokens < requested then
  redis.call('HMSET', key, 'tokens', tokens, 'lastRefillMs', lastRefillMs)
  redis.call('EXPIRE', key, 3600)
  return {0, math.floor(tokens)}
end

tokens = tokens - requested
redis.call('HMSET', key, 'tokens', tokens, 'lastRefillMs', lastRefillMs)
redis.call('EXPIRE', key, 3600)
return {1, math.floor(tokens)}
`;

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    @InjectRepository(ChannelIntegrationEntity)
    private readonly channelRepo: Repository<ChannelIntegrationEntity>,
    @InjectRepository(ChannelWebhookLogEntity)
    private readonly webhookLogRepo: Repository<ChannelWebhookLogEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(ConversationParticipantEntity)
    private readonly participantRepo: Repository<ConversationParticipantEntity>,
    @InjectRepository(MessageEntity)
    private readonly messageRepo: Repository<MessageEntity>,
    @InjectRepository(ShopMemberEntity)
    private readonly memberRepo: Repository<ShopMemberEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    @InjectRedis() private readonly redis: Redis,
    private readonly messageCryptoService: MessageCryptoService,
    private readonly routingEngine: ConversationRoutingEngine,
    private readonly marketplaceBridge: MarketplaceBridgeService,
    private readonly notificationsService: NotificationsService,
    private readonly realtimeEmitter: RealtimeEmitterService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private async broadcastChannelEventToShop(
    shopId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<string[]> {
    const activeMembers = await this.memberRepo.find({
      where: {
        shopId,
        membershipStatus: MembershipStatusEnum.ACTIVE,
      },
      select: ['userId', 'role'],
    });

    const userIds = Array.from(new Set(activeMembers.map((m) => m.userId)));
    for (const uid of userIds) {
      this.realtimeEmitter.emitToUser(SOCKET_CONFIG.namespaces.CHAT, uid, eventName, payload);
    }

    return activeMembers
      .filter((m) => m.role === ShopRoleEnum.SHOP_OWNER || m.role === ShopRoleEnum.SHOP_MANAGER)
      .map((m) => m.userId);
  }

  private async ensureConversationParticipants(
    conversationId: string,
    userIds: string[],
  ): Promise<void> {
    const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
    const now = new Date();
    for (const userId of uniqueIds) {
      const existing = await this.participantRepo.findOne({
        where: { conversationId, userId },
        withDeleted: true,
      });
      if (!existing) {
        const part = this.participantRepo.create({
          conversationId,
          userId,
          role: GroupRoleEnum.MEMBER,
          isAdmin: false,
          isHidden: false,
          joinedAt: now,
        });
        await this.participantRepo.save(part).catch(() => undefined);
      } else if (existing.deletedAt || existing.isHidden) {
        if (existing.deletedAt) {
          await this.participantRepo.restore(existing.id).catch(() => undefined);
        }
        existing.deletedAt = null;
        existing.deletedBy = null;
        existing.isHidden = false;
        await this.participantRepo.save(existing).catch(() => undefined);
      }
    }
  }

  /**
   * Kiểm tra hạn ngạch Token-Bucket trên Redis Lua cho từng kênh để chống vượt ngưỡng Rate Limit nền tảng
   */
  async consumeChannelRateLimitToken(
    channelIntegrationId: string,
    capacity = 60,
    refillRatePerSec = 2,
  ): Promise<{ allowed: boolean; remainingTokens: number }> {
    const bucketKey = `rate_limit:channel_bucket:${channelIntegrationId}`;
    try {
      const res = (await this.redis.eval(
        TOKEN_BUCKET_LUA_SCRIPT,
        1,
        bucketKey,
        capacity,
        refillRatePerSec,
        Date.now(),
        1,
      )) as [number, number];
      return {
        allowed: Number(res?.[0] ?? 1) === 1,
        remainingTokens: Number(res?.[1] ?? capacity),
      };
    } catch {
      return { allowed: true, remainingTokens: capacity };
    }
  }

  /**
   * Xác thực chữ ký mật mã HMAC-SHA256 trên Header Webhook (Meta X-Hub-Signature-256, Zalo, Shopee, TikTok)
   */
  verifyWebhookSignatureIfConfigured(params: {
    channel: ChannelIntegrationEntity | null;
    headers: Record<string, string>;
    rawPayload: Record<string, unknown>;
  }): boolean {
    const { channel, headers, rawPayload } = params;
    if (!channel || !channel.webhookVerifySecretEncrypted) {
      return true;
    }

    const signatureHeader =
      headers['x-hub-signature-256'] ||
      headers['x-zalo-signature'] ||
      headers['x-shopee-signature'] ||
      headers['x-tts-signature'];

    if (!signatureHeader) {
      return true;
    }

    const secret = this.messageCryptoService.decryptForConversation(
      channel.webhookVerifySecretEncrypted,
      channel.shopId,
    );
    if (!secret) {
      return true;
    }

    const cleanProvidedSig = signatureHeader.replace(/^sha256=/i, '').trim();
    const expectedHmac = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(rawPayload || {}))
      .digest('hex');

    if (cleanProvidedSig.length !== expectedHmac.length) {
      throw new BadRequestException('INVALID_WEBHOOK_HMAC_SIGNATURE');
    }

    const isValid = crypto.timingSafeEqual(
      Buffer.from(cleanProvidedSig, 'utf8'),
      Buffer.from(expectedHmac, 'utf8'),
    );
    if (!isValid) {
      throw new BadRequestException('INVALID_WEBHOOK_HMAC_SIGNATURE');
    }
    return true;
  }

  /**
   * Kết nối mới hoặc khôi phục/cập nhật kênh đã từng ngắt kết nối (withDeleted: true)
   * Tránh triệt để lỗi ER_DUP_ENTRY trên unique index uq_channel_ext_page (shopId, channelType, externalPageId)
   */
  async connectOrUpdateChannelOAuth(
    shopId: string,
    dto: ConnectChannelOAuthDto,
    actorUserId?: string,
  ): Promise<ChannelIntegrationEntity> {
    const resolvedShortCode = dto.pageShortCode.trim().toUpperCase();
    const resolvedExternalPageId = (
      dto.externalPageId ||
      (dto.oauthCode
        ? `${dto.channelType.toLowerCase()}_${crypto
            .createHash('sha256')
            .update(dto.oauthCode)
            .digest('hex')
            .slice(0, 12)}`
        : `${dto.channelType.toLowerCase()}_${Date.now()}`)
    ).trim();

    const resolvedPageName = (dto.pageName || `${dto.channelType} — ${resolvedShortCode}`).trim();

    const rawAccessToken = (
      dto.accessToken || `oauth2_tok_${dto.oauthCode || crypto.randomBytes(16).toString('hex')}`
    ).trim();

    const rawRefreshToken =
      dto.refreshToken?.trim() || (dto.oauthCode ? `oauth2_rft_${dto.oauthCode.trim()}` : null);

    let channel = await this.channelRepo.findOne({
      where: {
        shopId,
        channelType: dto.channelType,
        externalPageId: resolvedExternalPageId,
      },
      withDeleted: true,
    });

    if (!channel) {
      const deletedByShortCode = await this.channelRepo.findOne({
        where: {
          shopId,
          channelType: dto.channelType,
          pageShortCode: resolvedShortCode,
          isActive: false,
        },
        withDeleted: true,
      });
      if (deletedByShortCode && deletedByShortCode.deletedAt) {
        channel = deletedByShortCode;
      }
    }

    const accessTokenEncrypted = this.messageCryptoService.encryptForConversation(
      rawAccessToken,
      shopId,
    ).ciphertext;

    const refreshTokenEncrypted = rawRefreshToken
      ? this.messageCryptoService.encryptForConversation(rawRefreshToken, shopId).ciphertext
      : null;

    const webhookVerifySecretEncrypted = dto.webhookVerifySecret
      ? this.messageCryptoService.encryptForConversation(dto.webhookVerifySecret.trim(), shopId)
          .ciphertext
      : null;

    const capiAccessTokenEncrypted = dto.capiAccessToken
      ? this.messageCryptoService.encryptForConversation(dto.capiAccessToken.trim(), shopId)
          .ciphertext
      : null;

    const defaultExpiry = dto.tokenExpiresAt
      ? new Date(dto.tokenExpiresAt)
      : new Date(Date.now() + 60 * 86400 * 1000);

    if (channel) {
      if (channel.deletedAt) {
        await this.channelRepo.restore(channel.id);
      }
      channel.deletedAt = null;
      channel.deletedBy = null;
      channel.externalPageId = resolvedExternalPageId;
      channel.pageName = resolvedPageName;
      channel.pageShortCode = resolvedShortCode;
      channel.externalShopId = dto.externalShopId || channel.externalShopId;
      channel.avatarUrl = dto.avatarUrl || channel.avatarUrl;
      channel.accessTokenEncrypted = accessTokenEncrypted;
      if (refreshTokenEncrypted) {
        channel.refreshTokenEncrypted = refreshTokenEncrypted;
      }
      if (webhookVerifySecretEncrypted) {
        channel.webhookVerifySecretEncrypted = webhookVerifySecretEncrypted;
      }
      if (dto.metaDatasetId !== undefined) {
        channel.metaDatasetId = dto.metaDatasetId;
      }
      if (capiAccessTokenEncrypted) {
        channel.capiAccessTokenEncrypted = capiAccessTokenEncrypted;
      }
      channel.tokenExpiresAt = defaultExpiry;
      channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
      channel.isActive = true;
      channel.lastErrorMessage = null;
    } else {
      channel = this.channelRepo.create({
        shopId,
        channelType: dto.channelType,
        externalPageId: resolvedExternalPageId,
        externalShopId: dto.externalShopId || null,
        pageName: resolvedPageName,
        pageShortCode: resolvedShortCode,
        avatarUrl: dto.avatarUrl || null,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        webhookVerifySecretEncrypted,
        metaDatasetId: dto.metaDatasetId || null,
        capiAccessTokenEncrypted,
        tokenExpiresAt: defaultExpiry,
        webhookStatus: WebhookIntegrationStatusEnum.HEALTHY,
        isActive: true,
      });
    }

    const saved = await this.channelRepo.save(channel);

    const [shop, managerIds] = await Promise.all([
      this.shopRepo.findOne({ where: { id: shopId } }),
      this.broadcastChannelEventToShop(shopId, SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED, {
        shopId,
        action: 'CONNECTED',
        channelId: saved.id,
        channelType: saved.channelType,
        pageName: saved.pageName,
        pageShortCode: saved.pageShortCode,
        webhookStatus: saved.webhookStatus,
      }),
    ]);

    if (shop && managerIds.length > 0) {
      const recipientIds = actorUserId
        ? managerIds.filter((uid) => uid !== actorUserId)
        : managerIds;
      if (recipientIds.length > 0) {
        await this.notificationsService.createAndDispatch({
          recipientIds,
          actorId: actorUserId || null,
          type: NotificationTypeEnum.CHANNEL_CONNECTED,
          title: `Đã kết nối kênh ${saved.pageName}`,
          content: `Kênh ${saved.pageShortCode} (${saved.channelType}) vừa được tích hợp vào cửa hàng ${shop.name}.`,
          resourceType: NotificationResourceTypeEnum.CHANNEL_INTEGRATION,
          resourceId: saved.id,
          dedupeKey: `channel_connected:${saved.id}:${Date.now()}`,
          metadata: {
            actionUrl: '/settings/channels',
            titleKey: 'i18n.channelConnected.title',
            contentKey: 'i18n.channelConnected.content',
            i18nParams: {
              pageName: saved.pageName,
              pageShortCode: saved.pageShortCode,
              channelType: saved.channelType,
              shopName: shop.name,
            },
          },
        });
      }
    }

    return saved;
  }

  async updateChannelIntegration(
    shopId: string,
    channelId: string,
    dto: UpdateChannelIntegrationDto,
  ): Promise<ChannelIntegrationEntity> {
    const channel = await this.channelRepo.findOne({
      where: { id: channelId, shopId },
    });
    if (!channel) {
      throw new NotFoundException('CHANNEL_INTEGRATION_NOT_FOUND');
    }

    if (dto.pageName !== undefined) {
      channel.pageName = dto.pageName.trim();
    }
    if (dto.pageShortCode !== undefined) {
      channel.pageShortCode = dto.pageShortCode.trim().toUpperCase();
    }
    if (dto.avatarUrl !== undefined) {
      channel.avatarUrl = dto.avatarUrl.trim() || null;
    }
    if (dto.accessToken) {
      channel.accessTokenEncrypted = this.messageCryptoService.encryptForConversation(
        dto.accessToken.trim(),
        shopId,
      ).ciphertext;
      channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
      channel.tokenExpiresAt = new Date(Date.now() + 60 * 86400 * 1000);
      channel.lastErrorMessage = null;
    }
    if (dto.refreshToken) {
      channel.refreshTokenEncrypted = this.messageCryptoService.encryptForConversation(
        dto.refreshToken.trim(),
        shopId,
      ).ciphertext;
    }
    if (dto.webhookVerifySecret) {
      channel.webhookVerifySecretEncrypted = this.messageCryptoService.encryptForConversation(
        dto.webhookVerifySecret.trim(),
        shopId,
      ).ciphertext;
    }
    if (dto.metaDatasetId !== undefined) {
      channel.metaDatasetId = dto.metaDatasetId.trim() || null;
    }
    if (dto.capiAccessToken) {
      channel.capiAccessTokenEncrypted = this.messageCryptoService.encryptForConversation(
        dto.capiAccessToken.trim(),
        shopId,
      ).ciphertext;
    }
    if (dto.isActive !== undefined) {
      channel.isActive = dto.isActive;
    }

    const saved = await this.channelRepo.save(channel);

    await this.broadcastChannelEventToShop(
      shopId,
      SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED,
      {
        shopId,
        action: 'UPDATED',
        channelId: saved.id,
        channelType: saved.channelType,
        pageName: saved.pageName,
        pageShortCode: saved.pageShortCode,
        webhookStatus: saved.webhookStatus,
      },
    );

    return saved;
  }

  async removeChannelIntegration(
    shopId: string,
    channelId: string,
  ): Promise<{ id: string; deleted: boolean }> {
    const channel = await this.channelRepo.findOne({
      where: { id: channelId, shopId },
    });
    if (!channel) {
      throw new NotFoundException('CHANNEL_INTEGRATION_NOT_FOUND');
    }
    channel.isActive = false;
    await this.channelRepo.save(channel);
    await this.channelRepo.softRemove(channel);

    await this.broadcastChannelEventToShop(
      shopId,
      SOCKET_CONFIG.events.CHANNELS.INTEGRATION_REMOVED,
      {
        shopId,
        channelId,
        pageShortCode: channel.pageShortCode,
        pageName: channel.pageName,
      },
    );

    return { id: channelId, deleted: true };
  }

  async listShopChannels(
    shopId: string,
    memberCtx: EffectiveMemberContext,
  ): Promise<
    Array<
      ChannelIntegrationEntity & {
        unreadCount: number;
      }
    >
  > {
    const whereClause: Record<string, unknown> = { shopId };
    if (memberCtx.allowedChannelIds && memberCtx.allowedChannelIds.length > 0) {
      whereClause.id = In(memberCtx.allowedChannelIds);
    }

    const channels = await this.channelRepo.find({
      where: whereClause,
      order: { createdAt: 'ASC' },
    });

    const unreadCountsRaw = await this.conversationRepo
      .createQueryBuilder('c')
      .select('c.channel_integration_id', 'channelIntegrationId')
      .addSelect('COUNT(c.id)', 'cnt')
      .where('c.shop_id = :shopId', { shopId })
      .andWhere('c.support_status = :waitingStatus', {
        waitingStatus: ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
      })
      .groupBy('c.channel_integration_id')
      .getRawMany<{ channelIntegrationId: string; cnt: string }>();

    const countMap = new Map<string, number>();
    for (const row of unreadCountsRaw) {
      if (row.channelIntegrationId) {
        countMap.set(row.channelIntegrationId, Number(row.cnt || 0));
      }
    }

    return channels.map((ch) =>
      Object.assign(ch, {
        unreadCount: countMap.get(ch.id) || 0,
      }),
    );
  }

  async getMergedInboxConversations(
    shopId: string,
    memberCtx: EffectiveMemberContext,
    query: MergedInboxQueryDto,
  ): Promise<{
    items: Array<
      ConversationEntity & {
        pageShortCode?: string;
        pageName?: string;
        channelAvatarUrl?: string | null;
      }
    >;
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 30)));

    const qb = this.conversationRepo.createQueryBuilder('c');
    DataScopeQueryHelper.applyAgentDataScope(qb, 'c', memberCtx);

    const requestedChannelIds = Array.isArray(query.channelIds)
      ? query.channelIds
      : typeof query.channelIds === 'string' && query.channelIds.trim().length > 0
        ? query.channelIds
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        : [];

    if (requestedChannelIds.length > 0) {
      qb.andWhere('c.channel_integration_id IN (:...requestedChannelIds)', {
        requestedChannelIds,
      });
    }

    if (query.supportStatus) {
      qb.andWhere('c.support_status = :supportStatus', {
        supportStatus: query.supportStatus,
      });
    }

    if (query.search && query.search.trim().length > 0) {
      qb.andWhere('(c.name LIKE :kw OR c.external_thread_id LIKE :kw)', {
        kw: `%${query.search.trim()}%`,
      });
    }

    qb.orderBy('c.lastMessageAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rawItems, total] = await qb.getManyAndCount();

    const channelIds = Array.from(
      new Set(rawItems.map((c) => c.channelIntegrationId).filter(Boolean) as string[]),
    );
    const channels =
      channelIds.length > 0 ? await this.channelRepo.find({ where: { id: In(channelIds) } }) : [];
    const channelMap = new Map<string, ChannelIntegrationEntity>();
    for (const ch of channels) {
      channelMap.set(ch.id, ch);
    }

    const items = rawItems.map((conv) => {
      const decryptedLastMessage = conv.lastMessage
        ? this.messageCryptoService.decryptForConversation(conv.lastMessage, conv.id)
        : null;
      const ch = conv.channelIntegrationId ? channelMap.get(conv.channelIntegrationId) : undefined;
      return Object.assign(conv, {
        lastMessage: decryptedLastMessage || conv.lastMessage,
        pageShortCode: ch?.pageShortCode || conv.channelType,
        pageName: ch?.pageName || conv.channelType,
        channelAvatarUrl: ch?.avatarUrl || null,
      });
    });

    return { items, total, page, limit };
  }

  async getWebhookLogs(
    shopId: string,
    query: WebhookLogQueryDto,
  ): Promise<{
    items: ChannelWebhookLogEntity[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));

    const qb = this.webhookLogRepo
      .createQueryBuilder('log')
      .where('(log.shop_id = :shopId OR log.shop_id IS NULL)', { shopId });

    if (query.channelType) {
      qb.andWhere('log.channel_type = :channelType', {
        channelType: query.channelType,
      });
    }

    if (query.processingStatus) {
      qb.andWhere('log.processing_status = :processingStatus', {
        processingStatus: query.processingStatus,
      });
    }

    qb.orderBy('log.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, limit };
  }

  async notifyWebhookLogUpdated(
    shopId: string | null,
    log: Partial<ChannelWebhookLogEntity>,
  ): Promise<void> {
    if (!shopId) return;
    await this.broadcastChannelEventToShop(
      shopId,
      SOCKET_CONFIG.events.CHANNELS.WEBHOOK_LOG_UPDATED,
      {
        shopId,
        logId: log.id,
        channelType: log.channelType,
        eventType: log.eventType,
        processingStatus: log.processingStatus,
        replayedCount: log.replayedCount || 0,
      },
    );
  }

  /**
   * Chuẩn hóa toàn bộ cấu trúc Payload từ Facebook (feed, live_videos, group_feed, messaging),
   * Instagram (comments, live_comments, messages), Zalo OA, TikTok Shop, Shopee, Lazada và Livechat.
   */
  normalizeInboundWebhookEvent(
    channelType: ChannelTypeEnum,
    payload: Record<string, any>,
    fallbackLogId: string,
  ): NormalizedOmnichannelEvent {
    const firstEntry = Array.isArray(payload?.entry) ? payload.entry[0] : null;
    const firstChange = Array.isArray(firstEntry?.changes) ? firstEntry.changes[0] : null;
    const changeVal = firstChange?.value || null;
    const firstMessaging = Array.isArray(firstEntry?.messaging) ? firstEntry.messaging[0] : null;

    const externalPageId = String(
      payload?.pageId ||
        payload?.externalPageId ||
        payload?.recipientId ||
        payload?.oa_id ||
        payload?.shop_id ||
        firstEntry?.id ||
        firstMessaging?.recipient?.id ||
        '',
    ).trim();

    // 1. Trường hợp Bình luận từ Facebook Page Feed / Live Videos / Group Feed hoặc Instagram Comments
    if (
      changeVal &&
      (firstChange?.field === 'feed' ||
        firstChange?.field === 'live_videos' ||
        firstChange?.field === 'group_feed' ||
        firstChange?.field === 'comments' ||
        firstChange?.field === 'live_comments' ||
        changeVal.item === 'comment' ||
        changeVal.comment_id)
    ) {
      const isLive =
        firstChange?.field === 'live_videos' ||
        firstChange?.field === 'live_comments' ||
        Boolean(changeVal.live_video_id);
      const commentId = String(changeVal.comment_id || changeVal.id || `cmt_${fallbackLogId}`);
      const postId = String(
        changeVal.post_id || changeVal.media?.id || changeVal.live_video_id || 'post_default',
      );
      const commenterId = String(
        changeVal.from?.id || changeVal.sender_id || `commenter_${commentId.slice(-6)}`,
      );
      const commenterName = String(
        changeVal.from?.name ||
          changeVal.from?.username ||
          `Khách bình luận #${commenterId.slice(-4)}`,
      );
      const rawVerb = String(changeVal.verb || 'add').toLowerCase();
      const verb: 'add' | 'edited' | 'remove' =
        rawVerb === 'remove' || rawVerb === 'delete'
          ? 'remove'
          : rawVerb === 'edited' || rawVerb === 'edit'
            ? 'edited'
            : 'add';

      return {
        externalPageId,
        externalThreadId: `cmt_${postId}_${commenterId}`,
        externalMessageId: commentId,
        customerName: commenterName,
        messageText: String(
          changeVal.message || changeVal.text || '[Khách hàng gửi bình luận kèm hình ảnh/nhãn dán]',
        ),
        interactionType: isLive ? 'LIVESTREAM' : 'COMMENT',
        verb,
        sourcePostId: postId,
        sourceAdId: changeVal.ad_id ? String(changeVal.ad_id) : null,
        ctwaClickId: null,
        externalCommentId: commentId,
        parentCommentId: changeVal.parent_id ? String(changeVal.parent_id) : null,
        mediaAttachmentUrl: changeVal.photo || changeVal.video || null,
      };
    }

    // 2. Trường hợp Tin nhắn Facebook Messenger / Instagram Direct chuẩn Graph API (entry[].messaging[])
    if (firstMessaging) {
      const senderPsid = String(firstMessaging.sender?.id || `psid_${fallbackLogId.slice(0, 8)}`);
      const referral = firstMessaging.referral || firstMessaging.message?.referral || null;
      const msgId = String(firstMessaging.message?.mid || `mid_${fallbackLogId}`);
      const text = String(
        firstMessaging.message?.text ||
          firstMessaging.postback?.title ||
          '[Khách hàng gửi tệp đính kèm]',
      );
      const attachmentUrl =
        Array.isArray(firstMessaging.message?.attachments) &&
        firstMessaging.message.attachments[0]?.payload?.url
          ? String(firstMessaging.message.attachments[0].payload.url)
          : null;

      return {
        externalPageId,
        externalThreadId: `inbox_${senderPsid}`,
        externalMessageId: msgId,
        customerName: String(
          firstMessaging.sender?.name || `Khách ${channelType} #${senderPsid.slice(-4)}`,
        ),
        messageText: text,
        interactionType: 'INBOX',
        verb: 'add',
        sourcePostId: referral?.post_id ? String(referral.post_id) : null,
        sourceAdId: referral?.ad_id ? String(referral.ad_id) : null,
        ctwaClickId: referral?.ctwa_clid ? String(referral.ctwa_clid) : null,
        externalCommentId: null,
        parentCommentId: null,
        mediaAttachmentUrl: attachmentUrl,
      };
    }

    // 3. Trường hợp Zalo Official Account Webhook (user_send_text, user_send_image, follow...)
    if (channelType === ChannelTypeEnum.ZALO_OA && (payload?.event_name || payload?.sender)) {
      const zaloSenderId = String(
        payload.sender?.id || payload.user_id_by_app || `zalo_${fallbackLogId.slice(0, 8)}`,
      );
      const zaloMsgId = String(payload.message?.msg_id || `zalo_msg_${fallbackLogId}`);
      const zaloText = String(
        payload.message?.text ||
          (payload.event_name === 'follow'
            ? '[Khách hàng vừa nhấn Quan tâm Zalo OA]'
            : '[Tin nhắn hình ảnh/vị trí Zalo OA]'),
      );

      return {
        externalPageId,
        externalThreadId: `zalo_${zaloSenderId}`,
        externalMessageId: zaloMsgId,
        customerName: String(payload.sender?.name || `Khách Zalo #${zaloSenderId.slice(-4)}`),
        messageText: zaloText,
        interactionType: 'INBOX',
        verb: 'add',
        sourcePostId: null,
        sourceAdId: null,
        ctwaClickId: null,
        externalCommentId: null,
        parentCommentId: null,
        mediaAttachmentUrl:
          Array.isArray(payload.message?.attachments) &&
          payload.message.attachments[0]?.payload?.url
            ? String(payload.message.attachments[0].payload.url)
            : null,
      };
    }

    // 4. Trường hợp Payload phẳng hoặc giả lập từ công cụ Simulator (Hỗ trợ cả INBOX, COMMENT, LIVESTREAM)
    const isCommentEvent =
      payload?.interactionType === 'COMMENT' ||
      payload?.interactionType === 'LIVESTREAM' ||
      payload?.event === 'COMMENT_INBOUND' ||
      Boolean(payload?.commentId);

    const resolvedInteractionType: ConversationInteractionType =
      payload?.interactionType === 'LIVESTREAM' || payload?.event === 'LIVESTREAM_COMMENT'
        ? 'LIVESTREAM'
        : isCommentEvent
          ? 'COMMENT'
          : 'INBOX';

    const rawVerb = String(payload?.verb || 'add').toLowerCase();
    const verb: 'add' | 'edited' | 'remove' =
      rawVerb === 'remove' ? 'remove' : rawVerb === 'edited' ? 'edited' : 'add';

    const externalThreadId = String(
      payload?.threadId ||
        payload?.senderId ||
        payload?.conversation_id ||
        payload?.order_sn ||
        (isCommentEvent && payload?.postId
          ? `cmt_${String(payload.postId)}_${String(payload.senderId || 'guest')}`
          : `thread_${externalPageId || 'default'}`),
    );

    const externalCommentId = payload?.commentId ? String(payload.commentId) : null;

    return {
      externalPageId,
      externalThreadId,
      externalMessageId: String(payload?.messageId || externalCommentId || `wh_${fallbackLogId}`),
      customerName: String(
        payload?.senderName ||
          payload?.buyer_username ||
          `Khách ${channelType} #${externalThreadId.slice(-4)}`,
      ),
      messageText: String(
        payload?.messageText ||
          payload?.text ||
          (payload?.order_sn
            ? `[Đơn sàn ${channelType} #${String(payload.order_sn)}]`
            : 'Khách hàng vừa gửi tương tác mới'),
      ),
      interactionType: resolvedInteractionType,
      verb,
      sourcePostId: payload?.postId ? String(payload.postId) : null,
      sourceAdId: payload?.adId ? String(payload.adId) : null,
      ctwaClickId: payload?.ctwaClid ? String(payload.ctwaClid) : null,
      externalCommentId,
      parentCommentId: payload?.parentCommentId ? String(payload.parentCommentId) : null,
      mediaAttachmentUrl: payload?.mediaAttachmentUrl ? String(payload.mediaAttachmentUrl) : null,
    };
  }

  async resolveChannelByWebhookPayload(
    channelType: ChannelTypeEnum,
    payload: Record<string, unknown>,
  ): Promise<ChannelIntegrationEntity | null> {
    const normalized = this.normalizeInboundWebhookEvent(channelType, payload, 'lookup');
    if (!normalized.externalPageId) {
      return null;
    }

    return this.channelRepo.findOne({
      where: { channelType, externalPageId: normalized.externalPageId },
    });
  }

  async dispatchInboundWebhookPayload(params: {
    logId: string;
    channelType: ChannelTypeEnum;
    headers: Record<string, string>;
    payload: Record<string, unknown>;
  }): Promise<{
    shopId: string | null;
    channelIntegrationId: string | null;
    conversationId: string | null;
    assignedAgentId: string | null;
  }> {
    const { channelType, payload, headers } = params;

    const channel = await this.resolveChannelByWebhookPayload(channelType, payload);

    if (!channel) {
      return {
        shopId: null,
        channelIntegrationId: null,
        conversationId: null,
        assignedAgentId: null,
      };
    }

    // Kiểm tra chữ ký HMAC nếu kênh đã cấu hình webhookVerifySecretEncrypted
    this.verifyWebhookSignatureIfConfigured({
      channel,
      headers,
      rawPayload: payload,
    });

    // Kiểm tra bộ điều tốc Token-Bucket chống bão request
    const rateCheck = await this.consumeChannelRateLimitToken(channel.id, 120, 5);
    channel.lastWebhookReceivedAt = new Date();
    channel.webhookStatus = rateCheck.allowed
      ? WebhookIntegrationStatusEnum.HEALTHY
      : WebhookIntegrationStatusEnum.RATE_LIMITED;
    await this.channelRepo.save(channel);

    const isMarketplaceChannel =
      channelType === ChannelTypeEnum.SHOPEE ||
      channelType === ChannelTypeEnum.TIKTOK_SHOP ||
      channelType === ChannelTypeEnum.LAZADA;

    if (
      isMarketplaceChannel &&
      (payload.order_sn || payload.orderSn || payload.event === 'ORDER_CREATED')
    ) {
      const orderSn = String(payload.order_sn || payload.orderSn || `ORD-${Date.now()}`);
      const buyerUsername = String(
        payload.buyer_username || payload.senderName || `Khách ${channel.pageShortCode}`,
      );
      const totalAmount = Number(payload.total_amount || payload.totalAmount || 350000);
      const rawItems = Array.isArray(payload.items) ? payload.items : [];
      const items =
        rawItems.length > 0
          ? rawItems.map((it: any, idx: number) => ({
              externalItemId: String(it.externalItemId || it.item_id || `ITEM-${idx + 1}`),
              skuCode: String(it.skuCode || it.model_sku || `SKU-${idx + 1}`),
              itemName: String(it.itemName || it.item_name || 'Sản phẩm sàn TMĐT'),
              quantity: Number(it.quantity || 1),
              unitPrice: Number(it.unitPrice || totalAmount),
            }))
          : [
              {
                externalItemId: `ITEM-${orderSn.slice(-4)}`,
                skuCode: `SKU-${channel.pageShortCode}`,
                itemName: `Đơn hàng sàn ${channel.pageName}`,
                quantity: 1,
                unitPrice: totalAmount,
              },
            ];

      const syncResult = await this.marketplaceBridge.syncMarketplaceOrderAndConversation({
        shopId: channel.shopId,
        channel,
        orderSn,
        buyerUsername,
        orderStatus: String(payload.order_status || 'READY_TO_SHIP'),
        totalAmount,
        items,
        inquiryText: payload.messageText ? String(payload.messageText) : undefined,
      });

      await this.broadcastChannelEventToShop(
        channel.shopId,
        SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED,
        {
          shopId: channel.shopId,
          action: 'WEBHOOK_INBOUND',
          channelId: channel.id,
        },
      );

      return {
        shopId: channel.shopId,
        channelIntegrationId: channel.id,
        conversationId: syncResult.conversationId,
        assignedAgentId: syncResult.assignedAgentId,
      };
    }

    const normalized = this.normalizeInboundWebhookEvent(channelType, payload, params.logId);

    // Bảo toàn Bình luận khi bị xóa trên nền tảng (Immutable Comment Retention — Pancake CRM rule)
    if (normalized.verb === 'remove' && normalized.externalCommentId) {
      const existingMsg = await this.messageRepo.findOne({
        where: {
          shopId: channel.shopId,
          externalMessageId: normalized.externalCommentId,
        },
      });

      if (existingMsg) {
        const updatedMetadata = {
          ...(existingMsg.metadata || {}),
          isDeletedOnPlatform: true,
          deletedOnPlatformAt: new Date().toISOString(),
        };
        await this.messageRepo.update(
          { id: existingMsg.id, createdAt: existingMsg.createdAt },
          { metadata: updatedMetadata as any },
        );

        await this.broadcastChannelEventToShop(
          channel.shopId,
          SOCKET_CONFIG.events.CHAT.MESSAGE_EDITED,
          {
            id: existingMsg.id,
            conversationId: existingMsg.conversationId,
            metadata: updatedMetadata,
          },
        );

        return {
          shopId: channel.shopId,
          channelIntegrationId: channel.id,
          conversationId: existingMsg.conversationId,
          assignedAgentId: null,
        };
      }
    }

    const hasPhoneMatch = /(?:\+84|84|0)(?:3|5|7|8|9)\d{8}/.test(
      normalized.messageText.replace(/[\s.-]/g, ''),
    );

    let conversation = await this.conversationRepo.findOne({
      where: {
        shopId: channel.shopId,
        channelIntegrationId: channel.id,
        externalThreadId: normalized.externalThreadId,
      },
      withDeleted: true,
    });

    const now = new Date();

    if (!conversation) {
      conversation = this.conversationRepo.create({
        type: ConversationTypeEnum.DIRECT,
        shopId: channel.shopId,
        channelType: channel.channelType,
        channelIntegrationId: channel.id,
        externalThreadId: normalized.externalThreadId,
        interactionType: normalized.interactionType,
        name: normalized.customerName,
        lastMessage: normalized.messageText,
        lastMessageAt: now,
        lastCustomerMessageAt: now,
        supportStatus: ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
        firstSeenAt: null,
        firstSeenByAgentId: null,
        isGhostedByAgent: false,
        hasPhoneCollected: hasPhoneMatch,
        sourceAdId: normalized.sourceAdId,
        sourcePostId: normalized.sourcePostId,
        ctwaClickId: normalized.ctwaClickId,
        activeTagIdsJson: [],
      });
    } else {
      if (conversation.deletedAt) {
        await this.conversationRepo.restore(conversation.id);
      }
      conversation.deletedAt = null;
      conversation.deletedBy = null;
      conversation.interactionType = normalized.interactionType || conversation.interactionType;
      conversation.lastMessage = normalized.messageText;
      conversation.lastMessageAt = now;
      conversation.lastCustomerMessageAt = now;
      conversation.supportStatus = ConversationSupportStatusEnum.WAITING_AGENT_REPLY;
      conversation.firstSeenAt = null;
      conversation.firstSeenByAgentId = null;
      conversation.isGhostedByAgent = false;
      if (hasPhoneMatch) {
        conversation.hasPhoneCollected = true;
      }
      if (normalized.sourceAdId && !conversation.sourceAdId) {
        conversation.sourceAdId = normalized.sourceAdId;
      }
      if (normalized.sourcePostId) {
        conversation.sourcePostId = normalized.sourcePostId;
      }
      if (normalized.ctwaClickId && !conversation.ctwaClickId) {
        conversation.ctwaClickId = normalized.ctwaClickId;
      }
    }

    const savedConversation = await this.conversationRepo.save(conversation);

    const encryptedMsg = this.messageCryptoService.encryptForConversation(
      normalized.messageText,
      savedConversation.id,
    );

    await this.conversationRepo.update(savedConversation.id, {
      lastMessage: encryptedMsg.ciphertext,
      lastMessageType: MessageTypeEnum.TEXT,
      lastMessageAt: now,
    });

    const assignedAgentId = await this.routingEngine.routeInboundConversation({
      shopId: channel.shopId,
      conversation: savedConversation,
      channelIntegrationId: channel.id,
    });

    const [shop, activeMembers] = await Promise.all([
      this.shopRepo.findOne({ where: { id: channel.shopId } }),
      this.memberRepo.find({
        where: {
          shopId: channel.shopId,
          membershipStatus: MembershipStatusEnum.ACTIVE,
        },
        select: ['userId', 'role'],
      }),
    ]);

    const participantUserIds = activeMembers
      .filter(
        (m) =>
          m.role === ShopRoleEnum.SHOP_OWNER ||
          m.role === ShopRoleEnum.SHOP_MANAGER ||
          m.userId === assignedAgentId,
      )
      .map((m) => m.userId);
    if (shop?.ownerId) {
      participantUserIds.push(shop.ownerId);
    }
    if (assignedAgentId) {
      participantUserIds.push(assignedAgentId);
    }

    await this.ensureConversationParticipants(savedConversation.id, participantUserIds);

    const inboundSenderId = `ext:${channel.channelType.toLowerCase()}:${normalized.externalThreadId.slice(0, 18)}`;
    const inboundMessage = this.messageRepo.create({
      conversationId: savedConversation.id,
      senderId: inboundSenderId,
      shopId: channel.shopId,
      direction: MessageDirectionEnum.INBOUND,
      externalMessageId: normalized.externalMessageId,
      content: encryptedMsg.ciphertext,
      type: MessageTypeEnum.TEXT,
      status: MessageStatusEnum.SENT,
      readBy: [],
      deliveredTo: participantUserIds,
      isPinned: false,
      metadata: {
        isEncrypted: encryptedMsg.isEncrypted,
        encryptionAlg: encryptedMsg.algorithm,
        channelType: channel.channelType,
        pageShortCode: channel.pageShortCode,
        pageName: channel.pageName,
        externalCustomerName: normalized.customerName,
        interactionType: normalized.interactionType,
        externalCommentId: normalized.externalCommentId,
        parentCommentId: normalized.parentCommentId,
        sourcePostId: normalized.sourcePostId,
        sourceAdId: normalized.sourceAdId,
        ctwaClickId: normalized.ctwaClickId,
        mediaAttachmentUrl: normalized.mediaAttachmentUrl,
        isDeletedOnPlatform: false,
      } as any,
      createdAt: now,
      updatedAt: now,
    });
    const savedMsg = await this.messageRepo.save(inboundMessage);

    this.eventEmitter.emit('chat.message.inbound', {
      shopId: channel.shopId,
      conversationId: savedConversation.id,
      messageContent: normalized.messageText,
      interactionType: normalized.interactionType,
      externalCommentId: normalized.externalCommentId,
      sourcePostId: normalized.sourcePostId,
    });
    if (hasPhoneMatch) {
      this.eventEmitter.emit('ner.phone.extracted', {
        shopId: channel.shopId,
        conversationId: savedConversation.id,
        messageContent: normalized.messageText,
      });
    }

    for (const uid of new Set(participantUserIds)) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        uid,
        SOCKET_CONFIG.events.CHAT.NEW_MESSAGE,
        {
          ...savedMsg,
          content: normalized.messageText,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          sender: {
            id: inboundSenderId,
            name: normalized.customerName,
            avatar: channel.avatarUrl || null,
          },
        },
      );
    }

    await this.broadcastChannelEventToShop(
      channel.shopId,
      SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED,
      {
        shopId: channel.shopId,
        action: 'WEBHOOK_INBOUND',
        channelId: channel.id,
      },
    );

    return {
      shopId: channel.shopId,
      channelIntegrationId: channel.id,
      conversationId: savedConversation.id,
      assignedAgentId,
    };
  }
}
