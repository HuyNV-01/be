import { ChannelTypeEnum, WebhookIntegrationStatusEnum } from 'src/common/enum/permission.enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export type PageTokenRecoverySourceType =
  | 'FB_EXCHANGE_NEVER_EXPIRING'
  | 'USER_LONG_LIVED_ACCOUNT_DERIVATION'
  | 'SIBLING_CHANNEL_USER_TOKEN'
  | 'ZALO_OA_REFRESH_TOKEN'
  | 'DIRECT_PAGE_TOKEN'
  | 'SANDBOX';

export interface ChannelPlatformSaasConfig {
  saasAppProfileId?: string | null;
  saasAppProfileName?: string | null;
  apiVersion?: string | null;
  appId?: string | null;
  webhookCallbackUrl?: string | null;
  subscribedFields?: string[];
  tokenKind?: 'PAGE_TOKEN' | 'USER_TOKEN' | 'OA_TOKEN' | 'SHOP_TOKEN' | 'SANDBOX_TOKEN';
  authenticatedUserId?: string | null;
  authenticatedUserName?: string | null;
  pageCategory?: string | null;
  pageTasks?: string[];
  requireAppSecretProof?: boolean;
  autoHidePhoneComments?: boolean;
  autoHideKeywordList?: string[];
  syncEchoMessagesFromNativeApp?: boolean;
  webhookAutoInjected?: boolean;
  webhookInjectedAt?: string | null;
  subscribedAppsVerifiedOnPlatform?: boolean;
  isNeverExpiringPageToken?: boolean;
  userLongLivedTokenEncrypted?: string | null;
  userTokenExpiresAt?: string | null;
  lastTokenRefreshedAt?: string | null;
  autoRefreshPageTokenEnabled?: boolean;
  tokenRecoverySource?: PageTokenRecoverySourceType | null;
}

@Entity('channel_integrations')
@Index('uq_channel_ext_page', ['shopId', 'channelType', 'externalPageId'], { unique: true })
@Index('idx_channel_webhook_lookup', ['channelType', 'externalPageId'])
@Index('idx_channel_shop_saas_profile', ['shopId', 'saasAppProfileId'])
export class ChannelIntegrationEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({
    name: 'channel_type',
    type: 'enum',
    enum: ChannelTypeEnum,
  })
  channelType: ChannelTypeEnum;

  @Column({
    name: 'saas_app_profile_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    default: null,
  })
  saasAppProfileId: string | null;

  @Column({ name: 'external_page_id', type: 'varchar', length: 128 })
  externalPageId: string;

  @Column({ name: 'external_shop_id', type: 'varchar', length: 128, nullable: true, default: null })
  externalShopId: string | null;

  @Column({ name: 'page_name', type: 'varchar', length: 255 })
  pageName: string;

  @Column({ name: 'page_short_code', type: 'varchar', length: 32 })
  pageShortCode: string;

  // Chuyển từ varchar(500) sang text vì URL ảnh đại diện từ Facebook Graph API (scontent.fbcdn.net)
  // hoặc Zalo OA kèm chuỗi chữ ký bảo mật thường dài từ 600 đến > 1.800 ký tự.
  @Column({ name: 'avatar_url', type: 'text', nullable: true, default: null })
  avatarUrl: string | null;

  @Column({ name: 'api_version', type: 'varchar', length: 24, nullable: true, default: 'v27.1' })
  apiVersion: string | null;

  @Column({ name: 'app_id', type: 'varchar', length: 128, nullable: true, default: null })
  appId: string | null;

  @Column({ name: 'app_secret_encrypted', type: 'text', nullable: true, default: null })
  appSecretEncrypted: string | null;

  @Column({ name: 'access_token_encrypted', type: 'text' })
  accessTokenEncrypted: string;

  @Column({ name: 'refresh_token_encrypted', type: 'text', nullable: true, default: null })
  refreshTokenEncrypted: string | null;

  @Column({ name: 'webhook_verify_secret_encrypted', type: 'text', nullable: true, default: null })
  webhookVerifySecretEncrypted: string | null;

  @Column({ name: 'platform_config_json', type: 'json', nullable: true, default: null })
  platformConfigJson: ChannelPlatformSaasConfig | null;

  @Column({ name: 'meta_dataset_id', type: 'varchar', length: 128, nullable: true, default: null })
  metaDatasetId: string | null;

  @Column({ name: 'capi_access_token_encrypted', type: 'text', nullable: true, default: null })
  capiAccessTokenEncrypted: string | null;

  @Column({ name: 'token_expires_at', type: 'datetime', nullable: true, default: null })
  tokenExpiresAt: Date | null;

  @Column({
    name: 'webhook_status',
    type: 'enum',
    enum: WebhookIntegrationStatusEnum,
    default: WebhookIntegrationStatusEnum.HEALTHY,
  })
  webhookStatus: WebhookIntegrationStatusEnum;

  @Column({ name: 'last_webhook_received_at', type: 'datetime', nullable: true, default: null })
  lastWebhookReceivedAt: Date | null;

  // Chuyển sang kiểu text để lưu trọn vẹn thông báo lỗi chi tiết từ Graph API / Sàn TMĐT mà không bị tràn cột
  @Column({
    name: 'last_error_message',
    type: 'text',
    nullable: true,
    default: null,
  })
  lastErrorMessage: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
