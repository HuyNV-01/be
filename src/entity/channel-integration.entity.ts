import { ChannelTypeEnum, WebhookIntegrationStatusEnum } from 'src/common/enum/permission.enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export interface ChannelPlatformSaasConfig {
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
}

@Entity('channel_integrations')
@Index('uq_channel_ext_page', ['shopId', 'channelType', 'externalPageId'], { unique: true })
@Index('idx_channel_webhook_lookup', ['channelType', 'externalPageId'])
export class ChannelIntegrationEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({
    name: 'channel_type',
    type: 'enum',
    enum: ChannelTypeEnum,
  })
  channelType: ChannelTypeEnum;

  @Column({ name: 'external_page_id', type: 'varchar', length: 128 })
  externalPageId: string;

  @Column({ name: 'external_shop_id', type: 'varchar', length: 128, nullable: true, default: null })
  externalShopId: string | null;

  @Column({ name: 'page_name', type: 'varchar', length: 200 })
  pageName: string;

  @Column({ name: 'page_short_code', type: 'varchar', length: 24 })
  pageShortCode: string;

  @Column({ name: 'avatar_url', type: 'varchar', length: 500, nullable: true, default: null })
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

  @Column({
    name: 'last_error_message',
    type: 'varchar',
    length: 500,
    nullable: true,
    default: null,
  })
  lastErrorMessage: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
