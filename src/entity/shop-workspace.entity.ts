import { ShopBusinessCategoryEnum } from 'src/common/enum';
import { ChannelTypeEnum, RoutingStrategyEnum } from 'src/common/enum/permission.enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export interface CommissionSplitConfig {
  leadCollectorWeight: number;
  orderCloserWeight: number;
  deductOnReturnedOrder: boolean;
}

export interface MarketplaceSyncConfig {
  autoReserveStockOnMarketplaceOrder: boolean;
  safetyBufferStockQty: number;
  pushAvailableStockToShopeeTikTok: boolean;
}

/**
 * Cấu hình Nguồn Dữ Liệu Tra Cứu Chỉ Số Nhận / Hoàn / Bị Báo Cáo Của SĐT & Cấu Hình Hồ Sơ Theo Ngành Hàng
 * Tham chiếu nghiệp vụ Pancake CRM, Pancake POS & Mạng lưới đối tác vận chuyển 3PL (GHN, GHTK, ViettelPost, J&T).
 */
export interface CrmTrustAndIndustryConfig {
  enableAutoTrustLookupOnPhone: boolean;
  useInternalPosHistory: boolean;
  usePancakeCommunityNetwork: boolean;
  useCarrier3plLookup: boolean;
  enabledCarriers: Array<'GHN' | 'GHTK' | 'VTP' | 'JT'>;
  customLookupWebhookUrl: string | null;
  customLookupApiKeyEncrypted?: string | null;
  highRiskReturnRateThresholdPercent: number;
  highRiskReportedCountThreshold: number;
  autoMaskBuyerPhoneInChat: boolean;
  autoExtractAddressFromChat: boolean;
  businessCategory: ShopBusinessCategoryEnum;
  showApparelMeasurementsInProfile: boolean;
  customAttributeTemplates: Array<{
    key: string;
    label: string;
    placeholder?: string;
  }>;
  updatedAt?: string;
}

/**
 * Hồ sơ cấu hình Ứng dụng SaaS (SaasAppProfileItem):
 * Cho phép 1 cửa hàng cấu hình nhiều Ứng dụng SaaS cho cùng 1 nền tảng (VD: Nhiều Meta App ID / BM khác nhau
 * để cách ly Rate-Limit và dự phòng rủi ro, hoặc nhiều Zalo OA App / TikTok Partner App).
 * Khi kết nối Fanpage/Kênh mới, người dùng chỉ cần chọn Hồ sơ SaaS (hoặc dùng hồ sơ mặc định) và dán Access Token,
 * hệ thống sẽ tự động lấy thông tin trang và tự động tiêm (Auto-Inject) Webhook.
 */
export interface SaasAppProfileItem {
  id: string;
  name: string;
  channelType: ChannelTypeEnum;
  apiVersion: string;
  appId: string;
  appSecretEncrypted: string | null;
  webhookVerifyTokenEncrypted: string | null;
  webhookCallbackUrl: string;
  subscribedFields: string[];
  autoHidePhoneComments: boolean;
  syncEchoMessagesFromNativeApp: boolean;
  autoInjectWebhookOnConnect: boolean;
  isDefault: boolean;
  isActive: boolean;
  appWebhookRegistered?: boolean;
  lastVerifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

@Entity('shop_workspaces')
@Index('idx_shop_workspace_code', ['code'], { unique: true })
@Index('uq_shop_workspace_join_code', ['joinCode'], { unique: true })
@Index('idx_shop_workspace_owner', ['ownerId'])
export class ShopWorkspaceEntity extends BaseModel {
  @Column({ name: 'code', type: 'varchar', length: 32, unique: true })
  code: string;

  @Column({ name: 'join_code', type: 'varchar', length: 16, unique: true })
  joinCode: string;

  @Column({ name: 'name', type: 'varchar', length: 255 })
  name: string;

  // Mở rộng sang kiểu text để lưu đường dẫn URL Logo dài (Presigned S3 / CDN URL) không bị tràn ký tự
  @Column({ name: 'logo_url', type: 'text', nullable: true, default: null })
  logoUrl: string | null;

  @Column({ name: 'owner_id', type: 'varchar', length: 36 })
  ownerId: string;

  @Column({ name: 'default_currency', type: 'varchar', length: 8, default: 'VND' })
  defaultCurrency: string;

  @Column({ name: 'timezone', type: 'varchar', length: 64, default: 'Asia/Ho_Chi_Minh' })
  timezone: string;

  @Column({ name: 'sla_response_seconds', type: 'int', default: 180 })
  slaResponseSeconds: number;

  @Column({ name: 'ghosted_alert_seconds', type: 'int', default: 180 })
  ghostedAlertSeconds: number;

  @Column({ name: 'auto_reclaim_minutes', type: 'int', default: 5 })
  autoReclaimMinutes: number;

  @Column({
    name: 'routing_strategy',
    type: 'enum',
    enum: RoutingStrategyEnum,
    default: RoutingStrategyEnum.STICKY_AGENT,
  })
  routingStrategy: RoutingStrategyEnum;

  @Column({ name: 'lock_order_after_print', type: 'boolean', default: true })
  lockOrderAfterPrint: boolean;

  @Column({ name: 'require_deposit_on_high_risk', type: 'boolean', default: true })
  requireDepositOnHighRisk: boolean;

  @Column({ name: 'commission_split_config_json', type: 'json' })
  commissionSplitConfigJson: CommissionSplitConfig;

  @Column({ name: 'marketplace_sync_config_json', type: 'json' })
  marketplaceSyncConfigJson: MarketplaceSyncConfig;

  @Column({ name: 'saas_app_profiles_json', type: 'json', nullable: true, default: null })
  saasAppProfilesJson: SaasAppProfileItem[] | null;

  @Column({
    name: 'crm_trust_and_industry_config_json',
    type: 'json',
    nullable: true,
    default: null,
  })
  crmTrustAndIndustryConfigJson: CrmTrustAndIndustryConfig | null;
}
