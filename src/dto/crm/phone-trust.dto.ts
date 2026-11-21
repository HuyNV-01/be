import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PhoneTrustAbuseReasonCodeEnum } from 'src/common/enum/phone-trust.enum';

export class StandalonePhoneTrustLookupDto {
  @ApiProperty({ description: 'Số điện thoại cần tra cứu uy tín nhận/hoàn/báo xấu thực tế' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  rawPhone: string;

  @ApiPropertyOptional({ description: 'Bỏ qua Redis cache để ép gọi live tới cổng đối tác' })
  @IsOptional()
  @IsBoolean()
  bypassCache?: boolean;
}

export class SubmitStandalonePhoneAbuseReportDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  rawPhone: string;

  @ApiProperty({ enum: PhoneTrustAbuseReasonCodeEnum })
  @IsEnum(PhoneTrustAbuseReasonCodeEnum)
  reasonCode: PhoneTrustAbuseReasonCodeEnum;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reasonNote: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  carrierCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  orderCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  trackingNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  evidenceUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  markBlacklisted?: boolean;
}

export class RetractPhoneAbuseReportDto {
  @ApiProperty({ description: 'Lý do rút lại báo xấu (VD: khách đã nhận hàng hoặc nhập nhầm SĐT)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}

export class ImportPhoneTrustHistoryRowDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  rawPhone: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(500)
  deliveredCount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(500)
  returnedCount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  carrierCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  orderCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  trackingNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  abuseReasonNote?: string;

  @ApiPropertyOptional({ enum: PhoneTrustAbuseReasonCodeEnum })
  @IsOptional()
  @IsEnum(PhoneTrustAbuseReasonCodeEnum)
  abuseReasonCode?: PhoneTrustAbuseReasonCodeEnum;
}

export class ImportPhoneTrustHistoryDto {
  @ApiProperty({ type: [ImportPhoneTrustHistoryRowDto] })
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ImportPhoneTrustHistoryRowDto)
  rows: ImportPhoneTrustHistoryRowDto[];
}
