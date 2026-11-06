import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ChannelTypeEnum } from 'src/common/enum/permission.enum';
import { DBaseQuery } from 'src/dto/base-query.dto';

export class ConnectChannelOAuthDto {
  @ApiProperty({ enum: ChannelTypeEnum, example: ChannelTypeEnum.FACEBOOK_PAGE })
  @IsEnum(ChannelTypeEnum)
  channelType: ChannelTypeEnum;

  @ApiPropertyOptional({ example: '108294819201948' })
  @ValidateIf((o: ConnectChannelOAuthDto) => !o.oauthCode)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  externalPageId?: string;

  @ApiPropertyOptional({ example: 'shop-shopee-vn-01' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalShopId?: string;

  @ApiPropertyOptional({ example: 'Thời Trang Milano — Official Fanpage' })
  @ValidateIf((o: ConnectChannelOAuthDto) => !o.oauthCode)
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(200)
  pageName?: string;

  @ApiProperty({ example: 'FB-MILANO-01' })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(24)
  pageShortCode: string;

  @ApiPropertyOptional({ example: 'https://cdn.shop.vn/avatar.png' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;

  @ApiPropertyOptional({
    description: 'Mã ủy quyền OAuth2 trả về từ Callback của Facebook/Zalo/TikTok/Shopee',
    example: 'AQBx9918273645_oauth_code',
  })
  @IsOptional()
  @IsString()
  oauthCode?: string;

  @ApiPropertyOptional({ example: 'EAAGm0PX4ZCpsBA...' })
  @ValidateIf((o: ConnectChannelOAuthDto) => !o.oauthCode)
  @IsString()
  @IsNotEmpty()
  accessToken?: string;

  @ApiPropertyOptional({ example: 'rft_8829103948...' })
  @IsOptional()
  @IsString()
  refreshToken?: string;

  @ApiPropertyOptional({ example: 'whsec_192837465' })
  @IsOptional()
  @IsString()
  webhookVerifySecret?: string;

  @ApiPropertyOptional({ example: '9981726354123' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  metaDatasetId?: string;

  @ApiPropertyOptional({ example: 'EAAGm0PX4ZCpsBA_CAPI...' })
  @IsOptional()
  @IsString()
  capiAccessToken?: string;

  @ApiPropertyOptional({ example: '2027-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  tokenExpiresAt?: string;
}

export class UpdateChannelIntegrationDto {
  @ApiPropertyOptional({ example: 'Thời Trang Milano — Fanpage Chính' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  pageName?: string;

  @ApiPropertyOptional({ example: 'FB-MILANO-01' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  pageShortCode?: string;

  @ApiPropertyOptional({ example: 'https://cdn.shop.vn/avatar.png' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;

  @ApiPropertyOptional({ example: 'EAAGm0PX4ZCpsBA_NEW...' })
  @IsOptional()
  @IsString()
  accessToken?: string;

  @ApiPropertyOptional({ example: 'rft_new_token...' })
  @IsOptional()
  @IsString()
  refreshToken?: string;

  @ApiPropertyOptional({ example: 'whsec_192837465' })
  @IsOptional()
  @IsString()
  webhookVerifySecret?: string;

  @ApiPropertyOptional({ example: '9981726354123' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  metaDatasetId?: string;

  @ApiPropertyOptional({ example: 'EAAGm0PX4ZCpsBA_CAPI...' })
  @IsOptional()
  @IsString()
  capiAccessToken?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class WebhookLogQueryDto extends DBaseQuery {
  @ApiPropertyOptional({ enum: ChannelTypeEnum })
  @IsOptional()
  @IsEnum(ChannelTypeEnum)
  channelType?: ChannelTypeEnum;

  @ApiPropertyOptional({
    enum: ['RECEIVED', 'PROCESSED', 'DUPLICATE_SKIPPED', 'FAILED_DLQ', 'REPLAYED_SUCCESS'],
  })
  @IsOptional()
  @IsIn(['RECEIVED', 'PROCESSED', 'DUPLICATE_SKIPPED', 'FAILED_DLQ', 'REPLAYED_SUCCESS'])
  processingStatus?:
    | 'RECEIVED'
    | 'PROCESSED'
    | 'DUPLICATE_SKIPPED'
    | 'FAILED_DLQ'
    | 'REPLAYED_SUCCESS';
}

export class MergedInboxQueryDto extends DBaseQuery {
  @ApiPropertyOptional({
    description: 'Danh sách channelIntegrationId cần gộp (phân cách bởi dấu phẩy hoặc mảng)',
  })
  @IsOptional()
  channelIds?: string | string[];

  @ApiPropertyOptional({ example: 'WAITING_AGENT_REPLY' })
  @IsOptional()
  @IsString()
  supportStatus?: string;
}
