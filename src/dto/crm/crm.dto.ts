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
  CustomerTierEnum,
  CustomerWalletLedgerTypeEnum,
  CustomerWalletTransactionTypeEnum,
  RfmSegmentCodeEnum,
  SecurityAuditActionCodeEnum,
} from 'src/common/enum';

export class ExtractVietnameseNerDto {
  @ApiProperty({
    description:
      'Nội dung tin nhắn hoặc bình luận tiếng Việt cần bóc tách SĐT, địa chỉ 3 cấp, SKU, size, màu',
    example:
      'Cho chị 2 đầm A12 màu kem size M (1m60 52kg) về số 15 ngõ 68 Cầu Giấy HN nhé, sđt không chín tám tám 123 bốn năm sáu',
  })
  @IsString()
  @IsNotEmpty()
  text: string;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultAddressLine?: string;

  @ApiPropertyOptional({ enum: CustomerTierEnum })
  @IsOptional()
  @IsEnum(CustomerTierEnum)
  tier?: CustomerTierEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  heightCm?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  weightKg?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  preferredSize?: string;

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

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reason: string;
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
