import { ProductIndustryTypeEnum, ShopBusinessCategoryEnum } from 'src/common/enum';
import { ChannelTypeEnum, RoutingStrategyEnum } from 'src/common/enum/permission.enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';
import { ProductFreeGiftRuleItem } from './product.entity';

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
 * Cấu hình Trường Nhập Liệu Tư Vấn Động (`SellerAdvisorFieldSchema`) do Người bán tự định nghĩa cho từng Ngành hàng / Danh mục.
 * Loại bỏ hoàn toàn việc hardcode các nhánh `if (advisorMode === 'FASHION_APPAREL')` trên giao diện POS.
 */
export interface SellerAdvisorFieldOption {
  value: string;
  label: string;
}

export interface SellerAdvisorFieldSchema {
  fieldKey: string;
  label: string;
  unit?: string;
  fieldType: 'NUMBER' | 'SELECT' | 'TEXT';
  placeholder?: string;
  defaultValue?: number | string;
  min?: number;
  max?: number;
  options?: SellerAdvisorFieldOption[];
  /**
   * Liên kết tự động với dữ liệu NER bóc tách từ tin nhắn hoặc Hồ sơ CRM 360 (`heightCm` | `weightKg`)
   */
  nerAutoFillField?: 'heightCm' | 'weightKg' | null;
}

/**
 * Quy tắc Đối chiếu Tư vấn Thông số / Kích cỡ Động (`SellerAdvisorRuleRow`) do Người bán tự cấu hình
 */
export interface SellerAdvisorRuleRow {
  ruleId: string;
  recommendedResultCode: string;
  fitNote: string;
  /**
   * Điều kiện khoảng số học: ví dụ `{ heightCm: { min: 155, max: 165 }, weightKg: { min: 48, max: 55 } }`
   * hoặc `{ footLengthCm: { min: 24, max: 24.5 } }`
   */
  numericRanges?: Record<string, { min: number; max: number }>;
  /**
   * Điều kiện khớp chính xác hoặc từ khóa: ví dụ `{ skinType: 'OILY' }`
   */
  exactMatches?: Record<string, string>;
  /**
   * Từ khóa SKU hoặc giá trị thuộc tính liên kết để tự động lọc ra các biến thể còn tồn kho trong In-Chat POS
   */
  linkedSkuKeyword?: string;
}

/**
 * Cấu hình Ngành hàng / Danh mục Sản phẩm Động do Người bán tự thiết lập (`SellerCategoryBlueprintItem`)
 */
export interface SellerCategoryBlueprintItem {
  categoryId: string;
  code: string;
  name: string;
  badgeLabel: string;
  iconEmoji?: string;
  industryType: ProductIndustryTypeEnum;
  defaultUnitName: string;
  attributeAxis1Name: string;
  attributeAxis1SampleValues: string[];
  attributeAxis2Name: string;
  attributeAxis2SampleValues: string[];
  requiresSerialImei: boolean;
  defaultWarrantyMonths: number;
  requiresBatchExpiry: boolean;
  defaultShelfLifeMonths: number;
  defaultStorageCondition?: string | null;
  defaultMaxDiscountPercent: number;
  enableAdvisorInPos: boolean;
  advisorTitle: string;
  advisorFields: SellerAdvisorFieldSchema[];
  advisorRules: SellerAdvisorRuleRow[];
  isActive: boolean;
  sortOrder: number;
}

/**
 * Cấu hình Tài khoản Ngân hàng Thụ hưởng VietQR EMVCo của Cửa hàng (`SellerVietQrBankConfig`)
 */
export interface SellerVietQrBankConfig {
  bankBin: string;
  bankShortName: string;
  accountNumber: string;
  accountName: string;
  transferPrefix: string;
  autoConfirmWebhookEnabled: boolean;
}

/**
 * Cấu hình Tổng thể Danh mục Ngành hàng Động, Khuyến mãi Quà tặng kèm & Thanh toán VietQR của Cửa hàng (`ShopCatalogAndPosConfig`)
 */
export interface ShopCatalogAndPosConfig {
  categories: SellerCategoryBlueprintItem[];
  freeGiftRules: ProductFreeGiftRuleItem[];
  vietQrBankConfig: SellerVietQrBankConfig;
  autoSeedDemoCatalogWhenEmpty: boolean;
  hasInitializedDefaultCatalog?: boolean;
  updatedAt: string;
}

/**
 * Hồ sơ cấu hình Ứng dụng SaaS (SaasAppProfileItem)
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

  @Column({
    name: 'catalog_and_pos_config_json',
    type: 'json',
    nullable: true,
    default: null,
  })
  catalogAndPosConfigJson: ShopCatalogAndPosConfig | null;
}
