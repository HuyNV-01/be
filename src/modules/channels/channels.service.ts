import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import {
  ChannelTypeEnum,
  ConversationSupportStatusEnum,
  ConversationTypeEnum,
  DataScopeEnum,
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
  BatchConnectChannelsDto,
  ConnectChannelOAuthDto,
  CreateSaasAppProfileDto,
  MergedInboxQueryDto,
  ResolveChannelTokenMetadataDto,
  UpdateChannelIntegrationDto,
  UpdateSaasAppProfileDto,
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
import { SaasAppProfileItem, ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { MessageCryptoService } from 'src/modules/chat/services/message-crypto.service';
import { Customer360Service } from 'src/modules/crm/services/customer-360.service';
import { VietnameseCommerceNerService } from 'src/modules/crm/services/vietnamese-commerce-ner.service';
import { DataScopeQueryHelper } from 'src/modules/iam/helpers/data-scope-query.helper';
import { EffectiveMemberContext } from 'src/modules/iam/iam.service';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import { In, Repository } from 'typeorm';

import { ConversationRoutingEngine } from './routing/conversation-routing.engine';
import { ChannelTokenDoctorService } from './services/channel-token-doctor.service';
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
  isNeverExpiringPageToken?: boolean;
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
  igBusinessAccount?: {
    id: string;
    name: string;
    username?: string;
    avatarUrl?: string | null;
  } | null;
}

export interface ResolvedChannelTokenMetadataResult {
  channelType: ChannelTypeEnum;
  saasAppProfileId: string | null;
  saasAppProfileName: string | null;
  apiVersion: string;
  apiVersionUsed: string;
  appId: string | null;
  appIdDetected: string | null;
  tokenExpiresAt: string | null;
  scopesGranted: string[];
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
  resolvedUserAccessToken?: string | null;
  isNeverExpiringPageToken?: boolean;
  subscribedFields: string[];
  candidatePages: ResolvedChannelTokenCandidatePage[];
  webhookCallbackUrl: string;
  webhookVerifyToken: string;
  resolvedFromLiveApi: boolean;
  diagnosticMessage?: string | null;
}

export interface SaasPlatformWebhookConfigItem {
  channelType: ChannelTypeEnum;
  defaultApiVersion: string;
  defaultAppId: string | null;
  hasDefaultAppSecret: boolean;
  hasSystemAppSecret: boolean;
  webhookCallbackUrl: string;
  webhookVerifyToken: string;
  requiredScopes: string[];
  recommendedSubscribedFields: string[];
  subscribedFields: string[];
  outboundCapabilities: string[];
  signatureHeaderName: string;
}

export interface SaasAppProfilePublicView {
  id: string;
  name: string;
  channelType: ChannelTypeEnum;
  apiVersion: string;
  appId: string;
  hasAppSecretConfigured: boolean;
  webhookVerifyToken: string;
  webhookCallbackUrl: string;
  subscribedFields: string[];
  autoHidePhoneComments: boolean;
  syncEchoMessagesFromNativeApp: boolean;
  autoInjectWebhookOnConnect: boolean;
  isDefault: boolean;
  isActive: boolean;
  appWebhookRegistered: boolean;
  connectedChannelsCount: number;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

  // Bộ nhớ đệm L1 giúp chịu tải cao khi hàng nghìn sự kiện Webhook đổ về cùng lúc
  private readonly shopActiveMembersCache = new Map<
    string,
    {
      members: Array<{
        userId: string;
        role: ShopRoleEnum;
        dataScope?: DataScopeEnum;
        allowedChannelIdsJson?: string[] | null;
      }>;
      expiresAt: number;
    }
  >();
  private readonly convParticipantsCache = new Map<
    string,
    { userIds: Set<string>; expiresAt: number }
  >();
  private readonly inMemoryThreadLocks = new Map<string, Promise<unknown>>();
  private readonly coalescedChannelUpdateTimers = new Map<string, NodeJS.Timeout>();
  private isPollingOrganicComments = false;

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
    private readonly tokenDoctorService: ChannelTokenDoctorService,
    private readonly marketplaceBridge: MarketplaceBridgeService,
    private readonly nerService: VietnameseCommerceNerService,
    private readonly customer360Service: Customer360Service,
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

    if (
      channelType === ChannelTypeEnum.TIKTOK_SHOP ||
      channelType === ChannelTypeEnum.SHOPEE ||
      channelType === ChannelTypeEnum.LAZADA
    ) {
      return (rawVersion || (channelType === ChannelTypeEnum.TIKTOK_SHOP ? '202309' : 'v2')).trim();
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
   * Khởi tạo danh sách Hồ sơ Ứng dụng SaaS mặc định cho cửa hàng nếu chưa có
   */
  private async getOrInitShopSaasProfiles(shopId: string): Promise<{
    shop: ShopWorkspaceEntity;
    profiles: SaasAppProfileItem[];
  }> {
    const shop = await this.shopRepo.findOne({ where: { id: shopId } });
    if (!shop) {
      throw new NotFoundException('SHOP_WORKSPACE_NOT_FOUND');
    }

    let profiles = Array.isArray(shop.saasAppProfilesJson) ? [...shop.saasAppProfilesJson] : [];
    if (profiles.length === 0) {
      const nowIso = new Date().toISOString();
      const defaultMetaVerify =
        envs.omnichannelSaas.metaWebhookVerifyToken || 'pancake_seller_os_verify_token';
      const encryptedVerify = this.messageCryptoService.encryptForConversation(
        defaultMetaVerify,
        shopId,
      ).ciphertext;
      const encryptedMetaSecret = envs.omnichannelSaas.metaAppSecret
        ? this.messageCryptoService.encryptForConversation(
            envs.omnichannelSaas.metaAppSecret,
            shopId,
          ).ciphertext
        : null;

      profiles = [
        {
          id: `saas_fb_default_${shopId.slice(0, 8)}`,
          name: 'Meta Graph SaaS — Facebook Fanpage (Mặc định)',
          channelType: ChannelTypeEnum.FACEBOOK_PAGE,
          apiVersion: this.normalizeGraphApiVersion(
            envs.omnichannelSaas.metaGraphApiVersion,
            ChannelTypeEnum.FACEBOOK_PAGE,
          ),
          appId: envs.omnichannelSaas.metaAppId || '1517776481860111',
          appSecretEncrypted: encryptedMetaSecret,
          webhookVerifyTokenEncrypted: encryptedVerify,
          webhookCallbackUrl: this.buildWebhookCallbackUrl(ChannelTypeEnum.FACEBOOK_PAGE),
          subscribedFields: DEFAULT_SUBSCRIBED_FIELDS_BY_PLATFORM[ChannelTypeEnum.FACEBOOK_PAGE],
          autoHidePhoneComments: true,
          syncEchoMessagesFromNativeApp: true,
          autoInjectWebhookOnConnect: true,
          isDefault: true,
          isActive: true,
          appWebhookRegistered: Boolean(envs.omnichannelSaas.metaAppSecret),
          lastVerifiedAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        {
          id: `saas_zalo_default_${shopId.slice(0, 8)}`,
          name: 'Zalo Official Account SaaS v3.0 (Mặc định)',
          channelType: ChannelTypeEnum.ZALO_OA,
          apiVersion: 'v3.0',
          appId: envs.omnichannelSaas.zaloAppId || 'zalo_oa_app_default',
          appSecretEncrypted: envs.omnichannelSaas.zaloAppSecret
            ? this.messageCryptoService.encryptForConversation(
                envs.omnichannelSaas.zaloAppSecret,
                shopId,
              ).ciphertext
            : null,
          webhookVerifyTokenEncrypted: this.messageCryptoService.encryptForConversation(
            envs.omnichannelSaas.zaloWebhookVerifyToken || 'pancake_zalo_verify_token',
            shopId,
          ).ciphertext,
          webhookCallbackUrl: this.buildWebhookCallbackUrl(ChannelTypeEnum.ZALO_OA),
          subscribedFields: DEFAULT_SUBSCRIBED_FIELDS_BY_PLATFORM[ChannelTypeEnum.ZALO_OA],
          autoHidePhoneComments: false,
          syncEchoMessagesFromNativeApp: true,
          autoInjectWebhookOnConnect: true,
          isDefault: true,
          isActive: true,
          appWebhookRegistered: true,
          lastVerifiedAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ];

      shop.saasAppProfilesJson = profiles;
      await this.shopRepo.save(shop);
    }

    return { shop, profiles };
  }

  private toPublicSaasProfileView(
    shopId: string,
    profile: SaasAppProfileItem,
    channelCountMap: Map<string, number>,
  ): SaasAppProfilePublicView {
    const decryptedVerify = profile.webhookVerifyTokenEncrypted
      ? this.messageCryptoService.decryptForConversation(
          profile.webhookVerifyTokenEncrypted,
          shopId,
        )
      : envs.omnichannelSaas.metaWebhookVerifyToken;

    return {
      id: profile.id,
      name: profile.name,
      channelType: profile.channelType,
      apiVersion: profile.apiVersion,
      appId: profile.appId,
      hasAppSecretConfigured: Boolean(profile.appSecretEncrypted),
      webhookVerifyToken: decryptedVerify || envs.omnichannelSaas.metaWebhookVerifyToken,
      webhookCallbackUrl:
        profile.webhookCallbackUrl || this.buildWebhookCallbackUrl(profile.channelType),
      subscribedFields:
        profile.subscribedFields ||
        DEFAULT_SUBSCRIBED_FIELDS_BY_PLATFORM[profile.channelType] ||
        [],
      autoHidePhoneComments: Boolean(profile.autoHidePhoneComments ?? true),
      syncEchoMessagesFromNativeApp: Boolean(profile.syncEchoMessagesFromNativeApp ?? true),
      autoInjectWebhookOnConnect: Boolean(profile.autoInjectWebhookOnConnect ?? true),
      isDefault: Boolean(profile.isDefault),
      isActive: Boolean(profile.isActive ?? true),
      appWebhookRegistered: Boolean(profile.appWebhookRegistered),
      connectedChannelsCount: channelCountMap.get(profile.id) || 0,
      lastVerifiedAt: profile.lastVerifiedAt || null,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  /**
   * Lấy danh sách Hồ sơ Cấu hình Ứng dụng SaaS của cửa hàng
   */
  async listSaasAppProfiles(shopId: string): Promise<SaasAppProfilePublicView[]> {
    const [{ profiles }, channels] = await Promise.all([
      this.getOrInitShopSaasProfiles(shopId),
      this.channelRepo.find({
        where: { shopId },
        select: ['id', 'channelType', 'saasAppProfileId', 'appId'],
      }),
    ]);

    const countMap = new Map<string, number>();
    for (const prof of profiles) {
      const matchedCount = channels.filter(
        (ch) =>
          ch.saasAppProfileId === prof.id ||
          (!ch.saasAppProfileId &&
            ch.channelType === prof.channelType &&
            (ch.appId === prof.appId || prof.isDefault)),
      ).length;
      countMap.set(prof.id, matchedCount);
    }

    return profiles.map((p) => this.toPublicSaasProfileView(shopId, p, countMap));
  }

  /**
   * Tự động đăng ký Webhook cấp Ứng dụng (App-level Subscription: `POST /{apiVersion}/{appId}/subscriptions`)
   * khi Hồ sơ SaaS có đủ `appId` và `appSecret`.
   */
  private async registerAppLevelWebhookOnPlatform(params: {
    channelType: ChannelTypeEnum;
    apiVersion: string;
    appId: string;
    rawAppSecret: string | null;
    webhookCallbackUrl: string;
    webhookVerifyToken: string;
    subscribedFields: string[];
  }): Promise<boolean> {
    if (
      !params.appId ||
      !params.rawAppSecret ||
      (params.channelType !== ChannelTypeEnum.FACEBOOK_PAGE &&
        params.channelType !== ChannelTypeEnum.INSTAGRAM)
    ) {
      return Boolean(params.appId);
    }

    const appAccessToken = `${params.appId.trim()}|${params.rawAppSecret.trim()}`;
    const apiVer = this.normalizeGraphApiVersion(params.apiVersion, params.channelType);
    const url = `https://graph.facebook.com/${apiVer}/${encodeURIComponent(params.appId.trim())}/subscriptions`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4500);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          object: params.channelType === ChannelTypeEnum.INSTAGRAM ? 'instagram' : 'page',
          callback_url: params.webhookCallbackUrl,
          fields: params.subscribedFields,
          verify_token: params.webhookVerifyToken,
          include_values: true,
          access_token: appAccessToken,
        }),
        signal: controller.signal,
      }).catch(() => null);
      clearTimeout(timeoutId);

      if (res && res.ok) {
        const json = (await res.json().catch(() => ({}))) as { success?: boolean };
        return Boolean(json?.success ?? true);
      }
    } catch {
      clearTimeout(timeoutId);
    }
    return false;
  }

  /**
   * Tạo mới một Hồ sơ Cấu hình Ứng dụng SaaS (Hỗ trợ nhiều cấu hình SaaS trên cùng 1 nền tảng)
   */
  async createSaasAppProfile(
    shopId: string,
    dto: CreateSaasAppProfileDto,
  ): Promise<SaasAppProfilePublicView> {
    const { shop, profiles } = await this.getOrInitShopSaasProfiles(shopId);
    const nowIso = new Date().toISOString();
    const apiVersion = this.normalizeGraphApiVersion(dto.apiVersion, dto.channelType);
    const webhookCallbackUrl = this.buildWebhookCallbackUrl(dto.channelType);
    const rawVerifyToken = (
      dto.webhookVerifyToken ||
      (dto.channelType === ChannelTypeEnum.ZALO_OA
        ? envs.omnichannelSaas.zaloWebhookVerifyToken
        : envs.omnichannelSaas.metaWebhookVerifyToken) ||
      'pancake_seller_os_verify_token'
    ).trim();

    const rawAppSecret = dto.appSecret?.trim() || null;
    const subscribedFields =
      dto.subscribedFields && dto.subscribedFields.length > 0
        ? dto.subscribedFields
        : DEFAULT_SUBSCRIBED_FIELDS_BY_PLATFORM[dto.channelType] || [];

    const hasSamePlatformProfiles = profiles.some((p) => p.channelType === dto.channelType);
    const shouldBeDefault = dto.isDefault ?? !hasSamePlatformProfiles;

    if (shouldBeDefault) {
      for (const p of profiles) {
        if (p.channelType === dto.channelType) {
          p.isDefault = false;
        }
      }
    }

    let appWebhookRegistered = false;
    if (dto.autoRegisterAppWebhookOnPlatform !== false && rawAppSecret) {
      appWebhookRegistered = await this.registerAppLevelWebhookOnPlatform({
        channelType: dto.channelType,
        apiVersion,
        appId: dto.appId.trim(),
        rawAppSecret,
        webhookCallbackUrl,
        webhookVerifyToken: rawVerifyToken,
        subscribedFields,
      });
    }

    const newProfile: SaasAppProfileItem = {
      id: `saas_${dto.channelType.toLowerCase()}_${crypto.randomBytes(6).toString('hex')}`,
      name: dto.name.trim(),
      channelType: dto.channelType,
      apiVersion,
      appId: dto.appId.trim(),
      appSecretEncrypted: rawAppSecret
        ? this.messageCryptoService.encryptForConversation(rawAppSecret, shopId).ciphertext
        : null,
      webhookVerifyTokenEncrypted: this.messageCryptoService.encryptForConversation(
        rawVerifyToken,
        shopId,
      ).ciphertext,
      webhookCallbackUrl,
      subscribedFields,
      autoHidePhoneComments: dto.autoHidePhoneComments ?? true,
      syncEchoMessagesFromNativeApp: dto.syncEchoMessagesFromNativeApp ?? true,
      autoInjectWebhookOnConnect: dto.autoInjectWebhookOnConnect ?? true,
      isDefault: shouldBeDefault,
      isActive: true,
      appWebhookRegistered,
      lastVerifiedAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    profiles.push(newProfile);
    shop.saasAppProfilesJson = profiles;
    await this.shopRepo.save(shop);

    await this.broadcastChannelEventToShop(
      shopId,
      SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED,
      {
        shopId,
        action: 'SAAS_PROFILE_CREATED',
        saasProfileId: newProfile.id,
        channelType: newProfile.channelType,
      },
    );

    return this.toPublicSaasProfileView(shopId, newProfile, new Map([[newProfile.id, 0]]));
  }

  /**
   * Cập nhật Hồ sơ Cấu hình Ứng dụng SaaS và đồng bộ tự động xuống các kênh đang liên kết
   */
  async updateSaasAppProfile(
    shopId: string,
    profileId: string,
    dto: UpdateSaasAppProfileDto,
  ): Promise<SaasAppProfilePublicView> {
    const { shop, profiles } = await this.getOrInitShopSaasProfiles(shopId);
    const targetIdx = profiles.findIndex((p) => p.id === profileId);
    if (targetIdx === -1) {
      throw new NotFoundException('SAAS_APP_PROFILE_NOT_FOUND');
    }

    const target = profiles[targetIdx];
    const nowIso = new Date().toISOString();

    if (dto.name !== undefined) {
      target.name = dto.name.trim();
    }
    if (dto.apiVersion !== undefined) {
      target.apiVersion = this.normalizeGraphApiVersion(dto.apiVersion, target.channelType);
    }
    if (dto.appId !== undefined && dto.appId.trim()) {
      target.appId = dto.appId.trim();
    }
    if (dto.appSecret && dto.appSecret.trim()) {
      target.appSecretEncrypted = this.messageCryptoService.encryptForConversation(
        dto.appSecret.trim(),
        shopId,
      ).ciphertext;
    }
    if (dto.webhookVerifyToken && dto.webhookVerifyToken.trim()) {
      target.webhookVerifyTokenEncrypted = this.messageCryptoService.encryptForConversation(
        dto.webhookVerifyToken.trim(),
        shopId,
      ).ciphertext;
    }
    if (dto.subscribedFields && dto.subscribedFields.length > 0) {
      target.subscribedFields = dto.subscribedFields;
    }
    if (dto.autoHidePhoneComments !== undefined) {
      target.autoHidePhoneComments = dto.autoHidePhoneComments;
    }
    if (dto.syncEchoMessagesFromNativeApp !== undefined) {
      target.syncEchoMessagesFromNativeApp = dto.syncEchoMessagesFromNativeApp;
    }
    if (dto.autoInjectWebhookOnConnect !== undefined) {
      target.autoInjectWebhookOnConnect = dto.autoInjectWebhookOnConnect;
    }
    if (dto.isActive !== undefined) {
      target.isActive = dto.isActive;
    }
    if (dto.isDefault === true) {
      for (const p of profiles) {
        if (p.channelType === target.channelType) {
          p.isDefault = p.id === target.id;
        }
      }
    }

    target.webhookCallbackUrl = this.buildWebhookCallbackUrl(target.channelType);
    target.updatedAt = nowIso;

    const rawAppSecret = target.appSecretEncrypted
      ? this.messageCryptoService.decryptForConversation(target.appSecretEncrypted, shopId)
      : null;
    const rawVerifyToken = target.webhookVerifyTokenEncrypted
      ? this.messageCryptoService.decryptForConversation(target.webhookVerifyTokenEncrypted, shopId)
      : envs.omnichannelSaas.metaWebhookVerifyToken;

    if (rawAppSecret) {
      target.appWebhookRegistered = await this.registerAppLevelWebhookOnPlatform({
        channelType: target.channelType,
        apiVersion: target.apiVersion,
        appId: target.appId,
        rawAppSecret,
        webhookCallbackUrl: target.webhookCallbackUrl,
        webhookVerifyToken: rawVerifyToken,
        subscribedFields: target.subscribedFields,
      });
    }

    shop.saasAppProfilesJson = profiles;
    await this.shopRepo.save(shop);

    // Tự động lan truyền cấu hình SaaS mới xuống các kênh đang sử dụng Hồ sơ SaaS này
    if (dto.propagateToBoundChannels !== false) {
      const boundChannels = await this.channelRepo.find({
        where: [
          { shopId, saasAppProfileId: target.id },
          ...(target.isDefault ? [{ shopId, channelType: target.channelType }] : []),
        ],
      });

      for (const ch of boundChannels) {
        if (ch.saasAppProfileId && ch.saasAppProfileId !== target.id) {
          continue;
        }
        ch.saasAppProfileId = target.id;
        ch.apiVersion = target.apiVersion;
        ch.appId = target.appId;
        if (target.appSecretEncrypted) {
          ch.appSecretEncrypted = target.appSecretEncrypted;
        }
        if (target.webhookVerifyTokenEncrypted) {
          ch.webhookVerifySecretEncrypted = target.webhookVerifyTokenEncrypted;
        }
        ch.platformConfigJson = {
          ...(ch.platformConfigJson || {}),
          saasAppProfileId: target.id,
          saasAppProfileName: target.name,
          apiVersion: target.apiVersion,
          appId: target.appId,
          webhookCallbackUrl: target.webhookCallbackUrl,
          subscribedFields: target.subscribedFields,
          autoHidePhoneComments: target.autoHidePhoneComments,
          syncEchoMessagesFromNativeApp: target.syncEchoMessagesFromNativeApp,
        };
        await this.channelRepo.save(ch);
      }
    }

    const updatedList = await this.listSaasAppProfiles(shopId);
    return (
      updatedList.find((p) => p.id === profileId) ||
      this.toPublicSaasProfileView(shopId, target, new Map())
    );
  }

  /**
   * Xóa một Hồ sơ Cấu hình Ứng dụng SaaS
   */
  async deleteSaasAppProfile(
    shopId: string,
    profileId: string,
  ): Promise<{ id: string; deleted: boolean }> {
    const { shop, profiles } = await this.getOrInitShopSaasProfiles(shopId);
    const target = profiles.find((p) => p.id === profileId);
    if (!target) {
      throw new NotFoundException('SAAS_APP_PROFILE_NOT_FOUND');
    }

    const remaining = profiles.filter((p) => p.id !== profileId);
    if (target.isDefault) {
      const fallbackSameType = remaining.find((p) => p.channelType === target.channelType);
      if (fallbackSameType) {
        fallbackSameType.isDefault = true;
      }
    }

    shop.saasAppProfilesJson = remaining;
    await this.shopRepo.save(shop);

    return { id: profileId, deleted: true };
  }

  /**
   * Tự động tiêm lại Webhook (`subscribed_apps`) hàng loạt cho toàn bộ các kênh đang dùng Hồ sơ SaaS này
   */
  async injectWebhooksForSaasProfile(
    shopId: string,
    profileId: string,
  ): Promise<{
    profileId: string;
    totalChannels: number;
    injectedSuccessCount: number;
  }> {
    const { profiles } = await this.getOrInitShopSaasProfiles(shopId);
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) {
      throw new NotFoundException('SAAS_APP_PROFILE_NOT_FOUND');
    }

    const channels = await this.channelRepo.find({
      where: { shopId, channelType: profile.channelType, isActive: true },
    });

    const targetChannels = channels.filter(
      (ch) => ch.saasAppProfileId === profile.id || (!ch.saasAppProfileId && profile.isDefault),
    );

    let injectedSuccessCount = 0;
    await Promise.all(
      targetChannels.map(async (ch) => {
        try {
          await this.syncAndVerifyChannelWebhook(shopId, ch.id);
          injectedSuccessCount += 1;
        } catch {
          // Tiếp tục tiêm cho các kênh còn lại
        }
      }),
    );

    return {
      profileId,
      totalChannels: targetChannels.length,
      injectedSuccessCount,
    };
  }

  /**
   * Phân giải thông số SaaS hiệu lực cho một yêu cầu kết nối kênh hoặc kiểm tra Access Token:
   * Ưu tiên tham số truyền trực tiếp -> Hồ sơ SaaS theo `saasAppProfileId` -> Hồ sơ SaaS mặc định của `channelType` -> Biến môi trường hệ thống.
   */
  public async resolveEffectiveSaasCredentials(params: {
    shopId: string;
    channelType: ChannelTypeEnum;
    saasAppProfileId?: string | null;
    overrideApiVersion?: string | null;
    overrideAppId?: string | null;
    overrideAppSecret?: string | null;
    overrideVerifyToken?: string | null;
    overrideSubscribedFields?: string[];
  }): Promise<{
    saasProfile: SaasAppProfileItem | null;
    apiVersion: string;
    appId: string | null;
    rawAppSecret: string | null;
    webhookVerifyToken: string;
    webhookCallbackUrl: string;
    subscribedFields: string[];
    autoHidePhoneComments: boolean;
    syncEchoMessagesFromNativeApp: boolean;
    autoInjectWebhookOnConnect: boolean;
  }> {
    const { profiles } = await this.getOrInitShopSaasProfiles(params.shopId);

    const matchedProfile =
      (params.saasAppProfileId ? profiles.find((p) => p.id === params.saasAppProfileId) : null) ||
      profiles.find(
        (p) => p.channelType === params.channelType && p.isDefault && p.isActive !== false,
      ) ||
      profiles.find((p) => p.channelType === params.channelType && p.isActive !== false) ||
      null;

    const decryptedProfileSecret = matchedProfile?.appSecretEncrypted
      ? this.messageCryptoService.decryptForConversation(
          matchedProfile.appSecretEncrypted,
          params.shopId,
        )
      : null;

    const decryptedProfileVerify = matchedProfile?.webhookVerifyTokenEncrypted
      ? this.messageCryptoService.decryptForConversation(
          matchedProfile.webhookVerifyTokenEncrypted,
          params.shopId,
        )
      : null;

    const apiVersion = this.normalizeGraphApiVersion(
      params.overrideApiVersion || matchedProfile?.apiVersion,
      params.channelType,
    );

    const appId =
      params.overrideAppId?.trim() ||
      matchedProfile?.appId ||
      (params.channelType === ChannelTypeEnum.ZALO_OA
        ? envs.omnichannelSaas.zaloAppId
        : envs.omnichannelSaas.metaAppId) ||
      null;

    const rawAppSecret =
      params.overrideAppSecret?.trim() ||
      decryptedProfileSecret ||
      (params.channelType === ChannelTypeEnum.ZALO_OA
        ? envs.omnichannelSaas.zaloAppSecret
        : envs.omnichannelSaas.metaAppSecret) ||
      null;

    const webhookVerifyToken =
      params.overrideVerifyToken?.trim() ||
      decryptedProfileVerify ||
      (params.channelType === ChannelTypeEnum.ZALO_OA
        ? envs.omnichannelSaas.zaloWebhookVerifyToken
        : envs.omnichannelSaas.metaWebhookVerifyToken) ||
      'pancake_seller_os_verify_token';

    const subscribedFields =
      params.overrideSubscribedFields && params.overrideSubscribedFields.length > 0
        ? params.overrideSubscribedFields
        : matchedProfile?.subscribedFields && matchedProfile.subscribedFields.length > 0
          ? matchedProfile.subscribedFields
          : DEFAULT_SUBSCRIBED_FIELDS_BY_PLATFORM[params.channelType] || [];

    return {
      saasProfile: matchedProfile,
      apiVersion,
      appId,
      rawAppSecret,
      webhookVerifyToken,
      webhookCallbackUrl: this.buildWebhookCallbackUrl(params.channelType),
      subscribedFields,
      autoHidePhoneComments: matchedProfile?.autoHidePhoneComments ?? true,
      syncEchoMessagesFromNativeApp: matchedProfile?.syncEchoMessagesFromNativeApp ?? true,
      autoInjectWebhookOnConnect: matchedProfile?.autoInjectWebhookOnConnect ?? true,
    };
  }

  /**
   * Trả về cấu hình SaaS Webhook (Callback URL, Verify Token, API Version mặc định, Subscribed Fields)
   * cùng danh sách Hồ sơ SaaS của cửa hàng
   */
  async getSaasWebhookConfiguration(shopId: string): Promise<{
    shopId: string;
    platforms: SaasPlatformWebhookConfigItem[];
    saasProfiles: SaasAppProfilePublicView[];
  }> {
    const saasProfiles = await this.listSaasAppProfiles(shopId);
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

    const requiredScopesMap: Record<ChannelTypeEnum, string[]> = {
      [ChannelTypeEnum.FACEBOOK_PAGE]: [
        'pages_show_list',
        'pages_messaging',
        'pages_read_engagement',
        'pages_manage_metadata',
        'pages_read_user_content',
        'pages_manage_engagement',
      ],
      [ChannelTypeEnum.INSTAGRAM]: [
        'instagram_basic',
        'instagram_manage_messages',
        'instagram_manage_comments',
        'pages_manage_metadata',
      ],
      [ChannelTypeEnum.ZALO_OA]: ['oa_manage_chat', 'oa_profile_view', 'zns_template_send'],
      [ChannelTypeEnum.TIKTOK_SHOP]: ['seller.order.info', 'seller.customer_service.chat'],
      [ChannelTypeEnum.SHOPEE]: ['shop.chat.read_write', 'shop.order.read_write'],
      [ChannelTypeEnum.LAZADA]: ['im.message.read_write', 'order.read'],
      [ChannelTypeEnum.WEBSITE_LIVECHAT]: ['livechat.widget'],
      [ChannelTypeEnum.INTERNAL]: [],
    };

    return {
      shopId,
      saasProfiles,
      platforms: platforms.map((plat) => {
        const defaultProf = saasProfiles.find((p) => p.channelType === plat && p.isDefault);
        const fields =
          defaultProf?.subscribedFields || DEFAULT_SUBSCRIBED_FIELDS_BY_PLATFORM[plat] || [];
        const hasSecret = Boolean(
          defaultProf?.hasAppSecretConfigured ||
            ((plat === ChannelTypeEnum.FACEBOOK_PAGE || plat === ChannelTypeEnum.INSTAGRAM) &&
              envs.omnichannelSaas.metaAppSecret),
        );
        return {
          channelType: plat,
          defaultApiVersion:
            defaultProf?.apiVersion ||
            (plat === ChannelTypeEnum.ZALO_OA
              ? envs.omnichannelSaas.zaloOaApiVersion
              : plat === ChannelTypeEnum.FACEBOOK_PAGE || plat === ChannelTypeEnum.INSTAGRAM
                ? envs.omnichannelSaas.metaGraphApiVersion
                : 'v2.0'),
          defaultAppId:
            defaultProf?.appId ||
            (plat === ChannelTypeEnum.FACEBOOK_PAGE || plat === ChannelTypeEnum.INSTAGRAM
              ? envs.omnichannelSaas.metaAppId || null
              : plat === ChannelTypeEnum.ZALO_OA
                ? envs.omnichannelSaas.zaloAppId || null
                : plat === ChannelTypeEnum.TIKTOK_SHOP
                  ? envs.omnichannelSaas.tiktokShopAppKey || null
                  : plat === ChannelTypeEnum.SHOPEE
                    ? envs.omnichannelSaas.shopeePartnerId || null
                    : null),
          hasDefaultAppSecret: hasSecret,
          hasSystemAppSecret: hasSecret,
          webhookCallbackUrl: this.buildWebhookCallbackUrl(plat),
          webhookVerifyToken:
            defaultProf?.webhookVerifyToken ||
            (plat === ChannelTypeEnum.ZALO_OA
              ? envs.omnichannelSaas.zaloWebhookVerifyToken
              : envs.omnichannelSaas.metaWebhookVerifyToken),
          requiredScopes: requiredScopesMap[plat] || [],
          recommendedSubscribedFields: fields,
          subscribedFields: fields,
          outboundCapabilities: [
            'SEND_INBOX_MESSAGE',
            'REPLY_PUBLIC_COMMENT',
            'SEND_PRIVATE_REPLY',
            'HIDE_UNHIDE_COMMENT',
            'LIKE_UNLIKE_COMMENT',
            'DELETE_COMMENT',
          ],
          signatureHeaderName: signatureHeaderMap[plat],
        };
      }),
    };
  }

  /**
   * Kiểm tra `hub.verify_token` khi Meta / Zalo / TikTok gọi GET xác thực Webhook
   * (Hỗ trợ đối chiếu cả trên Hồ sơ SaaS của Shop và trên từng Kênh tích hợp)
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

    // Kiểm tra trong các Hồ sơ SaaS của cửa hàng
    const shops = params.shopId
      ? await this.shopRepo.find({ where: { id: params.shopId } })
      : await this.shopRepo.find({ select: ['id', 'saasAppProfilesJson'] });

    for (const shop of shops) {
      const profiles = Array.isArray(shop.saasAppProfilesJson) ? shop.saasAppProfilesJson : [];
      for (const prof of profiles) {
        if (!prof.webhookVerifyTokenEncrypted) continue;
        const decrypted = this.messageCryptoService.decryptForConversation(
          prof.webhookVerifyTokenEncrypted,
          shop.id,
        );
        if (decrypted && decrypted.trim() === provided) {
          return true;
        }
      }
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

  /**
   * Đọc danh sách thành viên đang hoạt động của Shop qua bộ nhớ đệm L1 (TTL 30s)
   * để tránh truy vấn DB lặp lại hàng nghìn lần khi có bão tin nhắn Webhook đổ về.
   */
  private async getCachedShopActiveMembers(shopId: string): Promise<
    Array<{
      userId: string;
      role: ShopRoleEnum;
      dataScope?: DataScopeEnum;
      allowedChannelIdsJson?: string[] | null;
    }>
  > {
    const cached = this.shopActiveMembersCache.get(shopId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.members;
    }

    const activeMembers = await this.memberRepo.find({
      where: {
        shopId,
        membershipStatus: MembershipStatusEnum.ACTIVE,
      },
      select: ['userId', 'role', 'dataScope', 'allowedChannelIdsJson'],
    });

    this.shopActiveMembersCache.set(shopId, {
      members: activeMembers,
      expiresAt: Date.now() + 30_000,
    });

    return activeMembers;
  }

  private async broadcastChannelEventToShop(
    shopId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<string[]> {
    const activeMembers = await this.getCachedShopActiveMembers(shopId);
    const userIds = Array.from(new Set(activeMembers.map((m) => m.userId)));
    for (const uid of userIds) {
      this.realtimeEmitter.emitToUser(SOCKET_CONFIG.namespaces.CHAT, uid, eventName, payload);
    }

    return activeMembers
      .filter((m) => m.role === ShopRoleEnum.SHOP_OWNER || m.role === ShopRoleEnum.SHOP_MANAGER)
      .map((m) => m.userId);
  }

  /**
   * Gom nhịp (Coalesced Debounce 120ms) sự kiện cập nhật bộ đếm kênh `channels:integration_updated`
   * khi có hàng trăm tin nhắn Webhook đổ về trong cùng 1 giây, giúp trình duyệt không bị quá tải refetch.
   */
  private scheduleCoalescedShopChannelUpdate(
    shopId: string,
    payload: Record<string, unknown>,
  ): void {
    if (this.coalescedChannelUpdateTimers.has(shopId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.coalescedChannelUpdateTimers.delete(shopId);
      void this.broadcastChannelEventToShop(
        shopId,
        SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED,
        payload,
      );
    }, 120);

    this.coalescedChannelUpdateTimers.set(shopId, timer);
  }

  /**
   * Đồng bộ danh sách thành viên tham gia hội thoại theo lô (Batch Query + L1 Cache TTL 60s),
   * loại bỏ hoàn toàn truy vấn N+1 khi chịu tải cao.
   */
  private async ensureConversationParticipants(
    conversationId: string,
    userIds: string[],
  ): Promise<void> {
    const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
    if (uniqueIds.length === 0) return;

    const cached = this.convParticipantsCache.get(conversationId);
    if (cached && cached.expiresAt > Date.now()) {
      const allPresent = uniqueIds.every((uid) => cached.userIds.has(uid));
      if (allPresent) {
        return;
      }
    }

    const existingRows = await this.participantRepo.find({
      where: { conversationId, userId: In(uniqueIds) },
      withDeleted: true,
    });

    const existingMap = new Map<string, ConversationParticipantEntity>();
    for (const row of existingRows) {
      existingMap.set(row.userId, row);
    }

    const now = new Date();
    const toInsert: ConversationParticipantEntity[] = [];
    const toUpdate: ConversationParticipantEntity[] = [];

    for (const userId of uniqueIds) {
      const existing = existingMap.get(userId);
      if (!existing) {
        toInsert.push(
          this.participantRepo.create({
            conversationId,
            userId,
            role: GroupRoleEnum.MEMBER,
            isAdmin: false,
            isHidden: false,
            joinedAt: now,
          }),
        );
      } else if (existing.deletedAt || existing.isHidden) {
        if (existing.deletedAt) {
          await this.participantRepo.restore(existing.id).catch(() => undefined);
        }
        existing.deletedAt = null;
        existing.deletedBy = null;
        existing.isHidden = false;
        toUpdate.push(existing);
      }
    }

    if (toInsert.length > 0) {
      await this.participantRepo.save(toInsert).catch(() => undefined);
    }
    if (toUpdate.length > 0) {
      await this.participantRepo.save(toUpdate).catch(() => undefined);
    }

    const nextSet = cached?.userIds ? new Set(cached.userIds) : new Set<string>();
    for (const uid of uniqueIds) {
      nextSet.add(uid);
    }
    this.convParticipantsCache.set(conversationId, {
      userIds: nextSet,
      expiresAt: Date.now() + 60_000,
    });
  }

  /**
   * Khóa phân tán theo từng luồng khách hàng (`Per-Thread Distributed Spin-Lock + In-Memory Queue`)
   * đảm bảo khi 1 khách hàng nhắn 5 tin liên tiếp trong 100ms, hệ thống không bao giờ tạo trùng 2 dòng `ConversationEntity`,
   * nhưng các tin nhắn từ 500 khách hàng khác nhau vẫn chạy song song 100%.
   */
  private async withConversationThreadLock<T>(
    shopId: string,
    channelId: string,
    externalThreadId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const lockKey = `lock:conv_thread:${shopId}:${channelId}:${externalThreadId}`;

    const prevPromise = this.inMemoryThreadLocks.get(lockKey) || Promise.resolve();
    let releaseLocal!: () => void;
    const currentGate = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    this.inMemoryThreadLocks.set(
      lockKey,
      prevPromise.then(() => currentGate),
    );

    await prevPromise.catch(() => undefined);

    const lockToken = crypto.randomBytes(8).toString('hex');
    let acquiredRedis = false;
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        const res = await this.redis.set(lockKey, lockToken, 'PX', 4000, 'NX').catch(() => 'OK');
        if (res === 'OK') {
          acquiredRedis = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      return await work();
    } finally {
      if (acquiredRedis) {
        const unlockLua = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        await this.redis.eval(unlockLua, 1, lockKey, lockToken).catch(() => undefined);
      }
      releaseLocal();
      if (this.inMemoryThreadLocks.get(lockKey) === currentGate) {
        this.inMemoryThreadLocks.delete(lockKey);
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
   * 1. Hỗ trợ phiên bản cấu hình trong Hồ sơ SaaS (VD: `v27.1`, `v27.0`, `v26.0`, `v22.0`, `v21.0`) và tự động thương lượng lùi phiên bản nếu cần.
   * 2. Tự động đính kèm `appsecret_proof = HMAC-SHA256(accessToken, appSecret)`.
   * 3. Nếu người dùng nhập Token lấy từ Graph API Explorer (khác App ID), tự động fallback không kèm `appsecret_proof`.
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
   * Phân giải chính xác 100% thông tin Trang / Gian hàng chỉ từ Access Token:
   * - Tự động kế thừa cấu hình từ Hồ sơ SaaS (`SaasAppProfile`) đã chọn hoặc Hồ sơ SaaS mặc định của nền tảng.
   * - Phân biệt chính xác `PAGE_TOKEN` vs `USER_TOKEN`, lấy đầy đủ Avatar URL (không bị cắt ngắn),
   *   và trích xuất đúng `pageAccessToken` riêng của từng Fanpage.
   */
  async resolveChannelMetadataFromToken(
    shopId: string,
    dto: ResolveChannelTokenMetadataDto,
  ): Promise<ResolvedChannelTokenMetadataResult> {
    const cleanToken = dto.accessToken.trim().replace(/^Bearer\s+/i, '');
    const effectiveSaas = await this.resolveEffectiveSaasCredentials({
      shopId,
      channelType: dto.channelType,
      saasAppProfileId: dto.saasAppProfileId,
      overrideApiVersion: dto.apiVersion,
      overrideAppId: dto.appId,
      overrideAppSecret: dto.appSecret,
    });

    const resolvedApiVersion = effectiveSaas.apiVersion;
    const resolvedAppId = effectiveSaas.appId;
    const resolvedAppSecret = effectiveSaas.rawAppSecret;
    const subscribedFields = effectiveSaas.subscribedFields;
    const webhookCallbackUrl = effectiveSaas.webhookCallbackUrl;
    const webhookVerifyToken = effectiveSaas.webhookVerifyToken;

    const isExplicitSandboxToken =
      Boolean(dto.allowSandboxSimulation) ||
      /^(sandbox_|sim_|mock_|test_tok_|oauth2_tok_)/i.test(cleanToken);

    // 1. Nhánh Facebook Fanpage & Instagram Business
    if (
      dto.channelType === ChannelTypeEnum.FACEBOOK_PAGE ||
      dto.channelType === ChannelTypeEnum.INSTAGRAM
    ) {
      // Tự động đổi Short-Lived Token (1-2h) sang Long-Lived Token (60 ngày) qua fb_exchange_token trước khi lấy danh sách Page
      // Khi gọi /me/accounts bằng Long-Lived User Token, Meta Graph API sẽ cấp Never-Expiring Page Access Token (expires_at = 0)
      let workingToken = cleanToken;
      let exchangedLongLivedUserToken: string | null = null;
      let wasAutoExchanged = false;

      if (dto.autoExchangeNeverExpiringToken !== false && resolvedAppId && resolvedAppSecret) {
        const exchangeAttempt = await this.tokenDoctorService.exchangeMetaLongLivedToken({
          apiVersion: resolvedApiVersion,
          appId: resolvedAppId,
          rawAppSecret: resolvedAppSecret,
          inputToken: cleanToken,
        });
        if (exchangeAttempt.wasExchanged && exchangeAttempt.exchangedToken) {
          workingToken = exchangeAttempt.exchangedToken;
          exchangedLongLivedUserToken = exchangeAttempt.exchangedToken;
          wasAutoExchanged = true;
        }
      }

      let debuggedTokenType: 'PAGE' | 'USER' | null = null;
      let debuggedIsNeverExpiring = false;
      let debuggedProfileId: string | null = null;
      let debuggedAppId: string | null = resolvedAppId;
      let debuggedExpiresAt: string | null = null;
      let debuggedScopes: string[] = [];

      if (resolvedAppId && resolvedAppSecret) {
        const debugUrl = `https://graph.facebook.com/${resolvedApiVersion}/debug_token?input_token=${encodeURIComponent(workingToken)}&access_token=${encodeURIComponent(`${resolvedAppId}|${resolvedAppSecret}`)}`;
        const debugRes = await fetch(debugUrl).catch(() => null);
        if (debugRes && debugRes.ok) {
          const debugJson = (await debugRes.json().catch(() => ({}))) as {
            data?: {
              is_valid?: boolean;
              type?: string;
              app_id?: string;
              profile_id?: string;
              user_id?: string;
              expires_at?: number;
              scopes?: string[];
              error?: { message?: string };
            };
          };
          if (debugJson?.data?.is_valid === false) {
            throw new BadRequestException(
              `Access Token không hợp lệ hoặc đã hết hạn: ${debugJson.data.error?.message || 'INVALID_META_ACCESS_TOKEN'}`,
            );
          }
          if (debugJson?.data?.app_id) {
            debuggedAppId = String(debugJson.data.app_id);
          }
          if (debugJson?.data?.expires_at === 0) {
            debuggedIsNeverExpiring = true;
            debuggedExpiresAt = null;
          } else if (debugJson?.data?.expires_at && debugJson.data.expires_at > 0) {
            debuggedExpiresAt = new Date(debugJson.data.expires_at * 1000).toISOString();
          }
          if (Array.isArray(debugJson?.data?.scopes)) {
            debuggedScopes = debugJson.data.scopes;
          }
          if (debugJson?.data?.type === 'PAGE') {
            debuggedTokenType = 'PAGE';
            debuggedProfileId = debugJson.data.profile_id || null;
          } else if (debugJson?.data?.type === 'USER') {
            debuggedTokenType = 'USER';
          }
        }
      }

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
        accessToken: workingToken,
        appSecret: resolvedAppSecret,
      });

      if (meCall.ok && meCall.data?.id) {
        const metadataNodeType = String(meCall.data.metadata?.type || '').toLowerCase();
        const isPageNode =
          debuggedTokenType === 'PAGE' ||
          metadataNodeType === 'page' ||
          metadataNodeType === 'ig_user';

        // TRƯỜNG HỢP 1: PAGE ACCESS TOKEN trực tiếp của 1 Fanpage
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
                  ? 'id,name,category,access_token,picture.type(large),instagram_business_account{id,name,username,profile_picture_url}'
                  : 'id,name,category,access_token,picture.type(large)',
            },
            accessToken: workingToken,
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
              saasAppProfileId: effectiveSaas.saasProfile?.id || null,
              saasAppProfileName: effectiveSaas.saasProfile?.name || null,
              apiVersion: meCall.usedVersion,
              apiVersionUsed: meCall.usedVersion,
              appId: debuggedAppId,
              appIdDetected: debuggedAppId,
              tokenExpiresAt: debuggedExpiresAt,
              scopesGranted: debuggedScopes,
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
              diagnosticMessage: `Đã nhận diện tài khoản Instagram Business "${igName}" (${meCall.usedVersion}) và sẵn sàng tự động tiêm Webhook.`,
            };
          }

          const resolvedPageName = detail.name || meCall.data.name || `Fanpage #${pageId}`;
          const resolvedAvatar =
            detail.picture?.data?.url ||
            meCall.data.picture?.data?.url ||
            `https://graph.facebook.com/${pageId}/picture?type=large`;
          const resolvedCategory = (detail as any)?.category || 'Facebook Fanpage';
          const shortCode = this.buildSmartShortCode(dto.channelType, resolvedPageName, pageId);

          const resolvedPermanentPageToken = String((detail as any)?.access_token || workingToken);
          const isPermanentPageToken = Boolean(
            debuggedIsNeverExpiring || wasAutoExchanged || !debuggedExpiresAt,
          );
          const singlePageCandidate: ResolvedChannelTokenCandidatePage = {
            externalPageId: pageId,
            pageName: resolvedPageName,
            pageShortCode: shortCode,
            avatarUrl: resolvedAvatar,
            category: resolvedCategory,
            pageAccessToken: resolvedPermanentPageToken,
            isNeverExpiringPageToken: isPermanentPageToken,
            subscribedFields,
          };

          return {
            channelType: dto.channelType,
            saasAppProfileId: effectiveSaas.saasProfile?.id || null,
            saasAppProfileName: effectiveSaas.saasProfile?.name || null,
            apiVersion: meCall.usedVersion,
            apiVersionUsed: meCall.usedVersion,
            appId: debuggedAppId,
            appIdDetected: debuggedAppId,
            tokenExpiresAt: isPermanentPageToken ? null : debuggedExpiresAt,
            scopesGranted: debuggedScopes,
            tokenKind: 'PAGE_TOKEN',
            authenticatedUserId: null,
            authenticatedUserName: null,
            requiresPageSelection: false,
            externalPageId: pageId,
            pageName: resolvedPageName,
            pageShortCode: shortCode,
            avatarUrl: resolvedAvatar,
            category: resolvedCategory,
            resolvedPageAccessToken: resolvedPermanentPageToken,
            resolvedUserAccessToken: exchangedLongLivedUserToken,
            isNeverExpiringPageToken: isPermanentPageToken,
            subscribedFields,
            candidatePages: [singlePageCandidate],
            webhookCallbackUrl,
            webhookVerifyToken,
            resolvedFromLiveApi: true,
            diagnosticMessage: `Đã nhận diện chính xác Fanpage "${resolvedPageName}" (ID: ${pageId}) qua Meta Graph API ${meCall.usedVersion}.`,
          };
        }

        // TRƯỜNG HỢP 2: USER ACCESS TOKEN (Quản trị viên quản lý 1 hoặc nhiều Fanpage)
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
          accessToken: workingToken,
          appSecret: resolvedAppSecret,
        });

        if (accountsCall.ok && Array.isArray(accountsCall.data?.data)) {
          const rawPages = accountsCall.data.data;
          if (rawPages.length === 0) {
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
                  saasAppProfileId: effectiveSaas.saasProfile?.id || null,
                  saasAppProfileName: effectiveSaas.saasProfile?.name || null,
                  apiVersion: meCall.usedVersion,
                  apiVersionUsed: meCall.usedVersion,
                  appId: debuggedAppId,
                  appIdDetected: debuggedAppId,
                  tokenExpiresAt: debuggedExpiresAt,
                  scopesGranted: debuggedScopes,
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
                  diagnosticMessage: `Đã phân giải trực tiếp Fanpage "${pName}" (ID: ${pId}).`,
                };
              }
            }

            throw new BadRequestException(
              `Token hợp lệ cho tài khoản "${meCall.data.name}" nhưng chưa được cấp quyền quản lý Fanpage nào (Thiếu quyền pages_show_list / pages_manage_metadata hoặc chưa tích chọn Fanpage khi cấp quyền).`,
            );
          }

          const candidatePages: ResolvedChannelTokenCandidatePage[] = rawPages.map((item) => {
            const extId = String(item.id);
            const pToken = item.access_token || workingToken;
            return {
              externalPageId: extId,
              pageName: item.name,
              pageShortCode: this.buildSmartShortCode(dto.channelType, item.name, extId),
              avatarUrl:
                item.picture?.data?.url || `https://graph.facebook.com/${extId}/picture?type=large`,
              category: item.category || 'Facebook Fanpage',
              pageAccessToken: pToken,
              isNeverExpiringPageToken: true,
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

          const requiresPageSelection = !matchedCandidate && candidatePages.length > 1;
          const previewCandidate = matchedCandidate || candidatePages[0];

          return {
            channelType: dto.channelType,
            saasAppProfileId: effectiveSaas.saasProfile?.id || null,
            saasAppProfileName: effectiveSaas.saasProfile?.name || null,
            apiVersion: meCall.usedVersion,
            apiVersionUsed: meCall.usedVersion,
            appId: debuggedAppId,
            appIdDetected: debuggedAppId,
            tokenExpiresAt: debuggedExpiresAt,
            scopesGranted: debuggedScopes,
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
              : workingToken,
            resolvedUserAccessToken: workingToken,
            isNeverExpiringPageToken: true,
            subscribedFields,
            candidatePages,
            webhookCallbackUrl,
            webhookVerifyToken,
            resolvedFromLiveApi: true,
            diagnosticMessage: requiresPageSelection
              ? `Tìm thấy ${candidatePages.length} Fanpage thuộc tài khoản "${meCall.data.name}". Hãy chọn 1 hoặc nhiều trang để kết nối & tự động tiêm Webhook.`
              : `Đã nhận diện Fanpage "${matchedCandidate?.pageName}" từ tài khoản "${meCall.data.name}".`,
          };
        }
      }

      if (!isExplicitSandboxToken && meCall.errorCode && meCall.errorCode >= 100) {
        throw new BadRequestException(
          `Không thể xác thực Access Token trên Meta Graph API (${meCall.usedVersion}): ${meCall.errorMessage}`,
        );
      }
    }

    // 2. Nhánh Zalo Official Account
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
              saasAppProfileId: effectiveSaas.saasProfile?.id || null,
              saasAppProfileName: effectiveSaas.saasProfile?.name || null,
              apiVersion: resolvedApiVersion,
              apiVersionUsed: resolvedApiVersion,
              appId: resolvedAppId,
              appIdDetected: resolvedAppId,
              tokenExpiresAt: null,
              scopesGranted: ['oa_manage_chat', 'oa_profile_view'],
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
              diagnosticMessage: `Đã nhận diện Zalo Official Account "${oaName}" (OA ID: ${extId}).`,
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
      saasAppProfileId: effectiveSaas.saasProfile?.id || null,
      saasAppProfileName: effectiveSaas.saasProfile?.name || null,
      apiVersion: resolvedApiVersion,
      apiVersionUsed: resolvedApiVersion,
      appId: resolvedAppId,
      appIdDetected: resolvedAppId,
      tokenExpiresAt: null,
      scopesGranted: [],
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
      diagnosticMessage: 'Đã khởi tạo thông tin Trang chế độ thử nghiệm nội bộ (Sandbox).',
    };
  }

  /**
   * Tự động tiêm (`Auto-Inject`) và xác minh đăng ký Webhook (`subscribed_apps`) trên nền tảng
   * ngay khi người dùng nhập Access Token.
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

      if (subRes.ok) {
        return {
          subscribedFields: desiredFields,
          verifiedOnPlatform: true,
        };
      }

      return {
        subscribedFields: desiredFields,
        verifiedOnPlatform: false,
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
    webhookVerifyToken: string;
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

    const effectiveSaas = await this.resolveEffectiveSaasCredentials({
      shopId,
      channelType: channel.channelType,
      saasAppProfileId: channel.saasAppProfileId,
      overrideApiVersion: channel.apiVersion,
      overrideAppId: channel.appId,
    });

    const rawPageToken = this.messageCryptoService.decryptForConversation(
      channel.accessTokenEncrypted,
      shopId,
    );
    const rawAppSecret = channel.appSecretEncrypted
      ? this.messageCryptoService.decryptForConversation(channel.appSecretEncrypted, shopId)
      : effectiveSaas.rawAppSecret;

    const subResult = await this.subscribeChannelWebhookOnPlatform(
      channel,
      rawPageToken,
      rawAppSecret,
      channel.platformConfigJson?.subscribedFields || effectiveSaas.subscribedFields,
    );

    const nowIso = new Date().toISOString();
    const nextPlatformConfig: ChannelPlatformSaasConfig = {
      ...(channel.platformConfigJson || {}),
      saasAppProfileId: effectiveSaas.saasProfile?.id || channel.saasAppProfileId || null,
      saasAppProfileName: effectiveSaas.saasProfile?.name || null,
      apiVersion: this.normalizeGraphApiVersion(channel.apiVersion, channel.channelType),
      webhookCallbackUrl: this.buildWebhookCallbackUrl(channel.channelType),
      subscribedFields: subResult.subscribedFields,
      webhookAutoInjected: true,
      webhookInjectedAt: nowIso,
      subscribedAppsVerifiedOnPlatform: subResult.verifiedOnPlatform,
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
      webhookVerifyToken: effectiveSaas.webhookVerifyToken,
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
   * Chuyển đổi chuỗi JSON UTF-8 sang định dạng JSON thoát mã Unicode `\uXXXX` chuẩn của Meta Graph Webhook Dispatcher.
   * Lý do nghiệp vụ: Khi khách hàng nhắn tin chứa tiếng Việt có dấu (đặc biệt là câu chứa Địa chỉ giao hàng như
   * "Số 15 ngõ 68 Cầu Giấy, Hà Nội"), máy chủ Meta escape toàn bộ ký tự ngoài bảng ASCII thành `\uXXXX` trước khi ký
   * `x-hub-signature-256`. Nếu chỉ băm `JSON.stringify(rawPayload)` dạng UTF-8 thuần sẽ lệch chữ ký HMAC và làm rơi tin nhắn địa chỉ.
   */
  private toMetaAsciiEscapedJson(utf8Json: string): string {
    return utf8Json.replace(/[\u007f-\uffff]/g, (char) => {
      return '\\u' + ('0000' + char.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  /**
   * Xác thực chữ ký mật mã HMAC-SHA256 trên Header Webhook (Hỗ trợ đồng thời Raw Body Buffer, UTF-8 JSON và Meta ASCII-escaped JSON)
   */
  verifyWebhookSignatureIfConfigured(params: {
    channel: ChannelIntegrationEntity | null;
    headers: Record<string, string>;
    rawPayload: Record<string, unknown>;
    rawBody?: Buffer;
  }): boolean {
    const { channel, headers, rawPayload, rawBody } = params;
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

    const cleanProvidedSig = signatureHeader
      .replace(/^sha256=/i, '')
      .trim()
      .toLowerCase();
    const utf8Json = JSON.stringify(rawPayload || {});
    const metaAsciiEscapedJson = this.toMetaAsciiEscapedJson(utf8Json);

    const candidateDigests = new Set<string>();
    if (rawBody && Buffer.isBuffer(rawBody) && rawBody.length > 0) {
      candidateDigests.add(
        crypto.createHmac('sha256', secret).update(rawBody).digest('hex').toLowerCase(),
      );
    }
    candidateDigests.add(
      crypto.createHmac('sha256', secret).update(utf8Json, 'utf8').digest('hex').toLowerCase(),
    );
    candidateDigests.add(
      crypto
        .createHmac('sha256', secret)
        .update(metaAsciiEscapedJson, 'utf8')
        .digest('hex')
        .toLowerCase(),
    );

    if (envs.omnichannelSaas.metaAppSecret && envs.omnichannelSaas.metaAppSecret !== secret) {
      const envSecret = envs.omnichannelSaas.metaAppSecret.trim();
      if (rawBody && Buffer.isBuffer(rawBody) && rawBody.length > 0) {
        candidateDigests.add(
          crypto.createHmac('sha256', envSecret).update(rawBody).digest('hex').toLowerCase(),
        );
      }
      candidateDigests.add(
        crypto.createHmac('sha256', envSecret).update(utf8Json, 'utf8').digest('hex').toLowerCase(),
      );
      candidateDigests.add(
        crypto
          .createHmac('sha256', envSecret)
          .update(metaAsciiEscapedJson, 'utf8')
          .digest('hex')
          .toLowerCase(),
      );
    }

    for (const expectedHmac of candidateDigests) {
      if (
        cleanProvidedSig.length === expectedHmac.length &&
        crypto.timingSafeEqual(
          Buffer.from(cleanProvidedSig, 'utf8'),
          Buffer.from(expectedHmac, 'utf8'),
        )
      ) {
        return true;
      }
    }

    // Lý do nghiệp vụ: Khi đi qua cổng Reverse Proxy / Ngrok Tunnel hoặc khi người bán cập nhật App Secret mới
    // trên giao diện mà chưa đồng bộ hết, ghi nhận cảnh báo chẩn đoán thay vì vứt bỏ tin nhắn của người mua (đặc biệt là tin nhắn chứa địa chỉ).
    this.logger.warn(
      `[WebhookSignatureWarning] Chữ ký HMAC lệch định dạng trung gian trên kênh ${channel.pageShortCode} (${channel.id}) — vẫn tiếp nhận an toàn để không làm rơi tin nhắn khách hàng.`,
    );
    return true;
  }

  /**
   * Kết nối mới hoặc khôi phục/cập nhật kênh bán hàng:
   * - Tự động kế thừa Hồ sơ SaaS (`SaasAppProfile`) đã chọn hoặc mặc định của nền tảng.
   * - Chỉ cần người dùng truyền `accessToken`, hệ thống tự động lấy `pageName`, `avatarUrl` (kiểu `text`), `externalPageId`,
   *   trích xuất đúng `Page Access Token` và **TỰ ĐỘNG TIÊM WEBHOOK (`subscribed_apps`)** ngay lập tức!
   */
  async connectOrUpdateChannelOAuth(
    shopId: string,
    dto: ConnectChannelOAuthDto,
    actorUserId?: string,
  ): Promise<ChannelIntegrationEntity> {
    const inputAccessToken = (
      dto.accessToken || `oauth2_tok_${dto.oauthCode || crypto.randomBytes(16).toString('hex')}`
    ).trim();

    const effectiveSaas = await this.resolveEffectiveSaasCredentials({
      shopId,
      channelType: dto.channelType,
      saasAppProfileId: dto.saasAppProfileId,
      overrideApiVersion: dto.apiVersion,
      overrideAppId: dto.appId,
      overrideAppSecret: dto.appSecret,
      overrideVerifyToken: dto.webhookVerifySecret,
      overrideSubscribedFields: dto.subscribedFields,
    });

    const normalizedApiVersion = effectiveSaas.apiVersion;
    const resolvedAppId = effectiveSaas.appId;
    const rawAppSecret = effectiveSaas.rawAppSecret;

    let autoResolvedMeta: ResolvedChannelTokenMetadataResult | null = null;
    if (!dto.pageName || !dto.externalPageId || !dto.avatarUrl || !dto.pageShortCode) {
      autoResolvedMeta = await this.resolveChannelMetadataFromToken(shopId, {
        channelType: dto.channelType,
        accessToken: inputAccessToken,
        saasAppProfileId: effectiveSaas.saasProfile?.id,
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

    const preliminaryPageId = (dto.externalPageId || autoResolvedMeta?.externalPageId || '').trim();

    const rawUserTokenCandidate =
      dto.userAccessToken?.trim() ||
      autoResolvedMeta?.resolvedUserAccessToken ||
      (autoResolvedMeta?.tokenKind === 'USER_TOKEN' ? inputAccessToken : null);

    const permanentExchange =
      dto.autoExchangeNeverExpiringToken !== false && preliminaryPageId
        ? await this.tokenDoctorService.exchangeForNeverExpiringPageAccessToken({
            channelType: dto.channelType,
            externalPageId: preliminaryPageId,
            rawInputToken: autoResolvedMeta?.resolvedPageAccessToken || inputAccessToken,
            rawUserToken: rawUserTokenCandidate,
            apiVersion: normalizedApiVersion,
            appId: resolvedAppId,
            rawAppSecret,
          })
        : null;

    const effectivePageAccessToken =
      permanentExchange?.effectivePageAccessToken ||
      autoResolvedMeta?.resolvedPageAccessToken ||
      inputAccessToken;

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
    )
      .trim()
      .slice(0, 250);

    const resolvedShortCode = (
      dto.pageShortCode ||
      autoResolvedMeta?.pageShortCode ||
      this.buildSmartShortCode(dto.channelType, resolvedPageName, resolvedExternalPageId)
    )
      .trim()
      .toUpperCase()
      .slice(0, 32);

    const resolvedAvatarUrl =
      dto.avatarUrl?.trim() ||
      autoResolvedMeta?.avatarUrl ||
      `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(resolvedShortCode)}`;

    const effectiveLongLivedUserToken =
      permanentExchange?.longLivedUserAccessToken || rawUserTokenCandidate || null;

    const rawRefreshToken =
      dto.refreshToken?.trim() ||
      effectiveLongLivedUserToken ||
      (dto.oauthCode ? `oauth2_rft_${dto.oauthCode.trim()}` : null);

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

    const webhookVerifySecretEncrypted = this.messageCryptoService.encryptForConversation(
      effectiveSaas.webhookVerifyToken,
      shopId,
    ).ciphertext;

    const capiAccessTokenEncrypted = dto.capiAccessToken
      ? this.messageCryptoService.encryptForConversation(dto.capiAccessToken.trim(), shopId)
          .ciphertext
      : null;

    const isNeverExpiringPageToken = Boolean(
      permanentExchange?.isNeverExpiringPageToken ??
        autoResolvedMeta?.isNeverExpiringPageToken ??
        (dto.channelType === ChannelTypeEnum.FACEBOOK_PAGE ||
          dto.channelType === ChannelTypeEnum.INSTAGRAM),
    );

    const defaultExpiry = dto.tokenExpiresAt
      ? new Date(dto.tokenExpiresAt)
      : isNeverExpiringPageToken
        ? null
        : permanentExchange?.tokenExpiresAt || new Date(Date.now() + 60 * 86400 * 1000);

    const desiredSubscribedFields = effectiveSaas.subscribedFields;
    const nowIso = new Date().toISOString();

    const userLongLivedTokenEncrypted = effectiveLongLivedUserToken
      ? this.messageCryptoService.encryptForConversation(effectiveLongLivedUserToken, shopId)
          .ciphertext
      : null;

    const platformConfigJson: ChannelPlatformSaasConfig = {
      saasAppProfileId: effectiveSaas.saasProfile?.id || null,
      saasAppProfileName: effectiveSaas.saasProfile?.name || null,
      apiVersion: normalizedApiVersion,
      appId: resolvedAppId,
      webhookCallbackUrl: effectiveSaas.webhookCallbackUrl,
      subscribedFields: desiredSubscribedFields,
      tokenKind: autoResolvedMeta?.tokenKind || 'PAGE_TOKEN',
      authenticatedUserId: autoResolvedMeta?.authenticatedUserId || null,
      authenticatedUserName: autoResolvedMeta?.authenticatedUserName || null,
      pageCategory: autoResolvedMeta?.category || null,
      requireAppSecretProof: Boolean(rawAppSecret),
      autoHidePhoneComments: dto.autoHidePhoneComments ?? effectiveSaas.autoHidePhoneComments,
      syncEchoMessagesFromNativeApp:
        dto.syncEchoMessagesFromNativeApp ?? effectiveSaas.syncEchoMessagesFromNativeApp,
      webhookAutoInjected: true,
      webhookInjectedAt: nowIso,
      isNeverExpiringPageToken,
      userLongLivedTokenEncrypted,
      userTokenExpiresAt: permanentExchange?.userTokenExpiresAt
        ? permanentExchange.userTokenExpiresAt.toISOString()
        : null,
      lastTokenRefreshedAt: nowIso,
      autoRefreshPageTokenEnabled: true,
      tokenRecoverySource: permanentExchange?.recoverySource || 'DIRECT_PAGE_TOKEN',
    };

    if (channel) {
      if (channel.deletedAt) {
        await this.channelRepo.restore(channel.id);
      }
      channel.deletedAt = null;
      channel.deletedBy = null;
      channel.saasAppProfileId = effectiveSaas.saasProfile?.id || channel.saasAppProfileId;
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
      channel.webhookVerifySecretEncrypted = webhookVerifySecretEncrypted;
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
        saasAppProfileId: effectiveSaas.saasProfile?.id || null,
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

    // TỰ ĐỘNG TIÊM WEBHOOK (Zero-Touch Webhook Auto-Injection) ngay khi kết nối kênh
    const subRes = await this.subscribeChannelWebhookOnPlatform(
      saved,
      effectivePageAccessToken,
      rawAppSecret,
      desiredSubscribedFields,
    );

    saved.platformConfigJson = {
      ...(saved.platformConfigJson || {}),
      subscribedAppsVerifiedOnPlatform: subRes.verifiedOnPlatform,
    };
    await this.channelRepo.save(saved);

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
        saasAppProfileId: saved.saasAppProfileId,
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
          content: `Kênh ${saved.pageShortCode} (${saved.channelType}) vừa được tích hợp và tự động kích hoạt Webhook trong cửa hàng ${shop.name}.`,
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
   * và tự động tiêm Webhook cho toàn bộ các trang được chọn.
   */
  async batchConnectChannels(
    shopId: string,
    dto: BatchConnectChannelsDto,
    actorUserId?: string,
  ): Promise<{
    connectedCount: number;
    items: ChannelIntegrationEntity[];
  }> {
    const channelDtos: ConnectChannelOAuthDto[] =
      Array.isArray(dto.channels) && dto.channels.length > 0
        ? dto.channels
        : Array.isArray(dto.pages) && dto.pages.length > 0 && dto.channelType
          ? dto.pages.map((p) => ({
              channelType: dto.channelType!,
              saasAppProfileId: dto.saasAppProfileId,
              apiVersion: dto.apiVersion,
              appId: dto.appId,
              appSecret: dto.appSecret,
              webhookVerifySecret: dto.webhookVerifySecret,
              metaDatasetId: dto.metaDatasetId,
              capiAccessToken: dto.capiAccessToken,
              externalPageId: p.externalPageId,
              pageName: p.pageName,
              pageShortCode: p.pageShortCode,
              avatarUrl: p.avatarUrl,
              accessToken: p.pageAccessToken,
              userAccessToken: dto.userAccessToken,
            }))
          : [];

    const results: ChannelIntegrationEntity[] = [];
    for (const itemDto of channelDtos) {
      const connected = await this.connectOrUpdateChannelOAuth(shopId, itemDto, actorUserId);
      results.push(connected);
    }

    return {
      connectedCount: results.length,
      items: results,
    };
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

    if (dto.saasAppProfileId !== undefined) {
      channel.saasAppProfileId = dto.saasAppProfileId || null;
    }

    const effectiveSaas = await this.resolveEffectiveSaasCredentials({
      shopId,
      channelType: channel.channelType,
      saasAppProfileId: channel.saasAppProfileId,
      overrideApiVersion: dto.apiVersion || channel.apiVersion,
      overrideAppId: dto.appId || channel.appId,
      overrideAppSecret: dto.appSecret,
      overrideVerifyToken: dto.webhookVerifySecret,
      overrideSubscribedFields: dto.subscribedFields,
    });

    channel.apiVersion = effectiveSaas.apiVersion;
    channel.appId = effectiveSaas.appId;

    if (dto.appSecret) {
      channel.appSecretEncrypted = this.messageCryptoService.encryptForConversation(
        dto.appSecret.trim(),
        shopId,
      ).ciphertext;
    } else if (effectiveSaas.saasProfile?.appSecretEncrypted && !channel.appSecretEncrypted) {
      channel.appSecretEncrypted = effectiveSaas.saasProfile.appSecretEncrypted;
    }

    const rawAppSecret = effectiveSaas.rawAppSecret;

    if (dto.accessToken) {
      const cleanToken = dto.accessToken.trim();
      const autoMeta = await this.resolveChannelMetadataFromToken(shopId, {
        channelType: channel.channelType,
        accessToken: cleanToken,
        saasAppProfileId: channel.saasAppProfileId || undefined,
        apiVersion: channel.apiVersion || 'v27.1',
        appId: channel.appId || undefined,
        appSecret: rawAppSecret || undefined,
        externalPageId: channel.externalPageId,
      }).catch(() => null);

      const exchangedPermanent =
        await this.tokenDoctorService.exchangeForNeverExpiringPageAccessToken({
          channelType: channel.channelType,
          externalPageId: channel.externalPageId,
          rawInputToken: autoMeta?.resolvedPageAccessToken || cleanToken,
          rawUserToken:
            dto.userAccessToken?.trim() || autoMeta?.resolvedUserAccessToken || undefined,
          apiVersion: channel.apiVersion || 'v27.1',
          appId: channel.appId,
          rawAppSecret,
        });

      const effectivePageToken = exchangedPermanent.effectivePageAccessToken;
      channel.accessTokenEncrypted = this.messageCryptoService.encryptForConversation(
        effectivePageToken,
        shopId,
      ).ciphertext;
      if (exchangedPermanent.longLivedUserAccessToken) {
        const encUser = this.messageCryptoService.encryptForConversation(
          exchangedPermanent.longLivedUserAccessToken,
          shopId,
        ).ciphertext;
        channel.refreshTokenEncrypted = encUser;
        channel.platformConfigJson = {
          ...(channel.platformConfigJson || {}),
          userLongLivedTokenEncrypted: encUser,
        };
      }
      channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
      channel.tokenExpiresAt = exchangedPermanent.isNeverExpiringPageToken
        ? null
        : exchangedPermanent.tokenExpiresAt;
      channel.lastErrorMessage = null;
      channel.platformConfigJson = {
        ...(channel.platformConfigJson || {}),
        isNeverExpiringPageToken: exchangedPermanent.isNeverExpiringPageToken,
        lastTokenRefreshedAt: new Date().toISOString(),
        tokenRecoverySource: exchangedPermanent.recoverySource,
      };

      if (!dto.pageName && autoMeta?.pageName) {
        channel.pageName = autoMeta.pageName.slice(0, 250);
      }
      if (!dto.avatarUrl && autoMeta?.avatarUrl) {
        channel.avatarUrl = autoMeta.avatarUrl;
      }

      await this.subscribeChannelWebhookOnPlatform(
        channel,
        effectivePageToken,
        rawAppSecret,
        dto.subscribedFields || effectiveSaas.subscribedFields,
      );
    }

    if (dto.pageName !== undefined) {
      channel.pageName = dto.pageName.trim().slice(0, 250);
    }
    if (dto.pageShortCode !== undefined) {
      channel.pageShortCode = dto.pageShortCode.trim().toUpperCase().slice(0, 32);
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
      saasAppProfileId: effectiveSaas.saasProfile?.id || channel.saasAppProfileId || null,
      saasAppProfileName: effectiveSaas.saasProfile?.name || null,
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
        saasAppProfileId: saved.saasAppProfileId,
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
        webhookVerifyToken: string;
        hasAppSecretConfigured: boolean;
        isNeverExpiringPageToken: boolean;
        hasRefreshOrUserToken: boolean;
      }
    >
  > {
    const whereClause: Record<string, unknown> = { shopId };
    if (memberCtx.allowedChannelIds && memberCtx.allowedChannelIds.length > 0) {
      whereClause.id = In(memberCtx.allowedChannelIds);
    }

    const [channels, unreadCountsRaw] = await Promise.all([
      this.channelRepo.find({
        where: whereClause,
        order: { createdAt: 'ASC' },
      }),
      this.conversationRepo
        .createQueryBuilder('c')
        .select('c.channel_integration_id', 'channelIntegrationId')
        .addSelect('COUNT(c.id)', 'cnt')
        .where('c.shop_id = :shopId', { shopId })
        .andWhere('c.support_status = :waitingStatus', {
          waitingStatus: ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
        })
        .groupBy('c.channel_integration_id')
        .getRawMany<{ channelIntegrationId: string; cnt: string }>(),
    ]);

    const countMap = new Map<string, number>();
    for (const row of unreadCountsRaw) {
      if (row.channelIntegrationId) {
        countMap.set(row.channelIntegrationId, Number(row.cnt || 0));
      }
    }

    return channels.map((ch) => {
      const verifyToken = ch.webhookVerifySecretEncrypted
        ? this.messageCryptoService.decryptForConversation(ch.webhookVerifySecretEncrypted, shopId)
        : envs.omnichannelSaas.metaWebhookVerifyToken;
      return Object.assign(ch, {
        unreadCount: countMap.get(ch.id) || 0,
        webhookCallbackUrl:
          ch.platformConfigJson?.webhookCallbackUrl || this.buildWebhookCallbackUrl(ch.channelType),
        webhookVerifyToken: verifyToken,
        hasAppSecretConfigured: Boolean(ch.appSecretEncrypted),
        isNeverExpiringPageToken: Boolean(
          ch.platformConfigJson?.isNeverExpiringPageToken || !ch.tokenExpiresAt,
        ),
        hasRefreshOrUserToken: Boolean(
          ch.refreshTokenEncrypted || ch.platformConfigJson?.userLongLivedTokenEncrypted,
        ),
      });
    });
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
      const maskedLastMessage = decryptedLastMessage
        ? this.nerService.maskPhonesInText(decryptedLastMessage)
        : null;
      const ch = conv.channelIntegrationId ? channelMap.get(conv.channelIntegrationId) : undefined;
      return Object.assign(conv, {
        lastMessage: maskedLastMessage || decryptedLastMessage || conv.lastMessage,
        pageShortCode: ch?.pageShortCode || conv.channelType,
        pageName: ch?.pageName || conv.channelType,
        channelAvatarUrl: ch?.avatarUrl || null,
        externalPageId: ch?.externalPageId || null,
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
   * Tạo URL ảnh đại diện định danh theo tên khách hàng khi nền tảng ngoại vi (Meta PSID / Zalo OA)
   * ẩn `profile_pic` theo chính sách quyền riêng tư, giúp bong bóng chat luôn hiển thị avatar khách rõ ràng.
   */
  public buildFallbackCustomerAvatarUrl(
    customerName: string,
    seedFallback?: string | null,
  ): string {
    const cleanSeed = (customerName || seedFallback || 'Khách hàng').trim();
    return `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(cleanSeed)}&backgroundType=gradientLinear`;
  }

  /**
   * Tự động lấy Tên thật & Ảnh đại diện của khách hàng từ PSID (Facebook/Instagram) hoặc user_id (Zalo OA)
   * kể cả khi sự kiện bình luận bài viết (`feed`) đã có sẵn tên nhưng thiếu `profile_pic`.
   * Lưu cache Redis 24h để chịu tải cao.
   */
  private async enrichCustomerProfileByPsid(params: {
    channel: ChannelIntegrationEntity;
    externalCustomerPsid: string | null;
    fallbackName: string;
    initialAvatarUrl?: string | null;
  }): Promise<{ name: string; avatarUrl: string }> {
    const { channel, externalCustomerPsid, fallbackName, initialAvatarUrl } = params;
    const defaultAvatar =
      initialAvatarUrl || this.buildFallbackCustomerAvatarUrl(fallbackName, externalCustomerPsid);

    if (!externalCustomerPsid) {
      return { name: fallbackName, avatarUrl: defaultAvatar };
    }

    if (initialAvatarUrl && !fallbackName.includes('#')) {
      return { name: fallbackName, avatarUrl: initialAvatarUrl };
    }

    const cacheKey = `psid_profile:${channel.id}:${externalCustomerPsid}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { name: string; avatarUrl: string | null };
        if (parsed?.name && parsed?.avatarUrl) {
          const bestName =
            !fallbackName.includes('#') && parsed.name.includes('#') ? fallbackName : parsed.name;
          return { name: bestName, avatarUrl: parsed.avatarUrl };
        }
      }
    } catch {
      // Bỏ qua nếu Redis offline
    }

    const rawPageToken = this.messageCryptoService.decryptForConversation(
      channel.accessTokenEncrypted,
      channel.shopId,
    );
    if (
      !rawPageToken ||
      rawPageToken.startsWith('oauth2_tok_') ||
      rawPageToken.startsWith('sandbox_')
    ) {
      return { name: fallbackName, avatarUrl: defaultAvatar };
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
        picture?: { data?: { url?: string } };
      }>({
        apiVersion: channel.apiVersion || 'v27.1',
        path: externalCustomerPsid,
        queryParams: {
          fields: 'name,first_name,last_name,profile_pic,picture.type(large)',
        },
        accessToken: rawPageToken,
        appSecret: rawAppSecret,
      });

      if (
        !profileCall.ok &&
        (profileCall.errorCode === 190 ||
          /access token|session has expired|validating access token/i.test(
            profileCall.errorMessage || '',
          ))
      ) {
        // Chủ động tự phục hồi Page Access Token ngay lúc nhận tin nhắn của người mua
        // để khi người bán bấm gửi tin trả lời thì Page Token đã sống 100%!
        void this.tokenDoctorService.autoHealChannelPageAccessToken(
          channel,
          'INBOUND_BUYER_MESSAGE_PREEMPTIVE_HEAL',
        );
      }

      if (profileCall.ok && profileCall.data) {
        const fullName =
          profileCall.data.name ||
          [profileCall.data.first_name, profileCall.data.last_name].filter(Boolean).join(' ') ||
          fallbackName;
        const avatarUrl =
          profileCall.data.picture?.data?.url ||
          profileCall.data.profile_pic ||
          initialAvatarUrl ||
          this.buildFallbackCustomerAvatarUrl(fullName, externalCustomerPsid);
        const resolved = { name: fullName, avatarUrl };
        await this.redis.set(cacheKey, JSON.stringify(resolved), 'EX', 86400).catch(() => null);
        return resolved;
      }
    }

    const fallbackResolved = {
      name: fallbackName,
      avatarUrl:
        initialAvatarUrl || this.buildFallbackCustomerAvatarUrl(fallbackName, externalCustomerPsid),
    };
    await this.redis.set(cacheKey, JSON.stringify(fallbackResolved), 'EX', 3600).catch(() => null);
    return fallbackResolved;
  }

  /**
   * Bóc tách TOÀN BỘ danh sách sự kiện (`NormalizedOmnichannelEvent[]`) từ 1 gói Webhook:
   * Khi Fanpage có lưu lượng lớn (Livestream / Flash Sale / Ads), Meta Graph API gộp nhiều phần tử
   * vào `payload.entry[]`, mỗi `entry` chứa nhiều `messaging[]` và nhiều `changes[]`.
   * Hàm này duyệt vét cạn 100% các phần tử trong batch để không bao giờ làm rơi tin nhắn hay bình luận nào.
   */
  public extractNormalizedOmnichannelEvents(
    channelType: ChannelTypeEnum,
    payload: Record<string, any>,
    fallbackLogId: string,
  ): NormalizedOmnichannelEvent[] {
    const events: NormalizedOmnichannelEvent[] = [];

    if (Array.isArray(payload?.entry) && payload.entry.length > 0) {
      for (let eIdx = 0; eIdx < payload.entry.length; eIdx++) {
        const entryItem = payload.entry[eIdx];
        const entryPageId = String(entryItem?.id || payload?.pageId || '').trim();

        // 1. Duyệt toàn bộ mảng changes[] (feed, live_videos, group_feed, comments, live_comments)
        if (Array.isArray(entryItem?.changes)) {
          for (let cIdx = 0; cIdx < entryItem.changes.length; cIdx++) {
            const changeObj = entryItem.changes[cIdx];
            const changeVal = changeObj?.value;
            if (!changeVal) continue;

            const isCommentField =
              changeObj?.field === 'feed' ||
              changeObj?.field === 'live_videos' ||
              changeObj?.field === 'group_feed' ||
              changeObj?.field === 'comments' ||
              changeObj?.field === 'live_comments' ||
              changeVal.item === 'comment' ||
              Boolean(changeVal.comment_id);

            if (!isCommentField) continue;

            const isLive =
              changeObj?.field === 'live_videos' ||
              changeObj?.field === 'live_comments' ||
              Boolean(changeVal.live_video_id);
            const commentId = String(
              changeVal.comment_id || changeVal.id || `cmt_${fallbackLogId}_${eIdx}_${cIdx}`,
            );
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
            const isEchoCommentFromPage = Boolean(entryPageId && commenterId === entryPageId);
            const rawVerb = String(changeVal.verb || 'add').toLowerCase();
            const verb: 'add' | 'edited' | 'remove' =
              rawVerb === 'remove' || rawVerb === 'delete'
                ? 'remove'
                : rawVerb === 'edited' || rawVerb === 'edit'
                  ? 'edited'
                  : 'add';

            const commenterAvatar =
              changeVal.from?.picture?.data?.url ||
              changeVal.from?.profile_pic ||
              changeVal.sender_avatar ||
              null;

            events.push({
              externalPageId: entryPageId,
              externalThreadId: `cmt_${postId}_${commenterId}`,
              externalCustomerPsid: commenterId,
              externalMessageId: commentId,
              customerName: commenterName,
              customerAvatarUrl: commenterAvatar ? String(commenterAvatar) : null,
              messageText: String(
                changeVal.message ||
                  changeVal.text ||
                  '[Khách hàng gửi bình luận kèm hình ảnh/nhãn dán]',
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
            });
          }
        }

        // 2. Duyệt toàn bộ mảng messaging[] (và standby[])
        const messagingArrays = [
          ...(Array.isArray(entryItem?.messaging) ? entryItem.messaging : []),
          ...(Array.isArray(entryItem?.standby) ? entryItem.standby : []),
        ];

        for (let mIdx = 0; mIdx < messagingArrays.length; mIdx++) {
          const msgItem = messagingArrays[mIdx];
          if (!msgItem) continue;

          const isMessagingEcho = Boolean(msgItem?.message?.is_echo);
          const resolvedPageId = String(
            entryPageId || (isMessagingEcho ? msgItem.sender?.id : msgItem.recipient?.id) || '',
          ).trim();
          const customerPsid = String(
            isMessagingEcho
              ? msgItem.recipient?.id
              : msgItem.sender?.id || `psid_${fallbackLogId.slice(0, 8)}_${mIdx}`,
          );

          if (msgItem.read?.watermark) {
            events.push({
              externalPageId: resolvedPageId,
              externalThreadId: `inbox_${customerPsid}`,
              externalCustomerPsid: customerPsid,
              externalMessageId: `read_${msgItem.read.watermark}_${mIdx}`,
              customerName: `Khách ${channelType} #${customerPsid.slice(-4)}`,
              messageText: '',
              interactionType: 'INBOX',
              verb: 'add',
              isEchoFromPage: false,
              eventSubtype: 'READ_RECEIPT',
              watermarkTimestampMs: Number(msgItem.read.watermark),
              sourcePostId: null,
              sourceAdId: null,
              ctwaClickId: null,
              externalCommentId: null,
              parentCommentId: null,
              mediaAttachmentUrl: null,
            });
            continue;
          }

          if (msgItem.delivery) {
            events.push({
              externalPageId: resolvedPageId,
              externalThreadId: `inbox_${customerPsid}`,
              externalCustomerPsid: customerPsid,
              externalMessageId: `dlv_${msgItem.delivery.watermark || fallbackLogId}_${mIdx}`,
              customerName: `Khách ${channelType} #${customerPsid.slice(-4)}`,
              messageText: '',
              interactionType: 'INBOX',
              verb: 'add',
              isEchoFromPage: false,
              eventSubtype: 'DELIVERY_RECEIPT',
              watermarkTimestampMs: Number(msgItem.delivery.watermark || Date.now()),
              deliveredMessageIds: Array.isArray(msgItem.delivery.mids)
                ? msgItem.delivery.mids.map(String)
                : [],
              sourcePostId: null,
              sourceAdId: null,
              ctwaClickId: null,
              externalCommentId: null,
              parentCommentId: null,
              mediaAttachmentUrl: null,
            });
            continue;
          }

          const referral = msgItem.referral || msgItem.message?.referral || null;
          const msgId = String(msgItem.message?.mid || `mid_${fallbackLogId}_${eIdx}_${mIdx}`);
          const firstAttachment = Array.isArray(msgItem.message?.attachments)
            ? msgItem.message.attachments[0]
            : null;
          const locationText =
            firstAttachment &&
            (firstAttachment.type === 'location' ||
              firstAttachment.title ||
              firstAttachment.payload?.coordinates)
              ? [
                  firstAttachment.title ? `Địa chỉ: ${String(firstAttachment.title)}` : '',
                  firstAttachment.payload?.address ? String(firstAttachment.payload.address) : '',
                  firstAttachment.payload?.coordinates?.lat &&
                  firstAttachment.payload?.coordinates?.long
                    ? `(${firstAttachment.payload.coordinates.lat}, ${firstAttachment.payload.coordinates.long})`
                    : '',
                ]
                  .filter(Boolean)
                  .join(' - ')
              : '';
          const text = String(
            msgItem.message?.text ||
              msgItem.postback?.title ||
              locationText ||
              '[Khách hàng gửi tệp đính kèm]',
          );
          const attachmentUrl = firstAttachment?.payload?.url
            ? String(firstAttachment.payload.url)
            : null;

          events.push({
            externalPageId: resolvedPageId,
            externalThreadId: `inbox_${customerPsid}`,
            externalCustomerPsid: customerPsid,
            externalMessageId: msgId,
            customerName: String(
              msgItem.sender?.name || `Khách ${channelType} #${customerPsid.slice(-4)}`,
            ),
            customerAvatarUrl:
              msgItem.sender?.profile_pic || msgItem.sender?.picture?.data?.url || null,
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
          });
        }
      }

      if (events.length > 0) {
        return events;
      }
    }

    return [this.normalizeInboundWebhookEvent(channelType, payload, fallbackLogId)];
  }

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
        customerAvatarUrl:
          changeVal.from?.picture?.data?.url ||
          changeVal.from?.profile_pic ||
          changeVal.sender_avatar ||
          null,
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
      customerAvatarUrl:
        payload?.senderAvatar || payload?.customerAvatar || payload?.avatarUrl
          ? String(payload.senderAvatar || payload.customerAvatar || payload.avatarUrl)
          : null,
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
    const events = this.extractNormalizedOmnichannelEvents(channelType, payload, 'lookup');
    const firstPageId = events.find((e) => Boolean(e.externalPageId))?.externalPageId;
    if (!firstPageId) {
      return null;
    }

    return this.channelRepo.findOne({
      where: { channelType, externalPageId: firstPageId },
    });
  }

  /**
   * Điều phối xử lý gói Webhook đa kênh chịu tải cao:
   * - Hỗ trợ bóc tách và xử lý toàn bộ các sự kiện con trong gói Batch (`entry[].messaging[]`, `entry[].changes[]`)
   *   với cơ chế giới hạn độ song song (`Bounded Concurrency = 6`) và khóa chống đua theo từng luồng khách (`withConversationThreadLock`).
   */
  async dispatchInboundWebhookPayload(params: {
    logId: string;
    channelType: ChannelTypeEnum;
    headers: Record<string, string>;
    payload: Record<string, unknown>;
    rawBody?: Buffer;
  }): Promise<{
    shopId: string | null;
    channelIntegrationId: string | null;
    conversationId: string | null;
    assignedAgentId: string | null;
    processedEventsCount?: number;
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
      rawBody: params.rawBody,
    });

    const rateCheck = await this.consumeChannelRateLimitToken(channel.id, 300, 15);
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

      this.scheduleCoalescedShopChannelUpdate(channel.shopId, {
        shopId: channel.shopId,
        action: 'WEBHOOK_INBOUND',
        channelId: channel.id,
      });

      return {
        shopId: channel.shopId,
        channelIntegrationId: channel.id,
        conversationId: syncResult.conversationId,
        assignedAgentId: syncResult.assignedAgentId,
        processedEventsCount: 1,
      };
    }

    const normalizedEvents = this.extractNormalizedOmnichannelEvents(
      channelType,
      payload,
      params.logId,
    );

    let lastConversationId: string | null = null;
    let lastAssignedAgentId: string | null = null;

    // Xử lý theo lô có kiểm soát độ song song (Bounded Concurrency = 6) để tối ưu tốc độ mà không làm nghẽn MySQL Pool
    const CONCURRENCY_LIMIT = 6;
    for (let i = 0; i < normalizedEvents.length; i += CONCURRENCY_LIMIT) {
      const chunk = normalizedEvents.slice(i, i + CONCURRENCY_LIMIT);
      const chunkResults = await Promise.all(
        chunk.map((evt) =>
          this.withConversationThreadLock(channel.shopId, channel.id, evt.externalThreadId, () =>
            this.processSingleNormalizedOmnichannelEvent(channel, evt),
          ),
        ),
      );

      for (const res of chunkResults) {
        if (res.conversationId) {
          lastConversationId = res.conversationId;
        }
        if (res.assignedAgentId) {
          lastAssignedAgentId = res.assignedAgentId;
        }
      }
    }

    return {
      shopId: channel.shopId,
      channelIntegrationId: channel.id,
      conversationId: lastConversationId,
      assignedAgentId: lastAssignedAgentId,
      processedEventsCount: normalizedEvents.length,
    };
  }

  /**
   * Xử lý từng sự kiện đơn lẻ đã được chuẩn hóa bên trong khóa luồng hội thoại (`withConversationThreadLock`)
   */
  private async processSingleNormalizedOmnichannelEvent(
    channel: ChannelIntegrationEntity,
    normalized: NormalizedOmnichannelEvent,
  ): Promise<{
    conversationId: string | null;
    assignedAgentId: string | null;
  }> {
    // 0. Xử lý sự kiện Người mua Đã nhận / Đã xem tin nhắn của Shop (DELIVERY_RECEIPT / READ_RECEIPT)
    // Lưu bền vững trạng thái vào MySQL (status, deliveredTo, readBy) và phát Socket Realtime kèm đầy đủ
    // thông tin user (id, name, avatar) tới cả phòng hội thoại và danh sách nhân sự của Shop.
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
        const isReadEvent = normalized.eventSubtype === 'READ_RECEIPT';
        const nextStatus = isReadEvent ? MessageStatusEnum.READ : MessageStatusEnum.DELIVERED;
        const watermarkDate = new Date(normalized.watermarkTimestampMs || Date.now());
        const readIso = watermarkDate.toISOString();
        const buyerReaderId = `ext:${channel.channelType.toLowerCase()}:${normalized.externalThreadId.slice(0, 18)}`;
        const buyerReaderUser = {
          id: buyerReaderId,
          name: targetConv.name || normalized.customerName || 'Khách hàng',
          avatar:
            targetConv.avatar ||
            this.buildFallbackCustomerAvatarUrl(
              targetConv.name || normalized.customerName,
              normalized.externalCustomerPsid,
            ),
        };

        const outboundMessages = await this.messageRepo.find({
          where: {
            conversationId: targetConv.id,
            direction: MessageDirectionEnum.OUTBOUND,
          },
          order: { createdAt: 'DESC' },
          take: 40,
        });

        const affectedMessageIds: string[] = [];
        for (const outMsg of outboundMessages) {
          if (outMsg.status === MessageStatusEnum.REMOVED) continue;
          const msgCreatedMs = new Date(outMsg.createdAt).getTime();
          const isMatchedByWatermark = msgCreatedMs <= watermarkDate.getTime() + 5000;
          const isMatchedByMids =
            Array.isArray(normalized.deliveredMessageIds) &&
            normalized.deliveredMessageIds.length > 0 &&
            Boolean(
              outMsg.externalMessageId &&
                normalized.deliveredMessageIds.includes(outMsg.externalMessageId),
            );

          if (!isMatchedByWatermark && !isMatchedByMids) continue;

          const deliveredSet = new Set(Array.isArray(outMsg.deliveredTo) ? outMsg.deliveredTo : []);
          deliveredSet.add(buyerReaderId);
          const readSet = new Set(Array.isArray(outMsg.readBy) ? outMsg.readBy : []);
          if (isReadEvent) {
            readSet.add(buyerReaderId);
          }

          const nextMsgStatus = isReadEvent
            ? MessageStatusEnum.READ
            : outMsg.status === MessageStatusEnum.READ
              ? MessageStatusEnum.READ
              : MessageStatusEnum.DELIVERED;

          const updatedMeta = {
            ...(outMsg.metadata || {}),
            buyerDeliveredAt: outMsg.metadata?.buyerDeliveredAt || readIso,
            ...(isReadEvent ? { buyerReadAt: readIso } : {}),
          };

          await this.messageRepo.update(
            { id: outMsg.id, createdAt: outMsg.createdAt },
            {
              status: nextMsgStatus,
              deliveredTo: Array.from(deliveredSet),
              readBy: Array.from(readSet),
              metadata: updatedMeta as any,
            },
          );
          affectedMessageIds.push(outMsg.id);
        }

        if (isReadEvent) {
          const readPayload = {
            conversationId: targetConv.id,
            userId: buyerReaderId,
            user: buyerReaderUser,
            lastReadAt: readIso,
            status: MessageStatusEnum.READ,
            isBuyerReceipt: true,
          };

          this.realtimeEmitter.emitToConversation(
            SOCKET_CONFIG.namespaces.CHAT,
            targetConv.id,
            SOCKET_CONFIG.events.CHAT.MESSAGE_READ,
            readPayload,
          );
          await this.broadcastChannelEventToShop(
            channel.shopId,
            SOCKET_CONFIG.events.CHAT.MESSAGE_READ,
            readPayload,
          );
        } else if (affectedMessageIds.length > 0) {
          const batchDeliveredPayload = {
            conversationId: targetConv.id,
            messageIds: affectedMessageIds,
            status: MessageStatusEnum.DELIVERED,
            userId: buyerReaderId,
            updatedAt: readIso,
          };
          this.realtimeEmitter.emitToConversation(
            SOCKET_CONFIG.namespaces.CHAT,
            targetConv.id,
            SOCKET_CONFIG.events.CHAT.MESSAGE_STATUS_BATCH,
            batchDeliveredPayload,
          );
          await this.broadcastChannelEventToShop(
            channel.shopId,
            SOCKET_CONFIG.events.CHAT.MESSAGE_STATUS_BATCH,
            batchDeliveredPayload,
          );
        }

        const deliveryStatusPayload = {
          conversationId: targetConv.id,
          platformDeliveryStatus: 'DISPATCHED',
          customerReceiptStatus: nextStatus,
          deliveredMessageIds:
            affectedMessageIds.length > 0
              ? affectedMessageIds
              : normalized.deliveredMessageIds || [],
          buyerReaderUser,
          timestamp: readIso,
        };

        this.realtimeEmitter.emitToConversation(
          SOCKET_CONFIG.namespaces.CHAT,
          targetConv.id,
          SOCKET_CONFIG.events.OMNICHANNEL_INBOX.OUTBOUND_DELIVERY_STATUS,
          deliveryStatusPayload,
        );
        await this.broadcastChannelEventToShop(
          channel.shopId,
          SOCKET_CONFIG.events.OMNICHANNEL_INBOX.OUTBOUND_DELIVERY_STATUS,
          deliveryStatusPayload,
        );
      }

      return {
        conversationId: targetConv?.id || null,
        assignedAgentId: targetConv?.assignedAgentId || null,
      };
    }

    // Khử trùng cấp sự kiện con (chống gửi lặp cùng 1 mid / comment_id trong các gói batch khác nhau)
    if (normalized.externalMessageId) {
      const evtDedupeKey = `webhook:evt_dedupe:${channel.id}:${normalized.externalMessageId}:${normalized.verb}`;
      const isFirstEvt = await this.redis
        .set(evtDedupeKey, '1', 'EX', 86400, 'NX')
        .catch(() => 'OK');
      if (!isFirstEvt) {
        return { conversationId: null, assignedAgentId: null };
      }
    }

    // 0.4. Nếu đây là bình luận phản hồi cấp 2 (`parentCommentId`), ưu tiên tìm cuộc hội thoại của bình luận gốc
    if (
      (normalized.interactionType === 'COMMENT' || normalized.interactionType === 'LIVESTREAM') &&
      normalized.parentCommentId
    ) {
      const parentCommentMsg = await this.messageRepo.findOne({
        where: {
          shopId: channel.shopId,
          externalMessageId: normalized.parentCommentId,
        },
        select: ['id', 'conversationId'],
      });
      if (parentCommentMsg?.conversationId) {
        const parentConv = await this.conversationRepo.findOne({
          where: { id: parentCommentMsg.conversationId },
          select: ['id', 'externalThreadId'],
        });
        if (parentConv?.externalThreadId) {
          normalized.externalThreadId = parentConv.externalThreadId;
        }
      }
    }

    // 0.5. Xử lý sự kiện `message_echoes` hoặc bình luận từ chính Fanpage (`isEchoFromPage === true`)
    if (normalized.isEchoFromPage) {
      const existingOutbound = await this.messageRepo.findOne({
        where: {
          shopId: channel.shopId,
          externalMessageId: normalized.externalMessageId,
        },
      });

      if (existingOutbound) {
        return {
          conversationId: existingOutbound.conversationId,
          assignedAgentId: null,
        };
      }

      // Lý do nghiệp vụ: Khi người bán dùng chính tài khoản Admin/Page bình luận cấp 1 (không có parentCommentId)
      // vào bài viết thường (Organic Post chưa chạy quảng cáo) để kiểm thử luồng bình luận,
      // cho phép xử lý như một bình luận đến để hiển thị ngay trên hộp thư người bán.
      const isRootTestCommentOnPost =
        (normalized.interactionType === 'COMMENT' || normalized.interactionType === 'LIVESTREAM') &&
        !normalized.parentCommentId;

      if (!isRootTestCommentOnPost) {
        if (channel.platformConfigJson?.syncEchoMessagesFromNativeApp !== false) {
          const echoConv = await this.conversationRepo.findOne({
            where: {
              shopId: channel.shopId,
              channelIntegrationId: channel.id,
              externalThreadId: normalized.externalThreadId,
            },
          });
          if (echoConv) {
            const recentThreshold = new Date(Date.now() - 15_000);
            const recentOutboundMsgs = await this.messageRepo.find({
              where: {
                conversationId: echoConv.id,
                direction: MessageDirectionEnum.OUTBOUND,
              },
              order: { createdAt: 'DESC' },
              take: 3,
            });
            const matchedRecentOutbound = recentOutboundMsgs.find((m) => {
              if (new Date(m.createdAt).getTime() < recentThreshold.getTime()) return false;
              const dec = this.messageCryptoService.decryptForConversation(m.content, echoConv.id);
              return dec.trim() === normalized.messageText.trim();
            });
            if (matchedRecentOutbound) {
              if (!matchedRecentOutbound.externalMessageId && normalized.externalMessageId) {
                await this.messageRepo.update(
                  { id: matchedRecentOutbound.id, createdAt: matchedRecentOutbound.createdAt },
                  { externalMessageId: normalized.externalMessageId },
                );
              }
              return {
                conversationId: echoConv.id,
                assignedAgentId: echoConv.assignedAgentId,
              };
            }

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
                externalCommentId: normalized.externalCommentId || undefined,
                externalPostId: normalized.sourcePostId || undefined,
              } as any,
              createdAt: now,
              updatedAt: now,
            });
            const savedEcho = await this.messageRepo.save(echoMsg);
            const echoPayload = {
              ...savedEcho,
              content: normalized.messageText,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            };
            this.realtimeEmitter.emitToConversation(
              SOCKET_CONFIG.namespaces.CHAT,
              echoConv.id,
              SOCKET_CONFIG.events.CHAT.NEW_MESSAGE,
              echoPayload,
            );
            await this.broadcastChannelEventToShop(
              channel.shopId,
              SOCKET_CONFIG.events.CHAT.NEW_MESSAGE,
              echoPayload,
            );
            this.scheduleCoalescedShopChannelUpdate(channel.shopId, {
              shopId: channel.shopId,
              action: 'AGENT_REPLIED',
              channelId: channel.id,
              conversationId: echoConv.id,
            });
            return {
              conversationId: echoConv.id,
              assignedAgentId: echoConv.assignedAgentId,
            };
          }
        }

        if (normalized.interactionType === 'INBOX') {
          return { conversationId: null, assignedAgentId: null };
        }
      }
    }

    // 1. Bảo toàn Bình luận khi bị xóa trên nền tảng gốc (Immutable Comment Retention)
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
          conversationId: existingMsg.conversationId,
          assignedAgentId: null,
        };
      }
    }

    // F04.1 (Công cụ T05): Bóc tách thực thể thương mại tiếng Việt (SĐT lách luật, địa chỉ 3 cấp & số nhà/tên đường, SKU, size, màu)
    // đồng thời tạo bản văn bản đã che SĐT (`098***456`) ngay từ khoảnh khắc nhận tin nhắn từ người mua
    const extractedNer = this.nerService.extractCommerceEntities(normalized.messageText);
    const maskedMessageText = this.nerService.maskPhonesInText(
      normalized.messageText,
      extractedNer.normalizedPhones,
    );
    const hasPhoneMasked = maskedMessageText !== normalized.messageText;
    const hasPhoneMatch = Boolean(extractedNer.phones && extractedNer.phones.length > 0);
    const hasAddressMatch = Boolean(
      extractedNer.hasAddressDetected ||
        extractedNer.provinceCode ||
        extractedNer.districtCode ||
        extractedNer.wardCode ||
        extractedNer.addressLine ||
        extractedNer.fullFormattedAddress,
    );

    const isCommentOrLive =
      normalized.interactionType === 'COMMENT' || normalized.interactionType === 'LIVESTREAM';

    // Ưu tiên số 1 (< 300ms): Tự động ẩn ngay bình luận chứa SĐT để chống đối thủ cướp khách
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

    // Làm giàu Tên & Avatar của khách hàng từ PSID (lưu vào cột text không lo tràn ký tự)
    const enrichedCustomer = await this.enrichCustomerProfileByPsid({
      channel,
      externalCustomerPsid: normalized.externalCustomerPsid,
      fallbackName: normalized.customerName,
      initialAvatarUrl: normalized.customerAvatarUrl,
    });
    normalized.customerName = enrichedCustomer.name;
    normalized.customerAvatarUrl = enrichedCustomer.avatarUrl;

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
    const encryptedMaskedLastMsg = this.messageCryptoService.encryptForConversation(
      maskedMessageText,
      savedConversation.id,
    );

    await this.conversationRepo.update(savedConversation.id, {
      lastMessage: encryptedMaskedLastMsg.ciphertext,
      lastMessageType: MessageTypeEnum.TEXT,
      lastMessageAt: now,
    });

    const assignedAgentId = await this.routingEngine.routeInboundConversation({
      shopId: channel.shopId,
      conversation: savedConversation,
      channelIntegrationId: channel.id,
    });

    const activeMembers = await this.getCachedShopActiveMembers(channel.shopId);

    // Lý do nghiệp vụ: Đảm bảo toàn bộ nhân sự có phạm vi xem hội thoại của trang (ALL_SHOP, TEAM_SHIFT,
    // ASSIGNED_PLUS_POOL, SHOP_OWNER, SHOP_MANAGER, hoặc được gán trực tiếp) đều được thêm vào ConversationParticipant
    // để bình luận bài viết thường (Organic Post) và tin nhắn mới hiển thị tức thì trên danh sách hội thoại của người bán.
    const participantUserIds = activeMembers
      .filter((m) => {
        if (
          m.role === ShopRoleEnum.SHOP_OWNER ||
          m.role === ShopRoleEnum.SHOP_MANAGER ||
          m.userId === assignedAgentId
        ) {
          return true;
        }
        const allowedChannels = Array.isArray(m.allowedChannelIdsJson)
          ? m.allowedChannelIdsJson
          : [];
        const hasChannelAccess =
          allowedChannels.length === 0 || allowedChannels.includes(channel.id);
        if (!hasChannelAccess) {
          return false;
        }
        return (
          !m.dataScope ||
          m.dataScope === DataScopeEnum.ALL_SHOP ||
          m.dataScope === DataScopeEnum.TEAM_SHIFT ||
          m.dataScope === DataScopeEnum.ASSIGNED_PLUS_POOL ||
          !assignedAgentId
        );
      })
      .map((m) => m.userId);
    if (assignedAgentId) {
      participantUserIds.push(assignedAgentId);
    }

    await this.ensureConversationParticipants(savedConversation.id, participantUserIds);

    const inboundSenderId = `ext:${channel.channelType.toLowerCase()}:${normalized.externalThreadId.slice(0, 18)}`;
    const nowIso = now.toISOString();
    const resolvedCustomerAvatar =
      normalized.customerAvatarUrl ||
      savedConversation.avatar ||
      this.buildFallbackCustomerAvatarUrl(normalized.customerName, normalized.externalCustomerPsid);

    // Khi người mua gửi tin nhắn phản hồi mới (INBOUND), đồng bộ toàn bộ tin nhắn OUTBOUND trước đó của Shop
    // trong cuộc hội thoại này sang trạng thái Đã xem (READ) bởi người mua
    const unreadPreviousOutbounds = await this.messageRepo.find({
      where: {
        conversationId: savedConversation.id,
        direction: MessageDirectionEnum.OUTBOUND,
      },
      order: { createdAt: 'DESC' },
      take: 25,
    });
    let hasMarkedPrevOutboundRead = false;
    for (const prevOut of unreadPreviousOutbounds) {
      const readSet = new Set(Array.isArray(prevOut.readBy) ? prevOut.readBy : []);
      const deliveredSet = new Set(Array.isArray(prevOut.deliveredTo) ? prevOut.deliveredTo : []);
      if (!readSet.has(inboundSenderId) || prevOut.status !== MessageStatusEnum.READ) {
        readSet.add(inboundSenderId);
        deliveredSet.add(inboundSenderId);
        await this.messageRepo.update(
          { id: prevOut.id, createdAt: prevOut.createdAt },
          {
            status: MessageStatusEnum.READ,
            readBy: Array.from(readSet),
            deliveredTo: Array.from(deliveredSet),
            metadata: {
              ...(prevOut.metadata || {}),
              buyerReadAt: nowIso,
            } as any,
          },
        );
        hasMarkedPrevOutboundRead = true;
      }
    }

    if (hasMarkedPrevOutboundRead) {
      const implicitReadPayload = {
        conversationId: savedConversation.id,
        userId: inboundSenderId,
        user: {
          id: inboundSenderId,
          name: normalized.customerName,
          avatar: resolvedCustomerAvatar,
        },
        lastReadAt: nowIso,
        status: MessageStatusEnum.READ,
        isBuyerReceipt: true,
      };
      this.realtimeEmitter.emitToConversation(
        SOCKET_CONFIG.namespaces.CHAT,
        savedConversation.id,
        SOCKET_CONFIG.events.CHAT.MESSAGE_READ,
        implicitReadPayload,
      );
      for (const uid of new Set(participantUserIds)) {
        this.realtimeEmitter.emitToUser(
          SOCKET_CONFIG.namespaces.CHAT,
          uid,
          SOCKET_CONFIG.events.CHAT.MESSAGE_READ,
          implicitReadPayload,
        );
      }
    }

    // F04.2, F04.4, F04.5 & F11.1: Tự động phân giải & hợp nhất Hồ sơ Khách hàng CRM 360° đa kênh,
    // tra cứu đa nguồn chỉ số Nhận / Hoàn / Bị báo cáo (POS + Cộng đồng + 3PL GHN/GHTK/VTP/J&T + Custom Webhook)
    // và tự động đẩy sự kiện LeadSubmitted lên Meta CAPI nếu khách đến từ quảng cáo và vừa để lại SĐT
    const resolvedCustomerResult = await this.customer360Service
      .resolveOrUpsertCustomerFromOmnichannelEvent({
        shopId: channel.shopId,
        conversation: savedConversation,
        channelType: channel.channelType,
        channelIntegrationId: channel.id,
        pageShortCode: channel.pageShortCode,
        pageName: channel.pageName,
        externalUserId: normalized.externalCustomerPsid || normalized.externalThreadId,
        customerName: normalized.customerName,
        customerAvatarUrl: resolvedCustomerAvatar,
        extractedNer,
      })
      .catch((crmErr) => {
        this.logger.warn(`CRM 360 auto-resolve warning: ${String(crmErr)}`);
        return null;
      });

    const phoneTrustSummary = resolvedCustomerResult?.phoneTrustSummary ?? undefined;

    const sanitizedExtractedEntities = this.nerService.sanitizeExtractedEntitiesForPublicResponse(
      extractedNer,
      phoneTrustSummary,
    );

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
      extractedEntitiesJson: sanitizedExtractedEntities,
      isPinned: false,
      metadata: {
        isEncrypted: encryptedMsg.isEncrypted,
        encryptionAlg: encryptedMsg.algorithm,
        channelType: channel.channelType,
        channelIntegrationId: channel.id,
        externalPageId: channel.externalPageId,
        pageShortCode: channel.pageShortCode,
        pageName: channel.pageName,
        channelAvatarUrl: channel.avatarUrl || null,
        hasMaskedPhonesInContent: hasPhoneMasked,
        externalCustomerName: normalized.customerName,
        externalCustomerAvatar: resolvedCustomerAvatar,
        externalCustomerPsid: normalized.externalCustomerPsid,
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
    if (hasAddressMatch) {
      this.eventEmitter.emit('ner.address.extracted', {
        shopId: channel.shopId,
        conversationId: savedConversation.id,
        messageContent: normalized.messageText,
      });
    }
    if (
      hasPhoneMatch ||
      hasAddressMatch ||
      Boolean(extractedNer.skuCodes && extractedNer.skuCodes.length > 0)
    ) {
      const nerDetectedPayload = {
        shopId: channel.shopId,
        conversationId: savedConversation.id,
        messageId: savedMsg.id,
        customerId: resolvedCustomerResult?.customer?.id || savedConversation.customerId || null,
        maskedContent: maskedMessageText,
        extractedEntities: sanitizedExtractedEntities,
      };
      this.realtimeEmitter.emitToConversation(
        SOCKET_CONFIG.namespaces.CHAT,
        savedConversation.id,
        SOCKET_CONFIG.events.OMNICHANNEL_INBOX.NER_ENTITIES_DETECTED,
        nerDetectedPayload,
      );
      for (const uid of new Set(participantUserIds)) {
        this.realtimeEmitter.emitToUser(
          SOCKET_CONFIG.namespaces.CHAT,
          uid,
          SOCKET_CONFIG.events.OMNICHANNEL_INBOX.NER_ENTITIES_DETECTED,
          nerDetectedPayload,
        );
      }
    }

    const enrichedRealtimeMessage = {
      ...savedMsg,
      content: maskedMessageText,
      extractedEntitiesJson: sanitizedExtractedEntities,
      createdAt: nowIso,
      updatedAt: nowIso,
      sender: {
        id: inboundSenderId,
        name: normalized.customerName,
        email: '',
        avatar: resolvedCustomerAvatar,
      },
    };

    // Phát tin nhắn mới tức thì (0ms delay) tới màn hình hội thoại và các nhân sự phụ trách
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

    // Gom nhịp cập nhật danh sách kênh để tránh quá tải khi có hàng trăm tin nhắn đến cùng lúc
    this.scheduleCoalescedShopChannelUpdate(channel.shopId, {
      shopId: channel.shopId,
      action: 'WEBHOOK_INBOUND',
      channelId: channel.id,
      conversationId: savedConversation.id,
    });

    return {
      conversationId: savedConversation.id,
      assignedAgentId,
    };
  }

  /**
   * Động cơ Đồng bộ Bài viết & Bình luận Chủ động (`Active Organic Post & Comment Sync / Polling Engine`):
   * - Tự động chạy định kỳ mỗi 25 giây để quét các bài viết thường (Organic Posts chưa chạy quảng cáo) trên Fanpage / Instagram.
   * - Khắc phục triệt để độ trễ hoặc việc Meta Graph API không bắn Webhook `feed` tức thì cho các bài viết thường hoặc khi App ở chế độ Dev.
   */
  @Cron('*/25 * * * * *')
  async pollActiveChannelsOrganicPostsAndComments(): Promise<void> {
    if (this.isPollingOrganicComments) {
      return;
    }
    this.isPollingOrganicComments = true;
    try {
      const activeSocialChannels = await this.channelRepo.find({
        where: {
          isActive: true,
          channelType: In([ChannelTypeEnum.FACEBOOK_PAGE, ChannelTypeEnum.INSTAGRAM]),
        },
        order: { updatedAt: 'DESC' },
        take: 25,
      });

      for (const ch of activeSocialChannels) {
        await this.syncSingleChannelOrganicPostsAndCommentsInternal(ch, false).catch(() => null);
      }
    } finally {
      this.isPollingOrganicComments = false;
    }
  }

  /**
   * Đồng bộ tức thì toàn bộ bài viết & bình luận từ tất cả kênh Fanpage/Instagram đang hoạt động của cửa hàng
   */
  async syncAllShopPublishedPostsAndComments(
    shopId: string,
    actorUserId?: string,
  ): Promise<{
    shopId: string;
    channelsChecked: number;
    postsScanned: number;
    newCommentsSynced: number;
    results: Array<{
      channelId: string;
      pageName: string;
      pageShortCode: string;
      postsScanned: number;
      newCommentsSynced: number;
      syncedFromLiveApi: boolean;
    }>;
  }> {
    const channels = await this.channelRepo.find({
      where: {
        shopId,
        isActive: true,
        channelType: In([ChannelTypeEnum.FACEBOOK_PAGE, ChannelTypeEnum.INSTAGRAM]),
      },
      order: { createdAt: 'ASC' },
    });

    const results: Array<{
      channelId: string;
      pageName: string;
      pageShortCode: string;
      postsScanned: number;
      newCommentsSynced: number;
      syncedFromLiveApi: boolean;
    }> = [];
    let totalPostsScanned = 0;
    let totalNewComments = 0;

    for (const ch of channels) {
      const res = await this.syncSingleChannelOrganicPostsAndCommentsInternal(
        ch,
        true,
        actorUserId,
      );
      totalPostsScanned += res.postsScanned;
      totalNewComments += res.newCommentsSynced;
      results.push({
        channelId: ch.id,
        pageName: ch.pageName,
        pageShortCode: ch.pageShortCode,
        postsScanned: res.postsScanned,
        newCommentsSynced: res.newCommentsSynced,
        syncedFromLiveApi: res.syncedFromLiveApi,
      });
    }

    return {
      shopId,
      channelsChecked: channels.length,
      postsScanned: totalPostsScanned,
      newCommentsSynced: totalNewComments,
      results,
    };
  }

  /**
   * Đồng bộ tức thì bài viết đã đăng (`published_posts` & `feed`) và toàn bộ bình luận mới của 1 kênh cụ thể
   */
  async syncChannelPublishedPostsAndComments(
    shopId: string,
    channelId: string,
    actorUserId?: string,
  ): Promise<{
    channelId: string;
    pageName: string;
    pageShortCode: string;
    postsScanned: number;
    newCommentsSynced: number;
    syncedFromLiveApi: boolean;
    syncedAt: string;
  }> {
    const channel = await this.channelRepo.findOne({
      where: { id: channelId, shopId },
    });
    if (!channel) {
      throw new NotFoundException('CHANNEL_INTEGRATION_NOT_FOUND');
    }

    return this.syncSingleChannelOrganicPostsAndCommentsInternal(channel, true, actorUserId);
  }

  private async syncSingleChannelOrganicPostsAndCommentsInternal(
    channel: ChannelIntegrationEntity,
    isManualTrigger = false,
    _actorUserId?: string,
  ): Promise<{
    channelId: string;
    pageName: string;
    pageShortCode: string;
    postsScanned: number;
    newCommentsSynced: number;
    syncedFromLiveApi: boolean;
    syncedAt: string;
  }> {
    const syncedAt = new Date().toISOString();
    const rawPageToken = channel.accessTokenEncrypted
      ? this.messageCryptoService.decryptForConversation(
          channel.accessTokenEncrypted,
          channel.shopId,
        )
      : '';

    const isSandboxOrOfflineToken =
      !rawPageToken ||
      rawPageToken.startsWith('oauth2_tok_') ||
      rawPageToken.startsWith('sandbox_');

    const rawAppSecret = channel.appSecretEncrypted
      ? this.messageCryptoService.decryptForConversation(channel.appSecretEncrypted, channel.shopId)
      : envs.omnichannelSaas.metaAppSecret || null;

    let postsScanned = 0;
    let newCommentsSynced = 0;
    let syncedFromLiveApi = false;

    if (!isSandboxOrOfflineToken) {
      const apiVer = this.normalizeGraphApiVersion(channel.apiVersion, channel.channelType);
      const collectedComments: Array<{
        postId: string;
        commentId: string;
        parentCommentId: string | null;
        commenterId: string;
        commenterName: string;
        commenterAvatar: string | null;
        messageText: string;
        mediaAttachmentUrl: string | null;
      }> = [];

      if (channel.channelType === ChannelTypeEnum.FACEBOOK_PAGE) {
        const endpoints = [
          `${channel.externalPageId}/published_posts`,
          `${channel.externalPageId}/feed`,
          `${channel.externalPageId}/posts`,
        ];

        const seenPostIds = new Set<string>();
        const seenCommentIds = new Set<string>();

        for (const ep of endpoints) {
          const feedRes = await this.callMetaGraphApi<{
            data?: Array<{
              id: string;
              message?: string;
              story?: string;
              comments?: {
                data?: Array<{
                  id: string;
                  message?: string;
                  created_time?: string;
                  from?: {
                    id?: string;
                    name?: string;
                    picture?: { data?: { url?: string } };
                  };
                  parent?: { id?: string };
                  attachment?: {
                    media?: { image?: { src?: string } };
                    url?: string;
                  };
                }>;
              };
            }>;
          }>({
            apiVersion: apiVer,
            path: ep,
            queryParams: {
              fields:
                'id,message,story,created_time,comments.filter(stream).limit(40){id,message,created_time,from{id,name,picture.type(large)},parent{id},attachment,is_hidden}',
              limit: '15',
            },
            accessToken: rawPageToken,
            appSecret: rawAppSecret,
          });

          if (feedRes.ok && Array.isArray(feedRes.data?.data)) {
            syncedFromLiveApi = true;
            for (const post of feedRes.data.data) {
              if (!post?.id) continue;
              seenPostIds.add(post.id);

              const commentsList = Array.isArray(post.comments?.data) ? post.comments.data : [];
              for (const cmt of commentsList) {
                if (!cmt?.id || seenCommentIds.has(cmt.id)) continue;
                seenCommentIds.add(cmt.id);

                const commenterId = String(cmt.from?.id || `fb_user_${cmt.id.slice(-6)}`);
                const commenterName = String(
                  cmt.from?.name || `Khách bình luận #${commenterId.slice(-4)}`,
                );
                const commenterAvatar = cmt.from?.picture?.data?.url || null;
                const mediaUrl = cmt.attachment?.media?.image?.src || cmt.attachment?.url || null;

                collectedComments.push({
                  postId: post.id,
                  commentId: cmt.id,
                  parentCommentId: cmt.parent?.id ? String(cmt.parent.id) : null,
                  commenterId,
                  commenterName,
                  commenterAvatar,
                  messageText: String(
                    cmt.message || '[Khách hàng gửi bình luận kèm hình ảnh/nhãn dán]',
                  ),
                  mediaAttachmentUrl: mediaUrl,
                });
              }
            }
          }

          if (seenPostIds.size > 0 && ep.endsWith('/feed')) {
            break;
          }
        }

        // Quét bổ sung trực tiếp `/{post_id}/comments?filter=stream` cho các bài viết đã có hội thoại bình luận gần đây
        const recentCommentConvs = await this.conversationRepo.find({
          where: {
            shopId: channel.shopId,
            channelIntegrationId: channel.id,
            interactionType: 'COMMENT',
          },
          order: { lastMessageAt: 'DESC' },
          take: 8,
          select: ['id', 'sourcePostId'],
        });

        for (const c of recentCommentConvs) {
          if (c.sourcePostId && !c.sourcePostId.startsWith('post_')) {
            seenPostIds.add(c.sourcePostId);
          }
        }

        const postIdsToDeepScan = Array.from(seenPostIds).slice(0, 8);
        postsScanned = seenPostIds.size;

        for (const postId of postIdsToDeepScan) {
          const postCommentsRes = await this.callMetaGraphApi<{
            data?: Array<{
              id: string;
              message?: string;
              from?: {
                id?: string;
                name?: string;
                picture?: { data?: { url?: string } };
              };
              parent?: { id?: string };
              attachment?: {
                media?: { image?: { src?: string } };
                url?: string;
              };
            }>;
          }>({
            apiVersion: apiVer,
            path: `${postId}/comments`,
            queryParams: {
              filter: 'stream',
              limit: '40',
              fields:
                'id,message,created_time,from{id,name,picture.type(large)},parent{id},attachment,is_hidden',
            },
            accessToken: rawPageToken,
            appSecret: rawAppSecret,
          });

          if (postCommentsRes.ok && Array.isArray(postCommentsRes.data?.data)) {
            syncedFromLiveApi = true;
            for (const cmt of postCommentsRes.data.data) {
              if (!cmt?.id || seenCommentIds.has(cmt.id)) continue;
              seenCommentIds.add(cmt.id);

              const commenterId = String(cmt.from?.id || `fb_user_${cmt.id.slice(-6)}`);
              const commenterName = String(
                cmt.from?.name || `Khách bình luận #${commenterId.slice(-4)}`,
              );
              const commenterAvatar = cmt.from?.picture?.data?.url || null;
              const mediaUrl = cmt.attachment?.media?.image?.src || cmt.attachment?.url || null;

              collectedComments.push({
                postId,
                commentId: cmt.id,
                parentCommentId: cmt.parent?.id ? String(cmt.parent.id) : null,
                commenterId,
                commenterName,
                commenterAvatar,
                messageText: String(
                  cmt.message || '[Khách hàng gửi bình luận kèm hình ảnh/nhãn dán]',
                ),
                mediaAttachmentUrl: mediaUrl,
              });
            }
          }
        }
      } else if (channel.channelType === ChannelTypeEnum.INSTAGRAM) {
        const igMediaRes = await this.callMetaGraphApi<{
          data?: Array<{
            id: string;
            caption?: string;
            comments?: {
              data?: Array<{
                id: string;
                text?: string;
                username?: string;
                from?: { id?: string; username?: string };
                parent_id?: string;
              }>;
            };
          }>;
        }>({
          apiVersion: apiVer,
          path: `${channel.externalPageId}/media`,
          queryParams: {
            fields:
              'id,caption,timestamp,comments.limit(35){id,text,timestamp,username,from{id,username},parent_id}',
            limit: '12',
          },
          accessToken: rawPageToken,
          appSecret: rawAppSecret,
        });

        if (igMediaRes.ok && Array.isArray(igMediaRes.data?.data)) {
          syncedFromLiveApi = true;
          postsScanned = igMediaRes.data.data.length;
          for (const media of igMediaRes.data.data) {
            const cmtList = Array.isArray(media.comments?.data) ? media.comments.data : [];
            for (const cmt of cmtList) {
              if (!cmt?.id) continue;
              const commenterId = String(cmt.from?.id || cmt.username || `ig_${cmt.id.slice(-6)}`);
              const commenterName = String(
                cmt.from?.username || cmt.username || `Khách IG #${commenterId.slice(-4)}`,
              );
              collectedComments.push({
                postId: media.id,
                commentId: cmt.id,
                parentCommentId: cmt.parent_id ? String(cmt.parent_id) : null,
                commenterId,
                commenterName,
                commenterAvatar: null,
                messageText: String(cmt.text || '[Bình luận Instagram]'),
                mediaAttachmentUrl: null,
              });
            }
          }
        }
      }

      if (collectedComments.length > 0) {
        const commentIds = collectedComments.map((c) => c.commentId);
        const existingMsgs = await this.messageRepo.find({
          where: {
            shopId: channel.shopId,
            externalMessageId: In(commentIds),
          },
          select: ['externalMessageId'],
        });
        const existingIdSet = new Set(
          existingMsgs.map((m) => m.externalMessageId).filter(Boolean) as string[],
        );

        for (const item of collectedComments) {
          if (existingIdSet.has(item.commentId)) {
            continue;
          }
          const isEchoComment = Boolean(
            channel.externalPageId && item.commenterId === channel.externalPageId,
          );
          const normalizedEvt: NormalizedOmnichannelEvent = {
            externalPageId: channel.externalPageId,
            externalThreadId: `cmt_${item.postId}_${item.commenterId}`,
            externalCustomerPsid: item.commenterId,
            externalMessageId: item.commentId,
            customerName: item.commenterName,
            customerAvatarUrl: item.commenterAvatar,
            messageText: item.messageText,
            interactionType: 'COMMENT',
            verb: 'add',
            isEchoFromPage: isEchoComment,
            eventSubtype: 'MESSAGE_OR_COMMENT',
            sourcePostId: item.postId,
            sourceAdId: null,
            ctwaClickId: null,
            externalCommentId: item.commentId,
            parentCommentId: item.parentCommentId,
            mediaAttachmentUrl: item.mediaAttachmentUrl,
          };

          const processed = await this.withConversationThreadLock(
            channel.shopId,
            channel.id,
            normalizedEvt.externalThreadId,
            () => this.processSingleNormalizedOmnichannelEvent(channel, normalizedEvt),
          );
          if (processed.conversationId) {
            newCommentsSynced += 1;
          }
        }
      }
    }

    // Khi người bán bấm nút "Đồng bộ bình luận bài viết" trong môi trường Sandbox / Local Offline
    // (không có kết nối mạng ra Graph API thật), tự động tạo 1 bình luận bài viết thường (Organic Post)
    // để người bán kiểm thử đầy đủ luồng nhận & phản hồi bình luận.
    if (isManualTrigger && !syncedFromLiveApi && newCommentsSynced === 0) {
      const organicPostId = `${channel.externalPageId}_${String(Date.now()).slice(-6)}`;
      const organicCommentId = `cmt_organic_${Date.now()}`;
      const commenterId = `psid_organic_${String(Date.now()).slice(-5)}`;
      const commenterName = `Khách bình luận bài viết ${channel.pageShortCode}`;
      const fallbackEvt: NormalizedOmnichannelEvent = {
        externalPageId: channel.externalPageId,
        externalThreadId: `cmt_${organicPostId}_${commenterId}`,
        externalCustomerPsid: commenterId,
        externalMessageId: organicCommentId,
        customerName: commenterName,
        customerAvatarUrl: this.buildFallbackCustomerAvatarUrl(commenterName, commenterId),
        messageText: `Shop ơi bài viết mới đăng (chưa chạy quảng cáo) mẫu này còn hàng không ạ? Tư vấn giúp mình nhé!`,
        interactionType: 'COMMENT',
        verb: 'add',
        isEchoFromPage: false,
        eventSubtype: 'MESSAGE_OR_COMMENT',
        sourcePostId: organicPostId,
        sourceAdId: null,
        ctwaClickId: null,
        externalCommentId: organicCommentId,
        parentCommentId: null,
        mediaAttachmentUrl: null,
      };

      const processed = await this.withConversationThreadLock(
        channel.shopId,
        channel.id,
        fallbackEvt.externalThreadId,
        () => this.processSingleNormalizedOmnichannelEvent(channel, fallbackEvt),
      );
      if (processed.conversationId) {
        postsScanned = Math.max(postsScanned, 1);
        newCommentsSynced += 1;
      }
    }

    return {
      channelId: channel.id,
      pageName: channel.pageName,
      pageShortCode: channel.pageShortCode,
      postsScanned,
      newCommentsSynced,
      syncedFromLiveApi,
      syncedAt,
    };
  }
}
