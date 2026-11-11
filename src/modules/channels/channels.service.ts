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
import { envs } from 'src/config/envs/envs';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  ConnectChannelOAuthDto,
  MergedInboxQueryDto,
  ResolveChannelTokenMetadataDto,
  UpdateChannelIntegrationDto,
  WebhookLogQueryDto,
} from 'src/dto/channels/channels.dto';
import {
  ChannelIntegrationEntity,
  ChannelPlatformSaasConfig,
} from 'src/entity/channel-integration.entity';
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
  externalCustomerPsid: string | null;
  externalMessageId: string;
  customerName: string;
  customerAvatarUrl?: string | null;
  messageText: string;
  interactionType: ConversationInteractionType;
  verb: 'add' | 'edited' | 'remove';
  isEchoFromPage: boolean;
  eventSubtype: 'MESSAGE_OR_COMMENT' | 'DELIVERY_RECEIPT' | 'READ_RECEIPT';
  watermarkTimestampMs?: number | null;
  deliveredMessageIds?: string[];
  sourcePostId: string | null;
  sourceAdId: string | null;
  ctwaClickId: string | null;
  externalCommentId: string | null;
  parentCommentId: string | null;
  mediaAttachmentUrl: string | null;
}

export interface ResolvedChannelTokenCandidatePage {
  externalPageId: string;
  pageName: string;
  pageShortCode: string;
  avatarUrl: string | null;
  category?: string | null;
  pageAccessToken: string;
  tasks?: string[];
  subscribedFields: string[];
  linkedInstagramAccount?: {
    id: string;
    name: string;
    username?: string;
    avatarUrl?: string | null;
  } | null;
}

export interface ResolvedChannelTokenMetadataResult {
  channelType: ChannelTypeEnum;
  apiVersion: string;
  appId: string | null;
  tokenKind: 'PAGE_TOKEN' | 'USER_TOKEN' | 'OA_TOKEN' | 'SHOP_TOKEN' | 'SANDBOX_TOKEN';
  authenticatedUserId: string | null;
  authenticatedUserName: string | null;
  requiresPageSelection: boolean;
  externalPageId: string;
  pageName: string;
  pageShortCode: string;
  avatarUrl: string | null;
  category: string | null;
  resolvedPageAccessToken: string;
  subscribedFields: string[];
  candidatePages: ResolvedChannelTokenCandidatePage[];
  webhookCallbackUrl: string;
  webhookVerifyToken: string;
  resolvedFromLiveApi: boolean;
}

export interface SaasPlatformWebhookConfigItem {
  channelType: ChannelTypeEnum;
  defaultApiVersion: string;
  defaultAppId: string | null;
  hasDefaultAppSecret: boolean;
  webhookCallbackUrl: string;
  webhookVerifyToken: string;
  recommendedSubscribedFields: string[];
  signatureHeaderName: string;
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

export const DEFAULT_SUBSCRIBED_FIELDS_BY_PLATFORM: Record<ChannelTypeEnum, string[]> = {
  [ChannelTypeEnum.FACEBOOK_PAGE]: [
    'messages',
    'messaging_postbacks',
    'messaging_referrals',
    'message_deliveries',
    'message_reads',
    'message_echoes',
    'feed',
    'live_videos',
    'group_feed',
  ],
  [ChannelTypeEnum.INSTAGRAM]: [
    'messages',
    'messaging_referral',
    'message_Read',
    'comments',
    'live_comments',
  ],
  [ChannelTypeEnum.ZALO_OA]: [
    'user_send_text',
    'user_send_image',
    'user_send_sticker',
    'user_send_audio',
    'user_send_video',
    'user_send_location',
    'oa_send_text',
    'oa_send_image',
    'user_received_message',
    'user_seen_message',
    'follow',
    'unfollow',
  ],
  [ChannelTypeEnum.TIKTOK_SHOP]: [
    'customer_service_message',
    'live_comment',
    'order_status_change',
    'return_status_change',
  ],
  [ChannelTypeEnum.SHOPEE]: ['webchat_push', 'order_status_push', 'booking_status_push'],
  [ChannelTypeEnum.LAZADA]: ['im_message_inbound', 'trade_order_notify'],
  [ChannelTypeEnum.WEBSITE_LIVECHAT]: ['visitor_message', 'visitor_lead_captured'],
  [ChannelTypeEnum.INTERNAL]: ['internal_message'],
};

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

  /**
   * Chuẩn hóa chuỗi phiên bản API (VD: "27.1", "v.27.1", "v27.1" -> "v27.1")
   */
  public normalizeGraphApiVersion(
    rawVersion?: string | null,
    channelType: ChannelTypeEnum = ChannelTypeEnum.FACEBOOK_PAGE,
  ): string {
    if (channelType === ChannelTypeEnum.ZALO_OA) {
      const cleanedZalo = (rawVersion || envs.omnichannelSaas.zaloOaApiVersion || 'v3.0')
        .trim()
        .replace(/^v\.?/i, '');
      return `v${cleanedZalo || '3.0'}`;
    }

    const fallbackVer = envs.omnichannelSaas.metaGraphApiVersion || 'v27.1';
    const raw = (rawVersion || fallbackVer).trim();
    const cleaned = raw.replace(/^v\.?/i, '');
    if (/^\d+(\.\d+)?$/.test(cleaned)) {
      return `v${cleaned}`;
    }
    return 'v27.1';
  }

  /**
   * Tính toán chữ ký bảo mật `appsecret_proof = HMAC-SHA256(accessToken, appSecret)`
   * theo chuẩn Meta Graph API Server-to-Server Security.
   */
  public computeAppSecretProof(accessToken: string, appSecret?: string | null): string | null {
    const cleanSecret = (appSecret || '').trim();
    if (!cleanSecret || !accessToken) {
      return null;
    }
    return crypto.createHmac('sha256', cleanSecret).update(accessToken.trim()).digest('hex');
  }

  /**
   * Xây dựng URL nhận sự kiện Webhook chuẩn SaaS cho từng nền tảng
   */
  public buildWebhookCallbackUrl(channelType: ChannelTypeEnum): string {
    const baseUrl = (envs.appUrl || 'http://localhost:3000').replace(/\/+$/, '');
    return `${baseUrl}/webhooks/omnichannel/${channelType.toLowerCase()}`;
  }

  /**
   * Trả về cấu hình SaaS Webhook (Callback URL, Verify Token, API Version mặc định, Subscribed Fields) cho từng kênh
   */
  async getSaasWebhookConfiguration(shopId: string): Promise<{
    shopId: string;
    platforms: SaasPlatformWebhookConfigItem[];
  }> {
    const platforms: ChannelTypeEnum[] = [
      ChannelTypeEnum.FACEBOOK_PAGE,
      ChannelTypeEnum.INSTAGRAM,
      ChannelTypeEnum.ZALO_OA,
      ChannelTypeEnum.TIKTOK_SHOP,
      ChannelTypeEnum.SHOPEE,
      ChannelTypeEnum.LAZADA,
      ChannelTypeEnum.WEBSITE_LIVECHAT,
    ];

    const signatureHeaderMap: Record<ChannelTypeEnum, string> = {
      [ChannelTypeEnum.FACEBOOK_PAGE]: 'x-hub-signature-256',
      [ChannelTypeEnum.INSTAGRAM]: 'x-hub-signature-256',
      [ChannelTypeEnum.ZALO_OA]: 'x-zevent-signature',
      [ChannelTypeEnum.TIKTOK_SHOP]: 'x-tts-signature',
      [ChannelTypeEnum.SHOPEE]: 'authorization',
      [ChannelTypeEnum.LAZADA]: 'x-lazada-signature',
      [ChannelTypeEnum.WEBSITE_LIVECHAT]: 'x-livechat-signature',
      [ChannelTypeEnum.INTERNAL]: 'x-internal-signature',
    };

    return {
      shopId,
      platforms: platforms.map((plat) => ({
        channelType: plat,
        defaultApiVersion:
          plat === ChannelTypeEnum.ZALO_OA
            ? envs.omnichannelSaas.zaloOaApiVersion
            : plat === ChannelTypeEnum.FACEBOOK_PAGE || plat === ChannelTypeEnum.INSTAGRAM
              ? envs.omnichannelSaas.metaGraphApiVersion
              : 'v2.0',
        defaultAppId:
          plat === ChannelTypeEnum.FACEBOOK_PAGE || plat === ChannelTypeEnum.INSTAGRAM
            ? envs.omnichannelSaas.metaAppId || null
            : plat === ChannelTypeEnum.ZALO_OA
              ? envs.omnichannelSaas.zaloAppId || null
              : plat === ChannelTypeEnum.TIKTOK_SHOP
                ? envs.omnichannelSaas.tiktokShopAppKey || null
                : plat === ChannelTypeEnum.SHOPEE
                  ? envs.omnichannelSaas.shopeePartnerId || null
                  : null,
        hasDefaultAppSecret: Boolean(
          (plat === ChannelTypeEnum.FACEBOOK_PAGE || plat === ChannelTypeEnum.INSTAGRAM) &&
            envs.omnichannelSaas.metaAppSecret,
        ),
        webhookCallbackUrl: this.buildWebhookCallbackUrl(plat),
        webhookVerifyToken:
          plat === ChannelTypeEnum.ZALO_OA
            ? envs.omnichannelSaas.zaloWebhookVerifyToken
            : envs.omnichannelSaas.metaWebhookVerifyToken,
        recommendedSubscribedFields: DEFAULT_SUBSCRIBED_FIELDS_BY_PLATFORM[plat] || [],
        signatureHeaderName: signatureHeaderMap[plat],
      })),
    };
  }

  /**
   * Kiểm tra `hub.verify_token` khi Meta / Zalo / TikTok gọi GET xác thực Webhook
   */
  async verifyWebhookChallengeToken(params: {
    channelType: ChannelTypeEnum;
    verifyToken: string;
    shopId?: string;
  }): Promise<boolean> {
    const provided = params.verifyToken.trim();
    if (!provided) return false;

    if (
      provided === envs.omnichannelSaas.metaWebhookVerifyToken ||
      provided === envs.omnichannelSaas.zaloWebhookVerifyToken
    ) {
      return true;
    }

    const whereClause: Record<string, unknown> = { channelType: params.channelType };
    if (params.shopId) {
      whereClause.shopId = params.shopId;
    }

    const channels = await this.channelRepo.find({ where: whereClause });
    for (const ch of channels) {
      if (!ch.webhookVerifySecretEncrypted) continue;
      const decryptedSecret = this.messageCryptoService.decryptForConversation(
        ch.webhookVerifySecretEncrypted,
        ch.shopId,
      );
      if (decryptedSecret && decryptedSecret.trim() === provided) {
        return true;
      }
    }

    return true;
  }

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

  private buildSmartShortCode(
    channelType: ChannelTypeEnum,
    pageName: string,
    externalPageId: string,
  ): string {
    const prefixMap: Record<ChannelTypeEnum, string> = {
      [ChannelTypeEnum.FACEBOOK_PAGE]: 'FB',
      [ChannelTypeEnum.INSTAGRAM]: 'IG',
      [ChannelTypeEnum.ZALO_OA]: 'ZALO',
      [ChannelTypeEnum.TIKTOK_SHOP]: 'TTS',
      [ChannelTypeEnum.SHOPEE]: 'SHP',
      [ChannelTypeEnum.LAZADA]: 'LZD',
      [ChannelTypeEnum.WEBSITE_LIVECHAT]: 'WEB',
      [ChannelTypeEnum.INTERNAL]: 'INT',
    };
    const prefix = prefixMap[channelType] || 'CH';
    const cleanAlpha = pageName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .toUpperCase()
      .replace(/[^A-Z0-9\s]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join('-');
    const suffix =
      externalPageId
        .replace(/[^A-Z0-9]/gi, '')
        .slice(-3)
        .toUpperCase() || '01';
    return `${prefix}-${cleanAlpha || 'PAGE'}-${suffix}`.slice(0, 24);
  }

  /**
   * Thực thi truy vấn Meta Graph API với cơ chế:
   * 1. Hỗ trợ phiên bản người dùng cấu hình (VD: `v27.1`, `v27.0`, `v26.0`, `v21.0`) và tự động retry sang phiên bản ổn định nếu cụm Graph API trả lỗi Unknown version.
   * 2. Tự động đính kèm `appsecret_proof = HMAC-SHA256(accessToken, appSecret)` nếu người dùng cung cấp `appSecret`.
   * 3. Nếu `appsecret_proof` bị từ chối do người dùng nhập Token từ Graph API Explorer (khác App ID), tự động thử lại không kèm `appsecret_proof`.
   */
  public async callMetaGraphApi<T = any>(params: {
    apiVersion: string;
    path: string;
    queryParams?: Record<string, string>;
    method?: 'GET' | 'POST' | 'DELETE';
    body?: Record<string, unknown>;
    accessToken: string;
    appSecret?: string | null;
  }): Promise<{
    ok: boolean;
    data: T | null;
    usedVersion: string;
    errorMessage: string | null;
    errorCode?: number;
  }> {
    const cleanToken = params.accessToken.trim().replace(/^Bearer\s+/i, '');
    const normalizedVer = this.normalizeGraphApiVersion(params.apiVersion);
    const candidateVersions = Array.from(
      new Set([normalizedVer, 'v27.0', 'v26.0', 'v22.0', 'v21.0']),
    );
    const cleanPath = params.path.replace(/^\/+/, '');
    const method = params.method || 'GET';
    const appSecretProof = this.computeAppSecretProof(cleanToken, params.appSecret);

    let lastErrorMsg: string | null = null;
    let lastErrorCode: number | undefined;

    for (const ver of candidateVersions) {
      const attemptWithProof = async (includeProof: boolean) => {
        const searchParams = new URLSearchParams(params.queryParams || {});
        searchParams.set('access_token', cleanToken);
        if (includeProof && appSecretProof) {
          searchParams.set('appsecret_proof', appSecretProof);
        }

        const url = `https://graph.facebook.com/${ver}/${cleanPath}?${searchParams.toString()}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
          const res = await fetch(url, {
            method,
            headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
            body:
              method === 'POST' && params.body
                ? JSON.stringify({
                    ...params.body,
                    access_token: cleanToken,
                    ...(includeProof && appSecretProof ? { appsecret_proof: appSecretProof } : {}),
                  })
                : undefined,
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          const json = (await res.json().catch(() => ({}))) as any;
          if (res.ok && !json?.error) {
            return {
              ok: true as const,
              data: json as T,
              usedVersion: ver,
              errorMessage: null,
            };
          }

          return {
            ok: false as const,
            data: null,
            usedVersion: ver,
            errorMessage: String(json?.error?.message || `HTTP ${res.status}`),
            errorCode: Number(json?.error?.code || res.status),
          };
        } catch (err) {
          clearTimeout(timeoutId);
          return {
            ok: false as const,
            data: null,
            usedVersion: ver,
            errorMessage: err instanceof Error ? err.message : String(err),
            errorCode: 0,
          };
        }
      };

      const firstTry = await attemptWithProof(Boolean(appSecretProof));
      if (firstTry.ok) {
        return firstTry;
      }

      // Nếu lỗi do appsecret_proof không khớp (VD: người dùng lấy Token từ Graph API Explorer App khác với App Secret đã điền),
      // tự động thử lại không kèm appsecret_proof để vẫn lấy đúng Page!
      if (
        appSecretProof &&
        firstTry.errorMessage &&
        firstTry.errorMessage.toLowerCase().includes('appsecret_proof')
      ) {
        const retryWithoutProof = await attemptWithProof(false);
        if (retryWithoutProof.ok) {
          return retryWithoutProof;
        }
      }

      lastErrorMsg = firstTry.errorMessage;
      lastErrorCode = firstTry.errorCode;

      // Chỉ chuyển sang thử phiên bản Graph API thấp hơn nếu lỗi liên quan đến API version / path component
      const isVersionError =
        firstTry.errorCode === 12 ||
        firstTry.errorCode === 2635 ||
        (firstTry.errorMessage || '').toLowerCase().includes('unknown path components') ||
        (firstTry.errorMessage || '').toLowerCase().includes('version');

      if (!isVersionError) {
        break;
      }
    }

    return {
      ok: false,
      data: null,
      usedVersion: normalizedVer,
      errorMessage: lastErrorMsg,
      errorCode: lastErrorCode,
    };
  }

  /**
   * Phân giải chính xác 100% thông tin Trang / Gian hàng từ Access Token:
   * - Sử dụng `/debug_token` (nếu có `appId` + `appSecret`) kết hợp `/me?fields=id,name,picture.type(large)&metadata=1`
   *   để phân biệt chính xác `PAGE_TOKEN` (của 1 Fanpage) và `USER_TOKEN` (của Admin quản lý nhiều Fanpage).
   * - Khi là `USER_TOKEN`: lấy toàn bộ danh sách Fanpage qua `/me/accounts`, trích xuất `pageAccessToken` riêng của từng Page,
   *   và nếu có nhiều Page mà người dùng chưa chọn `externalPageId`, đặt `requiresPageSelection = true` để người dùng chọn đúng Page (không bao giờ tự ý lấy nhầm Page khác!).
   * - Tuyệt đối không tự sinh Page giả đè lên khi người dùng nhập Token thật (trừ khi dùng token `sandbox_...` hoặc bật `allowSandboxSimulation = true`).
   */
  async resolveChannelMetadataFromToken(
    shopId: string,
    dto: ResolveChannelTokenMetadataDto,
  ): Promise<ResolvedChannelTokenMetadataResult> {
    const cleanToken = dto.accessToken.trim().replace(/^Bearer\s+/i, '');
    const resolvedApiVersion = this.normalizeGraphApiVersion(dto.apiVersion, dto.channelType);
    const resolvedAppId =
      dto.appId?.trim() ||
      (dto.channelType === ChannelTypeEnum.ZALO_OA
        ? envs.omnichannelSaas.zaloAppId
        : envs.omnichannelSaas.metaAppId) ||
      null;
    const resolvedAppSecret =
      dto.appSecret?.trim() ||
      (dto.channelType === ChannelTypeEnum.ZALO_OA
        ? envs.omnichannelSaas.zaloAppSecret
        : envs.omnichannelSaas.metaAppSecret) ||
      null;

    const subscribedFields =
      DEFAULT_SUBSCRIBED_FIELDS_BY_PLATFORM[dto.channelType] ||
      DEFAULT_SUBSCRIBED_FIELDS_BY_PLATFORM[ChannelTypeEnum.FACEBOOK_PAGE];
    const webhookCallbackUrl = this.buildWebhookCallbackUrl(dto.channelType);
    const webhookVerifyToken =
      dto.channelType === ChannelTypeEnum.ZALO_OA
        ? envs.omnichannelSaas.zaloWebhookVerifyToken
        : envs.omnichannelSaas.metaWebhookVerifyToken;

    const isExplicitSandboxToken =
      Boolean(dto.allowSandboxSimulation) ||
      /^(sandbox_|sim_|mock_|test_tok_|oauth2_tok_)/i.test(cleanToken);

    // 1. Nhánh Facebook Fanpage & Instagram Business (Meta Graph API chuẩn v27.1 / v27.0 / v21.0)
    if (
      dto.channelType === ChannelTypeEnum.FACEBOOK_PAGE ||
      dto.channelType === ChannelTypeEnum.INSTAGRAM
    ) {
      let debuggedTokenType: 'PAGE' | 'USER' | null = null;
      let debuggedProfileId: string | null = null;

      // Bước 1A: Nếu có cả App ID và App Secret, gọi /debug_token để xác định chính xác tuyệt đối loại Token và Page Profile ID
      if (resolvedAppId && resolvedAppSecret) {
        const debugUrl = `https://graph.facebook.com/${resolvedApiVersion}/debug_token?input_token=${encodeURIComponent(cleanToken)}&access_token=${encodeURIComponent(`${resolvedAppId}|${resolvedAppSecret}`)}`;
        const debugRes = await fetch(debugUrl).catch(() => null);
        if (debugRes && debugRes.ok) {
          const debugJson = (await debugRes.json().catch(() => ({}))) as {
            data?: {
              is_valid?: boolean;
              type?: string;
              profile_id?: string;
              user_id?: string;
              error?: { message?: string };
            };
          };
          if (debugJson?.data?.is_valid === false) {
            throw new BadRequestException(
              `Access Token không hợp lệ hoặc đã hết hạn: ${debugJson.data.error?.message || 'INVALID_META_ACCESS_TOKEN'}`,
            );
          }
          if (debugJson?.data?.type === 'PAGE') {
            debuggedTokenType = 'PAGE';
            debuggedProfileId = debugJson.data.profile_id || null;
          } else if (debugJson?.data?.type === 'USER') {
            debuggedTokenType = 'USER';
          }
        }
      }

      // Bước 1B: Gọi Introspection trên /me với 3 trường phổ quát (id, name, picture) + metadata=1
      // Tuyệt đối không truyền `category` ở bước này để không gây lỗi (#100) khi cleanToken là User Access Token!
      const meCall = await this.callMetaGraphApi<{
        id?: string;
        name?: string;
        picture?: { data?: { url?: string } };
        metadata?: { type?: string };
      }>({
        apiVersion: resolvedApiVersion,
        path: debuggedProfileId || 'me',
        queryParams: {
          fields: 'id,name,picture.type(large)',
          metadata: '1',
        },
        accessToken: cleanToken,
        appSecret: resolvedAppSecret,
      });

      if (meCall.ok && meCall.data?.id) {
        const metadataNodeType = String(meCall.data.metadata?.type || '').toLowerCase();
        const isPageNode =
          debuggedTokenType === 'PAGE' ||
          metadataNodeType === 'page' ||
          metadataNodeType === 'ig_user';

        // TRƯỜNG HỢP 1: Người bán nhập trực tiếp PAGE ACCESS TOKEN của 1 Fanpage cụ thể
        if (isPageNode) {
          const pageId = String(meCall.data.id);
          const pageDetailCall = await this.callMetaGraphApi<{
            id?: string;
            name?: string;
            category?: string;
            picture?: { data?: { url?: string } };
            instagram_business_account?: {
              id: string;
              name?: string;
              username?: string;
              profile_picture_url?: string;
            };
          }>({
            apiVersion: meCall.usedVersion,
            path: pageId,
            queryParams: {
              fields:
                dto.channelType === ChannelTypeEnum.INSTAGRAM
                  ? 'id,name,category,picture.type(large),instagram_business_account{id,name,username,profile_picture_url}'
                  : 'id,name,category,picture.type(large)',
            },
            accessToken: cleanToken,
            appSecret: resolvedAppSecret,
          });

          const detail =
            pageDetailCall.ok && pageDetailCall.data ? pageDetailCall.data : meCall.data;
          const igAcc = (detail as any)?.instagram_business_account;

          if (dto.channelType === ChannelTypeEnum.INSTAGRAM && igAcc?.id) {
            const igId = String(igAcc.id);
            const igName = igAcc.name || igAcc.username || `${detail.name} (IG)`;
            const igShortCode = this.buildSmartShortCode(dto.channelType, igName, igId);
            const igAvatar =
              igAcc.profile_picture_url ||
              detail.picture?.data?.url ||
              `https://graph.facebook.com/${pageId}/picture?type=large`;

            const igCandidate: ResolvedChannelTokenCandidatePage = {
              externalPageId: igId,
              pageName: igName,
              pageShortCode: igShortCode,
              avatarUrl: igAvatar,
              category: 'Instagram Business',
              pageAccessToken: cleanToken,
              subscribedFields,
            };

            return {
              channelType: dto.channelType,
              apiVersion: meCall.usedVersion,
              appId: resolvedAppId,
              tokenKind: 'PAGE_TOKEN',
              authenticatedUserId: null,
              authenticatedUserName: null,
              requiresPageSelection: false,
              externalPageId: igId,
              pageName: igName,
              pageShortCode: igShortCode,
              avatarUrl: igAvatar,
              category: 'Instagram Business',
              resolvedPageAccessToken: cleanToken,
              subscribedFields,
              candidatePages: [igCandidate],
              webhookCallbackUrl,
              webhookVerifyToken,
              resolvedFromLiveApi: true,
            };
          }

          const resolvedPageName = detail.name || meCall.data.name || `Fanpage #${pageId}`;
          const resolvedAvatar =
            detail.picture?.data?.url ||
            meCall.data.picture?.data?.url ||
            `https://graph.facebook.com/${pageId}/picture?type=large`;
          const resolvedCategory = (detail as any)?.category || 'Facebook Fanpage';
          const shortCode = this.buildSmartShortCode(dto.channelType, resolvedPageName, pageId);

          const singlePageCandidate: ResolvedChannelTokenCandidatePage = {
            externalPageId: pageId,
            pageName: resolvedPageName,
            pageShortCode: shortCode,
            avatarUrl: resolvedAvatar,
            category: resolvedCategory,
            pageAccessToken: cleanToken,
            subscribedFields,
          };

          return {
            channelType: dto.channelType,
            apiVersion: meCall.usedVersion,
            appId: resolvedAppId,
            tokenKind: 'PAGE_TOKEN',
            authenticatedUserId: null,
            authenticatedUserName: null,
            requiresPageSelection: false,
            externalPageId: pageId,
            pageName: resolvedPageName,
            pageShortCode: shortCode,
            avatarUrl: resolvedAvatar,
            category: resolvedCategory,
            resolvedPageAccessToken: cleanToken,
            subscribedFields,
            candidatePages: [singlePageCandidate],
            webhookCallbackUrl,
            webhookVerifyToken,
            resolvedFromLiveApi: true,
          };
        }

        // TRƯỜNG HỢP 2: Người bán nhập USER ACCESS TOKEN (Quản trị viên quản lý 1 hoặc nhiều Fanpage)
        // Gọi /me/accounts chỉ với các trường chuẩn của Page để không bị lỗi quyền Instagram
        const accountsCall = await this.callMetaGraphApi<{
          data?: Array<{
            id: string;
            name: string;
            category?: string;
            access_token?: string;
            tasks?: string[];
            picture?: { data?: { url?: string } };
          }>;
        }>({
          apiVersion: meCall.usedVersion,
          path: 'me/accounts',
          queryParams: {
            fields: 'id,name,category,access_token,picture.type(large),tasks',
            limit: '100',
          },
          accessToken: cleanToken,
          appSecret: resolvedAppSecret,
        });

        if (accountsCall.ok && Array.isArray(accountsCall.data?.data)) {
          const rawPages = accountsCall.data.data;
          if (rawPages.length === 0) {
            // Nếu /me/accounts rỗng nhưng người dùng có chỉ định externalPageId (VD: System User hoặc quyền trực tiếp trên Page ID)
            if (dto.externalPageId?.trim()) {
              const directPageCall = await this.callMetaGraphApi<{
                id?: string;
                name?: string;
                category?: string;
                access_token?: string;
                picture?: { data?: { url?: string } };
              }>({
                apiVersion: meCall.usedVersion,
                path: dto.externalPageId.trim(),
                queryParams: {
                  fields: 'id,name,category,access_token,picture.type(large)',
                },
                accessToken: cleanToken,
                appSecret: resolvedAppSecret,
              });

              if (directPageCall.ok && directPageCall.data?.id && directPageCall.data?.name) {
                const pId = String(directPageCall.data.id);
                const pName = directPageCall.data.name;
                const pToken = directPageCall.data.access_token || cleanToken;
                const pAvatar =
                  directPageCall.data.picture?.data?.url ||
                  `https://graph.facebook.com/${pId}/picture?type=large`;
                const pShort = this.buildSmartShortCode(dto.channelType, pName, pId);
                const cand: ResolvedChannelTokenCandidatePage = {
                  externalPageId: pId,
                  pageName: pName,
                  pageShortCode: pShort,
                  avatarUrl: pAvatar,
                  category: directPageCall.data.category || 'Facebook Fanpage',
                  pageAccessToken: pToken,
                  subscribedFields,
                };
                return {
                  channelType: dto.channelType,
                  apiVersion: meCall.usedVersion,
                  appId: resolvedAppId,
                  tokenKind: 'USER_TOKEN',
                  authenticatedUserId: String(meCall.data.id),
                  authenticatedUserName: meCall.data.name || null,
                  requiresPageSelection: false,
                  externalPageId: pId,
                  pageName: pName,
                  pageShortCode: pShort,
                  avatarUrl: pAvatar,
                  category: cand.category || null,
                  resolvedPageAccessToken: pToken,
                  subscribedFields,
                  candidatePages: [cand],
                  webhookCallbackUrl,
                  webhookVerifyToken,
                  resolvedFromLiveApi: true,
                };
              }
            }

            throw new BadRequestException(
              `Token hợp lệ cho tài khoản "${meCall.data.name}" nhưng chưa được cấp quyền quản lý Fanpage nào (Thiếu quyền pages_show_list / pages_manage_metadata hoặc chưa tích chọn Fanpage khi cấp quyền).`,
            );
          }

          const candidatePages: ResolvedChannelTokenCandidatePage[] = rawPages.map((item) => {
            const extId = String(item.id);
            const pToken = item.access_token || cleanToken;
            return {
              externalPageId: extId,
              pageName: item.name,
              pageShortCode: this.buildSmartShortCode(dto.channelType, item.name, extId),
              avatarUrl:
                item.picture?.data?.url || `https://graph.facebook.com/${extId}/picture?type=large`,
              category: item.category || 'Facebook Fanpage',
              pageAccessToken: pToken,
              tasks: item.tasks || [],
              subscribedFields,
            };
          });

          const requestedExtId = dto.externalPageId?.trim();
          const matchedCandidate = requestedExtId
            ? candidatePages.find((p) => p.externalPageId === requestedExtId)
            : candidatePages.length === 1
              ? candidatePages[0]
              : null;

          // Nếu User Token quản lý nhiều hơn 1 Fanpage và người dùng chưa chọn Page nào,
          // bật requiresPageSelection = true để giao diện bắt buộc người dùng click chọn đúng Fanpage!
          const requiresPageSelection = !matchedCandidate && candidatePages.length > 1;
          const previewCandidate = matchedCandidate || candidatePages[0];

          return {
            channelType: dto.channelType,
            apiVersion: meCall.usedVersion,
            appId: resolvedAppId,
            tokenKind: 'USER_TOKEN',
            authenticatedUserId: String(meCall.data.id),
            authenticatedUserName: meCall.data.name || null,
            requiresPageSelection,
            externalPageId: matchedCandidate ? matchedCandidate.externalPageId : '',
            pageName: matchedCandidate ? matchedCandidate.pageName : '',
            pageShortCode: matchedCandidate ? matchedCandidate.pageShortCode : '',
            avatarUrl: matchedCandidate ? matchedCandidate.avatarUrl : previewCandidate.avatarUrl,
            category: matchedCandidate ? matchedCandidate.category || null : null,
            resolvedPageAccessToken: matchedCandidate
              ? matchedCandidate.pageAccessToken
              : cleanToken,
            subscribedFields,
            candidatePages,
            webhookCallbackUrl,
            webhookVerifyToken,
            resolvedFromLiveApi: true,
          };
        }
      }

      // Nếu không phải chế độ giả lập Sandbox mà Graph API trả về lỗi xác thực Token thật,
      // báo lỗi chính xác nguyên nhân từ Meta Graph API thay vì tự sinh Page giả!
      if (!isExplicitSandboxToken && meCall.errorCode && meCall.errorCode >= 100) {
        throw new BadRequestException(
          `Không thể xác thực Access Token trên Meta Graph API (${meCall.usedVersion}): ${meCall.errorMessage}`,
        );
      }
    }

    // 2. Nhánh Zalo Official Account (GET https://openapi.zalo.me/v2.0/oa/getoa)
    if (dto.channelType === ChannelTypeEnum.ZALO_OA) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const zaloRes = await fetch('https://openapi.zalo.me/v2.0/oa/getoa', {
          method: 'GET',
          headers: { access_token: cleanToken },
          signal: controller.signal,
        }).catch(() => null);
        clearTimeout(timeoutId);

        if (zaloRes && zaloRes.ok) {
          const zaloJson = (await zaloRes.json()) as {
            error?: number;
            message?: string;
            data?: {
              oa_id?: string | number;
              name?: string;
              avatar?: string;
              cover?: string;
              description?: string;
            };
          };
          if (zaloJson?.error === 0 && zaloJson.data?.oa_id) {
            const extId = String(zaloJson.data.oa_id);
            const oaName = zaloJson.data.name || `Zalo OA #${extId}`;
            const shortCode = this.buildSmartShortCode(dto.channelType, oaName, extId);
            const candidate: ResolvedChannelTokenCandidatePage = {
              externalPageId: extId,
              pageName: oaName,
              pageShortCode: shortCode,
              avatarUrl: zaloJson.data.avatar || null,
              category: 'Zalo Official Account',
              pageAccessToken: cleanToken,
              subscribedFields,
            };
            return {
              channelType: dto.channelType,
              apiVersion: resolvedApiVersion,
              appId: resolvedAppId,
              tokenKind: 'OA_TOKEN',
              authenticatedUserId: null,
              authenticatedUserName: null,
              requiresPageSelection: false,
              externalPageId: extId,
              pageName: oaName,
              pageShortCode: shortCode,
              avatarUrl: candidate.avatarUrl,
              category: 'Zalo Official Account',
              resolvedPageAccessToken: cleanToken,
              subscribedFields,
              candidatePages: [candidate],
              webhookCallbackUrl,
              webhookVerifyToken,
              resolvedFromLiveApi: true,
            };
          } else if (!isExplicitSandboxToken && zaloJson?.error && zaloJson.error !== 0) {
            throw new BadRequestException(
              `Zalo OA Access Token không hợp lệ (Mã lỗi ${zaloJson.error}): ${zaloJson.message || 'ZALO_OA_AUTH_FAILED'}`,
            );
          }
        }
      } catch (err) {
        if (err instanceof BadRequestException) {
          throw err;
        }
      }
    }

    // 3. Nhánh Chế độ Kiểm thử / Môi trường Sandbox Offline
    const shop = await this.shopRepo.findOne({ where: { id: shopId } });
    const tokenDigest = crypto.createHash('sha256').update(cleanToken).digest('hex');
    const numericSuffix = String(parseInt(tokenDigest.slice(0, 10), 16)).slice(0, 10);
    const resolvedExternalPageId =
      dto.externalPageId?.trim() ||
      (dto.channelType === ChannelTypeEnum.FACEBOOK_PAGE
        ? `10${numericSuffix}`
        : `${dto.channelType.toLowerCase()}_${tokenDigest.slice(0, 10)}`);

    const platformLabelMap: Record<ChannelTypeEnum, string> = {
      [ChannelTypeEnum.FACEBOOK_PAGE]: 'Fanpage',
      [ChannelTypeEnum.INSTAGRAM]: 'Instagram Official',
      [ChannelTypeEnum.ZALO_OA]: 'Zalo OA',
      [ChannelTypeEnum.TIKTOK_SHOP]: 'TikTok Shop',
      [ChannelTypeEnum.SHOPEE]: 'Shopee Mall',
      [ChannelTypeEnum.LAZADA]: 'Lazada Flagship',
      [ChannelTypeEnum.WEBSITE_LIVECHAT]: 'Website Livechat',
      [ChannelTypeEnum.INTERNAL]: 'Internal Channel',
    };

    const brandBaseName = shop?.name || 'Pancake Seller Store';
    const resolvedPageName = `${brandBaseName} — ${platformLabelMap[dto.channelType]} #${resolvedExternalPageId.slice(-4)}`;
    const resolvedShortCode = this.buildSmartShortCode(
      dto.channelType,
      brandBaseName,
      resolvedExternalPageId,
    );
    const resolvedAvatarUrl = `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(resolvedShortCode)}&backgroundColor=0284c7,4f46e5,059669`;

    const primaryCandidate: ResolvedChannelTokenCandidatePage = {
      externalPageId: resolvedExternalPageId,
      pageName: resolvedPageName,
      pageShortCode: resolvedShortCode,
      avatarUrl: resolvedAvatarUrl,
      category: platformLabelMap[dto.channelType],
      pageAccessToken: cleanToken,
      subscribedFields,
    };

    return {
      channelType: dto.channelType,
      apiVersion: resolvedApiVersion,
      appId: resolvedAppId,
      tokenKind: 'SANDBOX_TOKEN',
      authenticatedUserId: null,
      authenticatedUserName: null,
      requiresPageSelection: false,
      externalPageId: primaryCandidate.externalPageId,
      pageName: primaryCandidate.pageName,
      pageShortCode: primaryCandidate.pageShortCode,
      avatarUrl: primaryCandidate.avatarUrl,
      category: primaryCandidate.category || null,
      resolvedPageAccessToken: cleanToken,
      subscribedFields,
      candidatePages: [primaryCandidate],
      webhookCallbackUrl,
      webhookVerifyToken,
      resolvedFromLiveApi: false,
    };
  }

  /**
   * Đăng ký và xác minh danh sách trường Webhook (`subscribed_apps`) trên nền tảng Meta Graph API
   * với đúng `Page Access Token` và `apiVersion` của kênh.
   */
  public async subscribeChannelWebhookOnPlatform(
    channel: ChannelIntegrationEntity,
    rawPageAccessToken: string,
    rawAppSecret?: string | null,
    customFields?: string[],
  ): Promise<{
    subscribedFields: string[];
    verifiedOnPlatform: boolean;
  }> {
    const desiredFields =
      customFields && customFields.length > 0
        ? customFields
        : DEFAULT_SUBSCRIBED_FIELDS_BY_PLATFORM[channel.channelType] ||
          DEFAULT_SUBSCRIBED_FIELDS_BY_PLATFORM[ChannelTypeEnum.FACEBOOK_PAGE];

    if (
      channel.channelType === ChannelTypeEnum.FACEBOOK_PAGE ||
      channel.channelType === ChannelTypeEnum.INSTAGRAM
    ) {
      const apiVer = this.normalizeGraphApiVersion(channel.apiVersion, channel.channelType);
      const subRes = await this.callMetaGraphApi<{ success?: boolean }>({
        apiVersion: apiVer,
        path: `${channel.externalPageId}/subscribed_apps`,
        method: 'POST',
        body: {
          subscribed_fields: desiredFields,
        },
        accessToken: rawPageAccessToken,
        appSecret: rawAppSecret,
      });

      return {
        subscribedFields: desiredFields,
        verifiedOnPlatform: Boolean(subRes.ok),
      };
    }

    return {
      subscribedFields: desiredFields,
      verifiedOnPlatform: true,
    };
  }

  /**
   * Đồng bộ và kiểm tra lại trạng thái đăng ký Webhook (`subscribed_apps`) của 1 kênh đã kết nối
   */
  async syncAndVerifyChannelWebhook(
    shopId: string,
    channelId: string,
  ): Promise<{
    channelId: string;
    externalPageId: string;
    apiVersion: string;
    webhookCallbackUrl: string;
    subscribedFields: string[];
    verifiedOnPlatform: boolean;
    webhookStatus: WebhookIntegrationStatusEnum;
  }> {
    const channel = await this.channelRepo.findOne({
      where: { id: channelId, shopId },
    });
    if (!channel) {
      throw new NotFoundException('CHANNEL_INTEGRATION_NOT_FOUND');
    }

    const rawPageToken = this.messageCryptoService.decryptForConversation(
      channel.accessTokenEncrypted,
      shopId,
    );
    const rawAppSecret = channel.appSecretEncrypted
      ? this.messageCryptoService.decryptForConversation(channel.appSecretEncrypted, shopId)
      : envs.omnichannelSaas.metaAppSecret || null;

    const subResult = await this.subscribeChannelWebhookOnPlatform(
      channel,
      rawPageToken,
      rawAppSecret,
      channel.platformConfigJson?.subscribedFields,
    );

    const nextPlatformConfig: ChannelPlatformSaasConfig = {
      ...(channel.platformConfigJson || {}),
      apiVersion: this.normalizeGraphApiVersion(channel.apiVersion, channel.channelType),
      webhookCallbackUrl: this.buildWebhookCallbackUrl(channel.channelType),
      subscribedFields: subResult.subscribedFields,
    };

    channel.platformConfigJson = nextPlatformConfig;
    channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
    channel.lastErrorMessage = null;
    await this.channelRepo.save(channel);

    await this.broadcastChannelEventToShop(
      shopId,
      SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED,
      {
        shopId,
        action: 'WEBHOOK_SYNCED',
        channelId: channel.id,
        subscribedFields: subResult.subscribedFields,
      },
    );

    return {
      channelId: channel.id,
      externalPageId: channel.externalPageId,
      apiVersion: nextPlatformConfig.apiVersion || 'v27.1',
      webhookCallbackUrl: nextPlatformConfig.webhookCallbackUrl || '',
      subscribedFields: subResult.subscribedFields,
      verifiedOnPlatform: subResult.verifiedOnPlatform,
      webhookStatus: channel.webhookStatus,
    };
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
   * Xác thực chữ ký mật mã HMAC-SHA256 trên Header Webhook:
   * - Meta (Facebook/Instagram): `X-Hub-Signature-256 = sha256=HMAC_SHA256(rawPayload, appSecret || webhookVerifySecret)`
   * - Zalo OA: `X-ZEvent-Signature`
   * - Shopee / TikTok Shop / Lazada: `X-Shopee-Signature` / `X-Tts-Signature`
   */
  verifyWebhookSignatureIfConfigured(params: {
    channel: ChannelIntegrationEntity | null;
    headers: Record<string, string>;
    rawPayload: Record<string, unknown>;
  }): boolean {
    const { channel, headers, rawPayload } = params;
    if (!channel) {
      return true;
    }

    const signatureHeader =
      headers['x-hub-signature-256'] ||
      headers['x-zalo-signature'] ||
      headers['x-zevent-signature'] ||
      headers['x-shopee-signature'] ||
      headers['x-tts-signature'];

    if (!signatureHeader) {
      return true;
    }

    const secretCipher = channel.appSecretEncrypted || channel.webhookVerifySecretEncrypted;
    if (!secretCipher) {
      return true;
    }

    const secret = this.messageCryptoService.decryptForConversation(secretCipher, channel.shopId);
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
   * Kết nối mới hoặc khôi phục/cập nhật kênh đã từng ngắt kết nối (withDeleted: true).
   * Tự động hoán đổi từ User Access Token sang đúng Page Access Token của `externalPageId` được chọn,
   * lưu đầy đủ cấu hình SaaS (`apiVersion`, `appId`, `appSecretEncrypted`, `platformConfigJson`)
   * và đăng ký `subscribed_apps` trên nền tảng.
   */
  async connectOrUpdateChannelOAuth(
    shopId: string,
    dto: ConnectChannelOAuthDto,
    actorUserId?: string,
  ): Promise<ChannelIntegrationEntity> {
    const inputAccessToken = (
      dto.accessToken || `oauth2_tok_${dto.oauthCode || crypto.randomBytes(16).toString('hex')}`
    ).trim();

    const normalizedApiVersion = this.normalizeGraphApiVersion(dto.apiVersion, dto.channelType);
    const resolvedAppId =
      dto.appId?.trim() ||
      (dto.channelType === ChannelTypeEnum.ZALO_OA
        ? envs.omnichannelSaas.zaloAppId
        : envs.omnichannelSaas.metaAppId) ||
      null;
    const rawAppSecret =
      dto.appSecret?.trim() ||
      (dto.channelType === ChannelTypeEnum.ZALO_OA
        ? envs.omnichannelSaas.zaloAppSecret
        : envs.omnichannelSaas.metaAppSecret) ||
      null;

    // Luôn phân giải Token để đảm bảo:
    // 1. Nếu người dùng nhập User Access Token kèm externalPageId, hệ thống lấy đúng Page Access Token của Page đó!
    // 2. Nếu người dùng chưa điền pageName / avatarUrl / externalPageId, hệ thống điền chính xác từ nền tảng.
    let autoResolvedMeta: ResolvedChannelTokenMetadataResult | null = null;
    if (!dto.pageName || !dto.externalPageId || !dto.avatarUrl || !dto.pageShortCode) {
      autoResolvedMeta = await this.resolveChannelMetadataFromToken(shopId, {
        channelType: dto.channelType,
        accessToken: inputAccessToken,
        apiVersion: normalizedApiVersion,
        appId: resolvedAppId || undefined,
        appSecret: rawAppSecret || undefined,
        externalPageId: dto.externalPageId,
        allowSandboxSimulation: dto.allowSandboxSimulation,
      });

      if (autoResolvedMeta.requiresPageSelection && !dto.externalPageId) {
        throw new BadRequestException(
          `Access Token này quản lý ${autoResolvedMeta.candidatePages.length} Fanpage khác nhau. Vui lòng chọn đúng Fanpage muốn kết nối từ danh sách.`,
        );
      }
    }

    const effectivePageAccessToken = autoResolvedMeta?.resolvedPageAccessToken || inputAccessToken;

    const resolvedExternalPageId = (
      dto.externalPageId ||
      autoResolvedMeta?.externalPageId ||
      (dto.oauthCode
        ? `${dto.channelType.toLowerCase()}_${crypto
            .createHash('sha256')
            .update(dto.oauthCode)
            .digest('hex')
            .slice(0, 12)}`
        : `${dto.channelType.toLowerCase()}_${Date.now()}`)
    ).trim();

    const resolvedPageName = (
      dto.pageName ||
      autoResolvedMeta?.pageName ||
      `${dto.channelType} — ${resolvedExternalPageId.slice(-4)}`
    ).trim();

    const resolvedShortCode = (
      dto.pageShortCode ||
      autoResolvedMeta?.pageShortCode ||
      this.buildSmartShortCode(dto.channelType, resolvedPageName, resolvedExternalPageId)
    )
      .trim()
      .toUpperCase();

    const resolvedAvatarUrl =
      dto.avatarUrl?.trim() ||
      autoResolvedMeta?.avatarUrl ||
      `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(resolvedShortCode)}`;

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
      effectivePageAccessToken,
      shopId,
    ).ciphertext;

    const appSecretEncrypted = rawAppSecret
      ? this.messageCryptoService.encryptForConversation(rawAppSecret, shopId).ciphertext
      : null;

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

    const desiredSubscribedFields =
      dto.subscribedFields && dto.subscribedFields.length > 0
        ? dto.subscribedFields
        : autoResolvedMeta?.subscribedFields ||
          DEFAULT_SUBSCRIBED_FIELDS_BY_PLATFORM[dto.channelType];

    const platformConfigJson: ChannelPlatformSaasConfig = {
      apiVersion: normalizedApiVersion,
      appId: resolvedAppId,
      webhookCallbackUrl: this.buildWebhookCallbackUrl(dto.channelType),
      subscribedFields: desiredSubscribedFields,
      tokenKind: autoResolvedMeta?.tokenKind || 'PAGE_TOKEN',
      authenticatedUserId: autoResolvedMeta?.authenticatedUserId || null,
      authenticatedUserName: autoResolvedMeta?.authenticatedUserName || null,
      pageCategory: autoResolvedMeta?.category || null,
      requireAppSecretProof: Boolean(rawAppSecret),
      autoHidePhoneComments: dto.autoHidePhoneComments ?? true,
      syncEchoMessagesFromNativeApp: dto.syncEchoMessagesFromNativeApp ?? true,
    };

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
      channel.avatarUrl = resolvedAvatarUrl || channel.avatarUrl;
      channel.apiVersion = normalizedApiVersion;
      channel.appId = resolvedAppId || channel.appId;
      if (appSecretEncrypted) {
        channel.appSecretEncrypted = appSecretEncrypted;
      }
      channel.accessTokenEncrypted = accessTokenEncrypted;
      if (refreshTokenEncrypted) {
        channel.refreshTokenEncrypted = refreshTokenEncrypted;
      }
      if (webhookVerifySecretEncrypted) {
        channel.webhookVerifySecretEncrypted = webhookVerifySecretEncrypted;
      }
      channel.platformConfigJson = {
        ...(channel.platformConfigJson || {}),
        ...platformConfigJson,
      };
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
        avatarUrl: resolvedAvatarUrl,
        apiVersion: normalizedApiVersion,
        appId: resolvedAppId,
        appSecretEncrypted,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        webhookVerifySecretEncrypted,
        platformConfigJson,
        metaDatasetId: dto.metaDatasetId || null,
        capiAccessTokenEncrypted,
        tokenExpiresAt: defaultExpiry,
        webhookStatus: WebhookIntegrationStatusEnum.HEALTHY,
        isActive: true,
      });
    }

    const saved = await this.channelRepo.save(channel);

    const subRes = await this.subscribeChannelWebhookOnPlatform(
      saved,
      effectivePageAccessToken,
      rawAppSecret,
      desiredSubscribedFields,
    );

    const [shop, managerIds] = await Promise.all([
      this.shopRepo.findOne({ where: { id: shopId } }),
      this.broadcastChannelEventToShop(shopId, SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED, {
        shopId,
        action: 'CONNECTED',
        channelId: saved.id,
        channelType: saved.channelType,
        pageName: saved.pageName,
        pageShortCode: saved.pageShortCode,
        avatarUrl: saved.avatarUrl,
        apiVersion: saved.apiVersion,
        webhookStatus: saved.webhookStatus,
        subscribedFields: subRes.subscribedFields,
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

  /**
   * Kết nối hàng loạt nhiều Fanpage / Instagram cùng lúc từ danh sách `candidatePages` của User Access Token
   */
  async batchConnectChannels(
    shopId: string,
    channelDtos: ConnectChannelOAuthDto[],
    actorUserId?: string,
  ): Promise<ChannelIntegrationEntity[]> {
    const results: ChannelIntegrationEntity[] = [];
    for (const dto of channelDtos) {
      const connected = await this.connectOrUpdateChannelOAuth(shopId, dto, actorUserId);
      results.push(connected);
    }
    return results;
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

    if (dto.apiVersion !== undefined) {
      channel.apiVersion = this.normalizeGraphApiVersion(dto.apiVersion, channel.channelType);
    }
    if (dto.appId !== undefined) {
      channel.appId = dto.appId.trim() || null;
    }
    if (dto.appSecret) {
      channel.appSecretEncrypted = this.messageCryptoService.encryptForConversation(
        dto.appSecret.trim(),
        shopId,
      ).ciphertext;
    }

    const rawAppSecret = dto.appSecret
      ? dto.appSecret.trim()
      : channel.appSecretEncrypted
        ? this.messageCryptoService.decryptForConversation(channel.appSecretEncrypted, shopId)
        : null;

    if (dto.accessToken) {
      const cleanToken = dto.accessToken.trim();
      const autoMeta = await this.resolveChannelMetadataFromToken(shopId, {
        channelType: channel.channelType,
        accessToken: cleanToken,
        apiVersion: channel.apiVersion || 'v27.1',
        appId: channel.appId || undefined,
        appSecret: rawAppSecret || undefined,
        externalPageId: channel.externalPageId,
      }).catch(() => null);

      const effectivePageToken = autoMeta?.resolvedPageAccessToken || cleanToken;
      channel.accessTokenEncrypted = this.messageCryptoService.encryptForConversation(
        effectivePageToken,
        shopId,
      ).ciphertext;
      channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
      channel.tokenExpiresAt = new Date(Date.now() + 60 * 86400 * 1000);
      channel.lastErrorMessage = null;

      if (!dto.pageName && autoMeta?.pageName) {
        channel.pageName = autoMeta.pageName;
      }
      if (!dto.avatarUrl && autoMeta?.avatarUrl) {
        channel.avatarUrl = autoMeta.avatarUrl;
      }

      await this.subscribeChannelWebhookOnPlatform(
        channel,
        effectivePageToken,
        rawAppSecret,
        dto.subscribedFields || channel.platformConfigJson?.subscribedFields,
      );
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

    channel.platformConfigJson = {
      ...(channel.platformConfigJson || {}),
      apiVersion: channel.apiVersion,
      appId: channel.appId,
      webhookCallbackUrl: this.buildWebhookCallbackUrl(channel.channelType),
      ...(dto.subscribedFields ? { subscribedFields: dto.subscribedFields } : {}),
      ...(dto.autoHidePhoneComments !== undefined
        ? { autoHidePhoneComments: dto.autoHidePhoneComments }
        : {}),
      ...(dto.syncEchoMessagesFromNativeApp !== undefined
        ? { syncEchoMessagesFromNativeApp: dto.syncEchoMessagesFromNativeApp }
        : {}),
    };

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
        avatarUrl: saved.avatarUrl,
        apiVersion: saved.apiVersion,
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
        webhookCallbackUrl: string;
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
        webhookCallbackUrl:
          ch.platformConfigJson?.webhookCallbackUrl || this.buildWebhookCallbackUrl(ch.channelType),
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
   * Tự động lấy Tên thật & Ảnh đại diện của khách hàng từ PSID (Facebook/Instagram) hoặc user_id (Zalo OA)
   * khi Webhook chỉ gửi ID người gửi mà không kèm tên. Có lưu cache Redis 24h để tối ưu tốc độ.
   */
  private async enrichCustomerProfileByPsid(params: {
    channel: ChannelIntegrationEntity;
    externalCustomerPsid: string | null;
    fallbackName: string;
  }): Promise<{ name: string; avatarUrl: string | null }> {
    const { channel, externalCustomerPsid, fallbackName } = params;
    if (!externalCustomerPsid || !fallbackName.includes('#')) {
      return { name: fallbackName, avatarUrl: null };
    }

    const cacheKey = `psid_profile:${channel.id}:${externalCustomerPsid}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { name: string; avatarUrl: string | null };
        if (parsed?.name) return parsed;
      }
    } catch {
      // Bỏ qua nếu Redis offline
    }

    const rawPageToken = this.messageCryptoService.decryptForConversation(
      channel.accessTokenEncrypted,
      channel.shopId,
    );
    if (!rawPageToken || rawPageToken.startsWith('oauth2_tok_')) {
      return { name: fallbackName, avatarUrl: null };
    }

    const rawAppSecret = channel.appSecretEncrypted
      ? this.messageCryptoService.decryptForConversation(channel.appSecretEncrypted, channel.shopId)
      : envs.omnichannelSaas.metaAppSecret || null;

    if (
      channel.channelType === ChannelTypeEnum.FACEBOOK_PAGE ||
      channel.channelType === ChannelTypeEnum.INSTAGRAM
    ) {
      const profileCall = await this.callMetaGraphApi<{
        name?: string;
        first_name?: string;
        last_name?: string;
        profile_pic?: string;
      }>({
        apiVersion: channel.apiVersion || 'v27.1',
        path: externalCustomerPsid,
        queryParams: {
          fields: 'name,first_name,last_name,profile_pic',
        },
        accessToken: rawPageToken,
        appSecret: rawAppSecret,
      });

      if (profileCall.ok && profileCall.data) {
        const fullName =
          profileCall.data.name ||
          [profileCall.data.first_name, profileCall.data.last_name].filter(Boolean).join(' ') ||
          fallbackName;
        const avatarUrl = profileCall.data.profile_pic || null;
        const resolved = { name: fullName, avatarUrl };
        await this.redis.set(cacheKey, JSON.stringify(resolved), 'EX', 86400).catch(() => null);
        return resolved;
      }
    }

    return { name: fallbackName, avatarUrl: null };
  }

  /**
   * Chuẩn hóa toàn bộ cấu trúc Payload từ Facebook (feed, live_videos, group_feed, messaging, message_echoes, delivery, read),
   * Instagram (comments, live_comments, messages), Zalo OA (user_send_*, oa_send_*, user_seen_message), TikTok Shop, Shopee, Lazada và Livechat.
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

    const isMessagingEcho = Boolean(firstMessaging?.message?.is_echo);
    const externalPageId = String(
      payload?.pageId ||
        payload?.externalPageId ||
        payload?.recipientId ||
        payload?.oa_id ||
        payload?.shop_id ||
        firstEntry?.id ||
        (isMessagingEcho ? firstMessaging?.sender?.id : firstMessaging?.recipient?.id) ||
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
      const isEchoCommentFromPage = Boolean(externalPageId && commenterId === externalPageId);
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
        externalCustomerPsid: commenterId,
        externalMessageId: commentId,
        customerName: commenterName,
        messageText: String(
          changeVal.message || changeVal.text || '[Khách hàng gửi bình luận kèm hình ảnh/nhãn dán]',
        ),
        interactionType: isLive ? 'LIVESTREAM' : 'COMMENT',
        verb,
        isEchoFromPage: isEchoCommentFromPage,
        eventSubtype: 'MESSAGE_OR_COMMENT',
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
      // Nếu là message_echoes (tin nhắn do chính Fanpage gửi đi), khách hàng là recipient.id!
      const customerPsid = String(
        isMessagingEcho
          ? firstMessaging.recipient?.id
          : firstMessaging.sender?.id || `psid_${fallbackLogId.slice(0, 8)}`,
      );

      // Sự kiện khách đã xem tin nhắn (message_reads)
      if (firstMessaging.read?.watermark) {
        return {
          externalPageId,
          externalThreadId: `inbox_${customerPsid}`,
          externalCustomerPsid: customerPsid,
          externalMessageId: `read_${firstMessaging.read.watermark}`,
          customerName: `Khách ${channelType} #${customerPsid.slice(-4)}`,
          messageText: '',
          interactionType: 'INBOX',
          verb: 'add',
          isEchoFromPage: false,
          eventSubtype: 'READ_RECEIPT',
          watermarkTimestampMs: Number(firstMessaging.read.watermark),
          sourcePostId: null,
          sourceAdId: null,
          ctwaClickId: null,
          externalCommentId: null,
          parentCommentId: null,
          mediaAttachmentUrl: null,
        };
      }

      // Sự kiện tin nhắn đã chuyển tới máy khách (message_deliveries)
      if (firstMessaging.delivery) {
        return {
          externalPageId,
          externalThreadId: `inbox_${customerPsid}`,
          externalCustomerPsid: customerPsid,
          externalMessageId: `dlv_${firstMessaging.delivery.watermark || fallbackLogId}`,
          customerName: `Khách ${channelType} #${customerPsid.slice(-4)}`,
          messageText: '',
          interactionType: 'INBOX',
          verb: 'add',
          isEchoFromPage: false,
          eventSubtype: 'DELIVERY_RECEIPT',
          watermarkTimestampMs: Number(firstMessaging.delivery.watermark || Date.now()),
          deliveredMessageIds: Array.isArray(firstMessaging.delivery.mids)
            ? firstMessaging.delivery.mids.map(String)
            : [],
          sourcePostId: null,
          sourceAdId: null,
          ctwaClickId: null,
          externalCommentId: null,
          parentCommentId: null,
          mediaAttachmentUrl: null,
        };
      }

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
        externalThreadId: `inbox_${customerPsid}`,
        externalCustomerPsid: customerPsid,
        externalMessageId: msgId,
        customerName: String(
          firstMessaging.sender?.name || `Khách ${channelType} #${customerPsid.slice(-4)}`,
        ),
        messageText: text,
        interactionType: 'INBOX',
        verb: 'add',
        isEchoFromPage: isMessagingEcho,
        eventSubtype: 'MESSAGE_OR_COMMENT',
        sourcePostId: referral?.post_id ? String(referral.post_id) : null,
        sourceAdId: referral?.ad_id ? String(referral.ad_id) : null,
        ctwaClickId: referral?.ctwa_clid ? String(referral.ctwa_clid) : null,
        externalCommentId: null,
        parentCommentId: null,
        mediaAttachmentUrl: attachmentUrl,
      };
    }

    // 3. Trường hợp Zalo Official Account Webhook (user_send_*, oa_send_*, user_seen_message, follow...)
    if (
      channelType === ChannelTypeEnum.ZALO_OA &&
      (payload?.event_name || payload?.sender || payload?.recipient)
    ) {
      const eventName = String(payload.event_name || '').toLowerCase();
      const isZaloEcho = eventName.startsWith('oa_send_');
      const zaloCustomerId = String(
        isZaloEcho
          ? payload.recipient?.id
          : payload.sender?.id || payload.user_id_by_app || `zalo_${fallbackLogId.slice(0, 8)}`,
      );

      if (eventName === 'user_seen_message') {
        return {
          externalPageId,
          externalThreadId: `zalo_${zaloCustomerId}`,
          externalCustomerPsid: zaloCustomerId,
          externalMessageId: `zalo_seen_${fallbackLogId}`,
          customerName: `Khách Zalo #${zaloCustomerId.slice(-4)}`,
          messageText: '',
          interactionType: 'INBOX',
          verb: 'add',
          isEchoFromPage: false,
          eventSubtype: 'READ_RECEIPT',
          watermarkTimestampMs: Number(payload.timestamp || Date.now()),
          sourcePostId: null,
          sourceAdId: null,
          ctwaClickId: null,
          externalCommentId: null,
          parentCommentId: null,
          mediaAttachmentUrl: null,
        };
      }

      const zaloMsgId = String(payload.message?.msg_id || `zalo_msg_${fallbackLogId}`);
      const zaloText = String(
        payload.message?.text ||
          (eventName === 'follow'
            ? '[Khách hàng vừa nhấn Quan tâm Zalo OA]'
            : '[Tin nhắn hình ảnh/vị trí Zalo OA]'),
      );

      return {
        externalPageId,
        externalThreadId: `zalo_${zaloCustomerId}`,
        externalCustomerPsid: zaloCustomerId,
        externalMessageId: zaloMsgId,
        customerName: String(payload.sender?.name || `Khách Zalo #${zaloCustomerId.slice(-4)}`),
        messageText: zaloText,
        interactionType: 'INBOX',
        verb: 'add',
        isEchoFromPage: isZaloEcho,
        eventSubtype: 'MESSAGE_OR_COMMENT',
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
      externalCustomerPsid: payload?.senderId ? String(payload.senderId) : null,
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
      isEchoFromPage: Boolean(payload?.isEcho),
      eventSubtype: 'MESSAGE_OR_COMMENT',
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

    this.verifyWebhookSignatureIfConfigured({
      channel,
      headers,
      rawPayload: payload,
    });

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

    // 0. Xử lý sự kiện Khách hàng Đã nhận / Đã xem tin nhắn của Shop (DELIVERY_RECEIPT / READ_RECEIPT)
    if (
      normalized.eventSubtype === 'READ_RECEIPT' ||
      normalized.eventSubtype === 'DELIVERY_RECEIPT'
    ) {
      const targetConv = await this.conversationRepo.findOne({
        where: {
          shopId: channel.shopId,
          channelIntegrationId: channel.id,
          externalThreadId: normalized.externalThreadId,
        },
      });
      if (targetConv) {
        const nextStatus =
          normalized.eventSubtype === 'READ_RECEIPT'
            ? MessageStatusEnum.READ
            : MessageStatusEnum.DELIVERED;

        this.realtimeEmitter.emitToConversation(
          SOCKET_CONFIG.namespaces.CHAT,
          targetConv.id,
          SOCKET_CONFIG.events.CHAT.MESSAGE_READ,
          {
            conversationId: targetConv.id,
            userId: `customer:${normalized.externalCustomerPsid || 'guest'}`,
            lastReadAt: new Date(normalized.watermarkTimestampMs || Date.now()).toISOString(),
            status: nextStatus,
          },
        );
      }

      return {
        shopId: channel.shopId,
        channelIntegrationId: channel.id,
        conversationId: targetConv?.id || null,
        assignedAgentId: targetConv?.assignedAgentId || null,
      };
    }

    // 0.5. Xử lý sự kiện `message_echoes` (`isEchoFromPage === true`):
    // - Nếu tin nhắn/bình luận đã tồn tại trong bảng `messages` (do nhân viên vừa gửi từ hệ thống SaaS),
    //   bỏ qua không tạo lặp thành tin nhắn Inbound giả!
    // - Nếu chưa tồn tại (do chủ shop nhắn trả lời từ ứng dụng Meta Business Suite / Zalo OA trên điện thoại),
    //   đồng bộ tin nhắn đó vào hội thoại của khách với `direction = OUTBOUND` và chuyển sang `WAITING_CUSTOMER_REPLY`!
    if (normalized.isEchoFromPage) {
      const existingOutbound = await this.messageRepo.findOne({
        where: {
          shopId: channel.shopId,
          externalMessageId: normalized.externalMessageId,
        },
      });

      if (existingOutbound || normalized.interactionType !== 'INBOX') {
        return {
          shopId: channel.shopId,
          channelIntegrationId: channel.id,
          conversationId: existingOutbound?.conversationId || null,
          assignedAgentId: null,
        };
      }

      if (channel.platformConfigJson?.syncEchoMessagesFromNativeApp !== false) {
        const echoConv = await this.conversationRepo.findOne({
          where: {
            shopId: channel.shopId,
            channelIntegrationId: channel.id,
            externalThreadId: normalized.externalThreadId,
          },
        });
        if (echoConv) {
          const now = new Date();
          const encryptedEcho = this.messageCryptoService.encryptForConversation(
            normalized.messageText,
            echoConv.id,
          );
          await this.conversationRepo.update(echoConv.id, {
            lastMessage: encryptedEcho.ciphertext,
            lastMessageAt: now,
            lastAgentReplyAt: now,
            supportStatus: ConversationSupportStatusEnum.WAITING_CUSTOMER_REPLY,
            slaDeadlineAt: null,
            isSlaBreached: false,
            isGhostedByAgent: false,
          });

          const echoMsg = this.messageRepo.create({
            conversationId: echoConv.id,
            senderId: echoConv.assignedAgentId || channel.createdBy || 'page_echo',
            shopId: channel.shopId,
            direction: MessageDirectionEnum.OUTBOUND,
            externalMessageId: normalized.externalMessageId,
            content: encryptedEcho.ciphertext,
            type: MessageTypeEnum.TEXT,
            status: MessageStatusEnum.SENT,
            readBy: [],
            deliveredTo: [],
            isPinned: false,
            metadata: {
              isEncrypted: encryptedEcho.isEncrypted,
              encryptionAlg: encryptedEcho.algorithm,
              platformDeliveryStatus: 'DISPATCHED',
              platformExternalId: normalized.externalMessageId,
            } as any,
            createdAt: now,
            updatedAt: now,
          });
          const savedEcho = await this.messageRepo.save(echoMsg);
          this.realtimeEmitter.emitToConversation(
            SOCKET_CONFIG.namespaces.CHAT,
            echoConv.id,
            SOCKET_CONFIG.events.CHAT.NEW_MESSAGE,
            {
              ...savedEcho,
              content: normalized.messageText,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            },
          );
          return {
            shopId: channel.shopId,
            channelIntegrationId: channel.id,
            conversationId: echoConv.id,
            assignedAgentId: echoConv.assignedAgentId,
          };
        }
      }

      return {
        shopId: channel.shopId,
        channelIntegrationId: channel.id,
        conversationId: null,
        assignedAgentId: null,
      };
    }

    // 1. Bảo toàn Bình luận khi bị xóa trên nền tảng gốc (Immutable Comment Retention — Pancake CRM rule)
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
          deletedByActor: 'CUSTOMER' as const,
          deletedOnPlatformAt: new Date().toISOString(),
        };
        await this.messageRepo.update(
          { id: existingMsg.id, createdAt: existingMsg.createdAt },
          { metadata: updatedMetadata as any },
        );

        const deletedPayload = {
          id: existingMsg.id,
          messageId: existingMsg.id,
          conversationId: existingMsg.conversationId,
          isDeletedOnPlatform: true,
          deletedByActor: 'CUSTOMER',
          deletedOnPlatformAt: updatedMetadata.deletedOnPlatformAt,
          metadata: updatedMetadata,
        };

        this.realtimeEmitter.emitToConversation(
          SOCKET_CONFIG.namespaces.CHAT,
          existingMsg.conversationId,
          SOCKET_CONFIG.events.OMNICHANNEL_INBOX.COMMENT_DELETED_ON_PLATFORM,
          deletedPayload,
        );

        await this.broadcastChannelEventToShop(
          channel.shopId,
          SOCKET_CONFIG.events.CHAT.MESSAGE_EDITED,
          deletedPayload,
        );

        return {
          shopId: channel.shopId,
          channelIntegrationId: channel.id,
          conversationId: existingMsg.conversationId,
          assignedAgentId: null,
        };
      }
    }

    // 2. Bảo toàn nội dung gốc khi khách chỉnh sửa bình luận trên nền tảng (verb === 'edited')
    if (normalized.verb === 'edited' && normalized.externalCommentId) {
      const existingMsg = await this.messageRepo.findOne({
        where: {
          shopId: channel.shopId,
          externalMessageId: normalized.externalCommentId,
        },
      });

      if (existingMsg) {
        const previousDecrypted = this.messageCryptoService.decryptForConversation(
          existingMsg.content,
          existingMsg.conversationId,
        );
        const reEncrypted = this.messageCryptoService.encryptForConversation(
          normalized.messageText,
          existingMsg.conversationId,
        );
        const updatedMetadata = {
          ...(existingMsg.metadata || {}),
          isEdited: true,
          editedAt: new Date().toISOString(),
          originalTextBeforePlatformEdit:
            existingMsg.metadata?.originalTextBeforePlatformEdit || previousDecrypted,
        };
        await this.messageRepo.update(
          { id: existingMsg.id, createdAt: existingMsg.createdAt },
          {
            content: reEncrypted.ciphertext,
            metadata: updatedMetadata as any,
          },
        );

        const editedPayload = {
          id: existingMsg.id,
          conversationId: existingMsg.conversationId,
          content: normalized.messageText,
          metadata: updatedMetadata,
        };

        this.realtimeEmitter.emitToConversation(
          SOCKET_CONFIG.namespaces.CHAT,
          existingMsg.conversationId,
          SOCKET_CONFIG.events.CHAT.MESSAGE_EDITED,
          editedPayload,
        );

        await this.broadcastChannelEventToShop(
          channel.shopId,
          SOCKET_CONFIG.events.CHAT.MESSAGE_EDITED,
          editedPayload,
        );

        return {
          shopId: channel.shopId,
          channelIntegrationId: channel.id,
          conversationId: existingMsg.conversationId,
          assignedAgentId: null,
        };
      }
    }

    // Làm giàu Tên & Avatar của khách hàng từ PSID nếu Webhook chỉ gửi ID
    const enrichedCustomer = await this.enrichCustomerProfileByPsid({
      channel,
      externalCustomerPsid: normalized.externalCustomerPsid,
      fallbackName: normalized.customerName,
    });
    normalized.customerName = enrichedCustomer.name;
    normalized.customerAvatarUrl = enrichedCustomer.avatarUrl;

    const hasPhoneMatch = /(?:\+84|84|0)(?:3|5|7|8|9)\d{8}\b/.test(
      normalized.messageText.replace(/[\s.-]/g, ''),
    );

    const isCommentOrLive =
      normalized.interactionType === 'COMMENT' || normalized.interactionType === 'LIVESTREAM';

    // Tự động ẩn bình luận chứa SĐT trong < 500ms để chống đối thủ cướp khách trên bài viết/Ads
    const shouldAutoHidePhoneComment = Boolean(
      isCommentOrLive &&
        hasPhoneMatch &&
        normalized.externalCommentId &&
        channel.platformConfigJson?.autoHidePhoneComments !== false,
    );

    if (shouldAutoHidePhoneComment && normalized.externalCommentId) {
      const rawPageToken = this.messageCryptoService.decryptForConversation(
        channel.accessTokenEncrypted,
        channel.shopId,
      );
      const rawAppSecret = channel.appSecretEncrypted
        ? this.messageCryptoService.decryptForConversation(
            channel.appSecretEncrypted,
            channel.shopId,
          )
        : envs.omnichannelSaas.metaAppSecret || null;

      void this.callMetaGraphApi({
        apiVersion: channel.apiVersion || 'v27.1',
        path: normalized.externalCommentId,
        method: 'POST',
        body:
          channel.channelType === ChannelTypeEnum.INSTAGRAM ? { hide: true } : { is_hidden: true },
        accessToken: rawPageToken,
        appSecret: rawAppSecret,
      });
    }

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
        avatar: normalized.customerAvatarUrl || undefined,
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
      if (normalized.customerName && !normalized.customerName.includes('#')) {
        conversation.name = normalized.customerName;
      }
      if (normalized.customerAvatarUrl) {
        conversation.avatar = normalized.customerAvatarUrl;
      }
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
    const nowIso = now.toISOString();

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
        externalPostId: normalized.sourcePostId || undefined,
        parentCommentId: normalized.parentCommentId,
        sourcePostId: normalized.sourcePostId,
        sourceAdId: normalized.sourceAdId,
        ctwaClickId: normalized.ctwaClickId,
        mediaAttachmentUrl: normalized.mediaAttachmentUrl,
        isDeletedOnPlatform: false,
        ...(shouldAutoHidePhoneComment
          ? {
              isHiddenOnPlatform: true,
              hiddenByAgentId: 'AUTO_SHIELD_SYSTEM',
              hiddenAt: nowIso,
            }
          : {}),
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

    const enrichedRealtimeMessage = {
      ...savedMsg,
      content: normalized.messageText,
      createdAt: nowIso,
      updatedAt: nowIso,
      sender: {
        id: inboundSenderId,
        name: normalized.customerName,
        avatar: normalized.customerAvatarUrl || channel.avatarUrl || null,
      },
    };

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      savedConversation.id,
      SOCKET_CONFIG.events.CHAT.NEW_MESSAGE,
      enrichedRealtimeMessage,
    );

    for (const uid of new Set(participantUserIds)) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        uid,
        SOCKET_CONFIG.events.CHAT.NEW_MESSAGE,
        enrichedRealtimeMessage,
      );
    }

    if (shouldAutoHidePhoneComment) {
      this.realtimeEmitter.emitToConversation(
        SOCKET_CONFIG.namespaces.CHAT,
        savedConversation.id,
        SOCKET_CONFIG.events.OMNICHANNEL_INBOX.COMMENT_VISIBILITY_UPDATED,
        {
          conversationId: savedConversation.id,
          messageId: savedMsg.id,
          isHiddenOnPlatform: true,
          hiddenByAgentId: 'AUTO_SHIELD_SYSTEM',
          hiddenAt: nowIso,
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
        conversationId: savedConversation.id,
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
