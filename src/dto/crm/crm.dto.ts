import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  AdsConversionEventNameEnum,
  AdsConversionPlatformEnum,
  ChannelTypeEnum,
  CustomerTierEnum,
  CustomerWalletLedgerTypeEnum,
  CustomerWalletTransactionTypeEnum,
  RfmSegmentCodeEnum,
  SecurityAuditActionCodeEnum,
  ShopBusinessCategoryEnum,
} from 'src/common/enum';

export class ExtractVietnameseNerDto {
  @ApiProperty({
    description:
      'Nội dung tin nhắn hoặc bình luận tiếng Việt cần bóc tách SĐT, địa chỉ 3 cấp & 4 cấp hành chính, SKU, size, màu',
    example:
      'Cho chị 2 đầm A12 màu kem size M (1m60 52kg) về số 15 ngõ 68 Tổ dân phố số 2 Phường Quan Hoa Cầu Giấy HN nhé, sđt không chín tám tám 123 bốn năm sáu',
  })
  @IsString()
  @IsNotEmpty()
  text: string;

  @ApiPropertyOptional({
    description: 'ID cửa hàng tùy chọn nếu gọi qua endpoint alias /crm/ner/extract',
  })
  @IsOptional()
  @IsString()
  shopId?: string;

  @ApiPropertyOptional({
    description: 'ID cuộc hội thoại để tự động gắn kết quả vào tin nhắn và hồ sơ khách hàng',
  })
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiPropertyOptional({ description: 'ID tin nhắn cần cập nhật extractedEntitiesJson' })
  @IsOptional()
  @IsString()
  messageId?: string;
}

export class ResolveAdministrativeCrosswalkDto {
  @ApiPropertyOptional({
    description:
      'Chế độ địa giới hành chính ưu tiên hiển thị (3_TIER: 34 tỉnh mới không cấp huyện | 4_TIER: 63 tỉnh - 704 quận/huyện)',
    enum: ['3_TIER', '4_TIER'],
    default: '3_TIER',
  })
  @IsOptional()
  @IsString()
  preferredMode?: '3_TIER' | '4_TIER';

  @ApiPropertyOptional({ description: 'Mã Tỉnh/Thành phố (thuộc bộ 34 tỉnh mới hoặc 63 tỉnh cũ)' })
  @IsOptional()
  @IsString()
  provinceCode?: string | null;

  @ApiPropertyOptional({
    description: 'Mã Quận/Huyện/Thị xã/TP thuộc tỉnh (tùy chọn, dùng cho 4 cấp cũ hoặc 3PL)',
  })
  @IsOptional()
  @IsString()
  districtCode?: string | null;

  @ApiPropertyOptional({
    description: 'Mã Phường/Xã/Đặc khu/Thị trấn (thuộc bộ 3.321 xã mới hoặc 9.752+ xã cũ)',
  })
  @IsOptional()
  @IsString()
  wardCode?: string | null;

  @ApiPropertyOptional({ description: 'Mã Thôn/Ấp/Bản/Khu phố/Tổ dân phố/KĐT (cấp cơ sở)' })
  @IsOptional()
  @IsString()
  hamletCode?: string | null;

  @ApiPropertyOptional({
    description: 'Tên Thôn/Ấp/Bản/Khu phố/Tổ dân phố/Đường phố (Level 4 GHTK)',
  })
  @IsOptional()
  @IsString()
  hamletName?: string | null;

  @ApiPropertyOptional({ description: 'Số nhà, ngõ/ngách, tên đường chi tiết' })
  @IsOptional()
  @IsString()
  addressLine?: string | null;

  @ApiPropertyOptional({
    description: 'Chuỗi địa chỉ tự do để tự động bóc tách nếu chưa truyền mã code',
  })
  @IsOptional()
  @IsString()
  rawText?: string | null;
}

export class BuildCarrierAddressPayloadDto {
  @ApiPropertyOptional({ description: 'Tên người nhận hàng' })
  @IsOptional()
  @IsString()
  receiverName?: string;

  @ApiPropertyOptional({
    description: 'Số điện thoại người nhận (hoặc truyền customerId để giải mã từ PII Vault)',
  })
  @IsOptional()
  @IsString()
  receiverPhone?: string;

  @ApiPropertyOptional({
    description: 'ID khách hàng trong CRM 360 để giải mã SĐT trong RAM khi tạo đơn',
  })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Mã Tỉnh/Thành người gửi (Kho xuất hàng)' })
  @IsOptional()
  @IsString()
  senderProvinceCode?: string | null;

  @ApiPropertyOptional({ description: 'Mã Quận/Huyện người gửi (Kho xuất hàng)' })
  @IsOptional()
  @IsString()
  senderDistrictCode?: string | null;

  @ApiPropertyOptional({ description: 'Mã Phường/Xã người gửi (Kho xuất hàng)' })
  @IsOptional()
  @IsString()
  senderWardCode?: string | null;

  @ApiPropertyOptional({ description: 'Địa chỉ chi tiết kho gửi hàng' })
  @IsOptional()
  @IsString()
  senderAddressLine?: string | null;

  @ApiPropertyOptional({ description: 'Mã Tỉnh/Thành người nhận (34 tỉnh mới hoặc 63 tỉnh cũ)' })
  @IsOptional()
  @IsString()
  receiverProvinceCode?: string | null;

  @ApiPropertyOptional({ description: 'Mã Quận/Huyện người nhận (nếu có)' })
  @IsOptional()
  @IsString()
  receiverDistrictCode?: string | null;

  @ApiPropertyOptional({ description: 'Mã Phường/Xã/Đặc khu người nhận (3 cấp mới hoặc 4 cấp cũ)' })
  @IsOptional()
  @IsString()
  receiverWardCode?: string | null;

  @ApiPropertyOptional({ description: 'Mã Thôn/Ấp/Khu phố/Tổ dân phố người nhận' })
  @IsOptional()
  @IsString()
  receiverHamletCode?: string | null;

  @ApiPropertyOptional({
    description: 'Tên Thôn/Ấp/Khu phố/Tổ dân phố người nhận (bắt buộc cho GHTK Level-4)',
  })
  @IsOptional()
  @IsString()
  receiverHamletName?: string | null;

  @ApiPropertyOptional({ description: 'Số nhà, tên đường người nhận' })
  @IsOptional()
  @IsString()
  receiverAddressLine?: string | null;

  @ApiPropertyOptional({ description: 'Trọng lượng kiện hàng (gram)', default: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  weightGrams?: number;

  @ApiPropertyOptional({ description: 'Chiều dài kiện hàng (cm)', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  lengthCm?: number;

  @ApiPropertyOptional({ description: 'Chiều rộng kiện hàng (cm)', default: 15 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  widthCm?: number;

  @ApiPropertyOptional({ description: 'Chiều cao kiện hàng (cm)', default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  heightCm?: number;

  @ApiPropertyOptional({ description: 'Số tiền thu hộ COD (VND)', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  codAmount?: number;

  @ApiPropertyOptional({
    description: 'Giá trị khai giá / bảo hiểm hàng hóa (VND)',
    default: 350000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  insuranceValue?: number;
}

export class EstimateMultiCarrierShippingFeeDto extends BuildCarrierAddressPayloadDto {
  @ApiPropertyOptional({
    description: 'Token API Giao Hàng Nhanh (tùy chọn để gọi trực tiếp cổng GHN)',
  })
  @IsOptional()
  @IsString()
  ghnToken?: string;

  @ApiPropertyOptional({ description: 'ShopId trên hệ thống Giao Hàng Nhanh' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  ghnShopId?: number;

  @ApiPropertyOptional({
    description: 'Token API Giao Hàng Tiết Kiệm (tùy chọn để gọi trực tiếp cổng GHTK)',
  })
  @IsOptional()
  @IsString()
  ghtkToken?: string;

  @ApiPropertyOptional({
    description: 'Token API ViettelPost (tùy chọn để gọi trực tiếp cổng VTP)',
  })
  @IsOptional()
  @IsString()
  vtpToken?: string;
}

export class SyncAdministrativeUnitsDto {
  @ApiPropertyOptional({
    description: 'Token API Giao Hàng Nhanh để đồng bộ Master Data Tỉnh/Huyện/Xã',
  })
  @IsOptional()
  @IsString()
  ghnToken?: string;

  @ApiPropertyOptional({ description: 'Token API Giao Hàng Tiết Kiệm để đồng bộ Địa chỉ Level 4' })
  @IsOptional()
  @IsString()
  ghtkToken?: string;

  @ApiPropertyOptional({
    description: 'Token API ViettelPost để đồng bộ Danh mục Tỉnh/Huyện/Xã VTP',
  })
  @IsOptional()
  @IsString()
  vtpToken?: string;

  @ApiPropertyOptional({
    description: 'Mã Phường/Xã tùy chọn để đồng bộ sâu danh sách Thôn/Ấp Level-4',
  })
  @IsOptional()
  @IsString()
  wardCode?: string;
}

export class CustomerListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Tìm kiếm theo Tên, Mã KH hoặc Số điện thoại (tự động băm HMAC-SHA256)',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: CustomerTierEnum })
  @IsOptional()
  @IsEnum(CustomerTierEnum)
  tier?: CustomerTierEnum;

  @ApiPropertyOptional({ enum: RfmSegmentCodeEnum })
  @IsOptional()
  @IsEnum(RfmSegmentCodeEnum)
  rfmSegment?: RfmSegmentCodeEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  highRiskOnly?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  blacklistedOnly?: boolean;
}

export class UpsertCustomerProfileDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  fullName: string;

  @ApiPropertyOptional({
    description: 'Số điện thoại gốc (sẽ được mã hóa AES-256-GCM và băm chỉ mục mù HMAC-SHA256)',
  })
  @IsOptional()
  @IsString()
  rawPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultProvinceCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultDistrictCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultWardCode?: string;

  @ApiPropertyOptional({
    description: 'Mã đơn vị hành chính cấp 4 (Thôn / Ấp / Bản / Khu phố / Tổ dân phố / Khóm)',
  })
  @IsOptional()
  @IsString()
  defaultHamletCode?: string;

  @ApiPropertyOptional({
    description: 'Tên đơn vị hành chính cấp 4 (Thôn / Ấp / Bản / Khu phố / Tổ dân phố / Khóm)',
  })
  @IsOptional()
  @IsString()
  defaultHamletName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultAddressLine?: string;

  @ApiPropertyOptional({ enum: CustomerTierEnum })
  @IsOptional()
  @IsEnum(CustomerTierEnum)
  tier?: CustomerTierEnum;

  @ApiPropertyOptional({ enum: ShopBusinessCategoryEnum })
  @IsOptional()
  @IsString()
  industryCategory?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  heightCm?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  weightKg?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  preferredSize?: string | null;

  @ApiPropertyOptional({
    description: 'Danh sách thuộc tính tùy chỉnh theo ngành hàng (Loại da, IMEI, Khẩu vị...)',
  })
  @IsOptional()
  @IsArray()
  customAttributesJson?: Array<{ key: string; label: string; value: string }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  activeTagIdsJson?: string[];

  @ApiPropertyOptional({
    description: 'ID cuộc hội thoại cần liên kết ngay với hồ sơ khách hàng này',
  })
  @IsOptional()
  @IsString()
  conversationId?: string;
}

export class ToggleCustomerBlacklistDto {
  @ApiProperty()
  @IsBoolean()
  isBlacklisted: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  blacklistReason?: string;
}

export class OverrideDeliveryTrustScoreDto {
  @ApiProperty({ minimum: 0, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  deliveryTrustScore: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  successfulDeliveriesCount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  returnedOrdersCount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  networkDeliveredCount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  networkReturnedCount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reportedCount?: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class ReportCustomerPhoneAbuseDto {
  @ApiPropertyOptional({
    description: 'Lý do báo cáo xấu / bom hàng đối với SĐT khách hàng này',
    example: 'Đặt 2 đơn COD liên tiếp nhưng shipper gọi tắt máy không nhận hàng',
  })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({
    description:
      'Mã nhóm nguyên nhân báo xấu (BOM_HANG | BOOM_AO_SPAM | TU_CHOI_NHAN_NHIEU_LAN | SAI_SO_DIEN_THOAI | OTHER)',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiPropertyOptional({
    description: 'Chi tiết ghi chú báo xấu từ người bán',
  })
  @IsOptional()
  @IsString()
  reasonNote?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  carrierCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  orderCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @ApiPropertyOptional({
    description:
      'Nguồn ghi nhận báo cáo (SHOP_INTERNAL | PANCAKE_COMMUNITY | PANCAKE_V2 | PANCAKE_POS | CARRIER_3PL_GHN | CARRIER_3PL_GHTK | CARRIER_3PL_VTP | CARRIER_3PL_JT | MARKETPLACE_SHOPEE)',
  })
  @IsOptional()
  @IsString()
  source?:
    | 'SHOP_INTERNAL'
    | 'PANCAKE_COMMUNITY'
    | 'PANCAKE_V2'
    | 'PANCAKE_POS'
    | 'CARRIER_3PL_GHN'
    | 'CARRIER_3PL_GHTK'
    | 'CARRIER_3PL_VTP'
    | 'CARRIER_3PL_JT'
    | 'MARKETPLACE_SHOPEE';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  additionalReturnedOrders?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoBlacklist?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  markBlacklisted?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  conversationId?: string;
}

export class LookupPhoneTrustFromSourcesDto {
  @ApiPropertyOptional({
    description: 'ID cuộc hội thoại cần cập nhật lại thẻ chỉ số nhận/hoàn/báo cáo',
  })
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiPropertyOptional({ description: 'SĐT gốc tùy chọn nếu muốn tra cứu trực tiếp' })
  @IsOptional()
  @IsString()
  rawPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  sources?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customWebhookUrl?: string;
}

export class UpdateShopCrmConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enableAutoTrustLookupOnPhone?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  useInternalPosHistory?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  usePancakeCommunityNetwork?: boolean;

  // Alias tương thích FE `updateShopCrmConfigApi` để ValidationPipe không loại bỏ cấu hình
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enableCommunityTrustLookup?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  useCarrier3plLookup?: boolean;

  // Alias tương thích FE `updateShopCrmConfigApi`
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enableCarrier3plTrustLookup?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  enabledLookupSources?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  enabledCarriers?: Array<'GHN' | 'GHTK' | 'VTP' | 'JT' | 'SHOPEE'>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customLookupWebhookUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  consortiumSharingEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enablePublicWebRiskLookup?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pancakePosShopId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pancakePosApiKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  ghnShopId?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ghnToken?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ghtkToken?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vtpToken?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  jtToken?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customLookupApiKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(100)
  highRiskReturnRateThresholdPercent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  highRiskReportedCountThreshold?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  autoRequireDepositBelowTrustScore?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoMaskBuyerPhoneInChat?: boolean;

  // Alias tương thích FE `updateShopCrmConfigApi`
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoMaskPhoneInChatMessages?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoExtractAddressFromChat?: boolean;

  // Alias tương thích FE `updateShopCrmConfigApi`
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoExtractPhoneAndAddressInChat?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  businessCategory?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showApparelMeasurementsInProfile?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enableCustomAttributesInProfile?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  defaultCustomAttributeKeys?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  customAttributeTemplates?: Array<{ key: string; label: string; placeholder?: string }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requireDepositOnHighRisk?: boolean;
}

export class MergeCustomerProfilesDto {
  @ApiProperty({ description: 'ID hồ sơ khách hàng chính (giữ lại)' })
  @IsString()
  @IsNotEmpty()
  primaryCustomerId: string;

  @ApiProperty({
    description:
      'ID hồ sơ khách hàng phụ bị trùng (sẽ gộp toàn bộ hội thoại, đơn hàng, điểm & ví vào hồ sơ chính)',
  })
  @IsString()
  @IsNotEmpty()
  duplicateCustomerId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mergeReason?: string;
}

export class UnmaskCustomerPhoneDto {
  @ApiPropertyOptional({ description: 'Lý do nghiệp vụ cần mở xem SĐT thật trong 15 giây' })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({ description: 'ID hội thoại phát sinh thao tác mở khóa SĐT' })
  @IsOptional()
  @IsString()
  conversationId?: string;
}

export class AdjustCustomerWalletOrPointsDto {
  @ApiProperty({ enum: CustomerWalletLedgerTypeEnum })
  @IsEnum(CustomerWalletLedgerTypeEnum)
  ledgerType: CustomerWalletLedgerTypeEnum;

  @ApiProperty({ enum: CustomerWalletTransactionTypeEnum })
  @IsEnum(CustomerWalletTransactionTypeEnum)
  transactionType: CustomerWalletTransactionTypeEnum;

  @ApiProperty({ description: 'Giá trị cộng (+) hoặc trừ (-)' })
  @Type(() => Number)
  @IsNumber()
  deltaAmount: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  referenceOrderId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  note: string;
}

export class RecordOrderDeliveredLoyaltyDto {
  @ApiProperty({
    description: 'Mã đơn hàng đã giao & đối soát tiền thành công (DELIVERED_RECONCILED)',
  })
  @IsString()
  @IsNotEmpty()
  orderCode: string;

  @ApiProperty({ description: 'Giá trị đơn hàng thực thu (VND)' })
  @Type(() => Number)
  @IsNumber()
  @Min(1000)
  orderTotalAmount: number;

  @ApiPropertyOptional({ enum: ChannelTypeEnum })
  @IsOptional()
  @IsEnum(ChannelTypeEnum)
  channelType?: ChannelTypeEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pageShortCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  carrierCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @ApiPropertyOptional({
    description:
      'Số tiền khách chuyển khoản dư hoặc hoàn tiền đổi trả RMA cộng vào Ví tiền thừa (nếu có)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  overpaymentOrRmaCreditAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  conversationId?: string;
}

export class ExportCustomersAuditDto {
  @ApiPropertyOptional({ description: 'Số lượng bản ghi xuất file (Masked PII)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  exportedCount?: number;

  @ApiPropertyOptional({ description: 'Bộ lọc áp dụng khi xuất danh sách' })
  @IsOptional()
  @IsString()
  filterSummary?: string;
}

export class TriggerAdsConversionEventDto {
  @ApiProperty({ enum: AdsConversionPlatformEnum })
  @IsEnum(AdsConversionPlatformEnum)
  platform: AdsConversionPlatformEnum;

  @ApiProperty({ enum: AdsConversionEventNameEnum })
  @IsEnum(AdsConversionEventNameEnum)
  eventName: AdsConversionEventNameEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  channelIntegrationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  orderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ctwaClickId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceAdId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  valueAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({
    description: 'Mã test_event_code để kiểm thử trực tiếp trên Meta Events Manager (Công cụ T06)',
  })
  @IsOptional()
  @IsString()
  testEventCode?: string;
}

export class SecurityAuditQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: SecurityAuditActionCodeEnum })
  @IsOptional()
  @IsEnum(SecurityAuditActionCodeEnum)
  actionCode?: SecurityAuditActionCodeEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  actorUserId?: string;
}

export class StandalonePhoneTrustLookupDto {
  @ApiProperty({
    description: 'Số điện thoại cần tra cứu trực tiếp trên toàn bộ nguồn Nội bộ, Cộng đồng & 3PL',
    example: '0988123456',
  })
  @IsString()
  @IsNotEmpty()
  rawPhone: string;

  @ApiPropertyOptional({ description: 'Bỏ qua Redis Cache 15 phút để ép gọi lại cổng API ngoài' })
  @IsOptional()
  @IsBoolean()
  bypassCache?: boolean;
}

export class RetractPhoneAbuseReportDto {
  @ApiProperty({ description: 'Lý do gỡ bỏ báo cáo xấu (ghi nhật ký kiểm toán)' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class ImportPhoneTrustHistoryRowDto {
  @ApiProperty({ description: 'Số điện thoại khách hàng' })
  @IsString()
  @IsNotEmpty()
  rawPhone: string;

  @ApiPropertyOptional({ description: 'Số đơn giao thành công cần cộng dồn' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deliveredCount?: number;

  @ApiPropertyOptional({ description: 'Số đơn hoàn cần cộng dồn' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  returnedCount?: number;

  @ApiPropertyOptional({ description: 'Mã ĐVVC (GHN | GHTK | VTP | JT | SPX | INTERNAL)' })
  @IsOptional()
  @IsString()
  carrierCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  orderCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @ApiPropertyOptional({ description: 'Lý do báo xấu (nếu có)' })
  @IsOptional()
  @IsString()
  abuseReasonNote?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  abuseReasonCode?: string;
}

export class ImportPhoneTrustHistoryDto {
  @ApiProperty({ type: [ImportPhoneTrustHistoryRowDto] })
  @IsArray()
  rows: ImportPhoneTrustHistoryRowDto[];
}
