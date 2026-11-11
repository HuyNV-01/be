import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsArray,
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
  ValidateNested,
} from 'class-validator';
import { ChannelTypeEnum } from 'src/common/enum/permission.enum';
import { DBaseQuery } from 'src/dto/base-query.dto';

export class ResolveChannelTokenMetadataDto {
  @ApiProperty({ enum: ChannelTypeEnum, example: ChannelTypeEnum.FACEBOOK_PAGE })
  @IsEnum(ChannelTypeEnum)
  channelType: ChannelTypeEnum;

  @ApiProperty({
    description:
      'Access Token của Fanpage / User / Zalo OA / TikTok Shop / Shopee để tự động kiểm tra và lấy đúng thông tin Trang, Avatar, ID',
    example: 'EAAGm0PX4ZCpsBA...',
  })
  @IsString()
  @IsNotEmpty()
  accessToken: string;

  @ApiPropertyOptional({
    description:
      'Phiên bản API cấu hình cho kênh (VD: v27.1, v27.0, v21.0 cho Meta Graph API; v3.0 cho Zalo OA)',
    example: 'v27.1',
  })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  apiVersion?: string;

  @ApiPropertyOptional({
    description:
      'App ID / Partner ID của ứng dụng SaaS trên nền tảng (VD: Meta App ID, Zalo App ID, Shopee Partner ID)',
    example: '1517776481860111',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  appId?: string;

  @ApiPropertyOptional({
    description:
      'App Secret / Partner Key để tạo appsecret_proof (HMAC-SHA256) và gọi /debug_token xác thực chính xác Page ID',
    example: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  appSecret?: string;

  @ApiPropertyOptional({
    description:
      'ID Trang hoặc Gian hàng cụ thể (nếu người dùng muốn chọn đích danh 1 Page từ User Access Token)',
    example: '108294819201948',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalPageId?: string;

  @ApiPropertyOptional({
    description:
      'Chỉ bật bằng true khi chạy kiểm thử giả lập (Sandbox). Mặc định là false để tuyệt đối không sinh Page giả khi nhập Token thật.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  allowSandboxSimulation?: boolean;
}

export class ConnectChannelOAuthDto {
  @ApiProperty({ enum: ChannelTypeEnum, example: ChannelTypeEnum.FACEBOOK_PAGE })
  @IsEnum(ChannelTypeEnum)
  channelType: ChannelTypeEnum;

  @ApiPropertyOptional({ example: '108294819201948' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalPageId?: string;

  @ApiPropertyOptional({ example: 'shop-shopee-vn-01' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalShopId?: string;

  @ApiPropertyOptional({ example: 'Thời Trang Milano — Official Fanpage' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  pageName?: string;

  @ApiPropertyOptional({ example: 'FB-MILANO-01' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(24)
  pageShortCode?: string;

  @ApiPropertyOptional({ example: 'https://cdn.shop.vn/avatar.png' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;

  @ApiPropertyOptional({ example: 'v27.1' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  apiVersion?: string;

  @ApiPropertyOptional({ example: '1517776481860111' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  appId?: string;

  @ApiPropertyOptional({ example: 'a1b2c3d4e5f6...' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  appSecret?: string;

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

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subscribedFields?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  autoHidePhoneComments?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  syncEchoMessagesFromNativeApp?: boolean;

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

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  allowSandboxSimulation?: boolean;
}

export class BatchConnectChannelsDto {
  @ApiProperty({ type: [ConnectChannelOAuthDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConnectChannelOAuthDto)
  channels: ConnectChannelOAuthDto[];
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

  @ApiPropertyOptional({ example: 'v27.1' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  apiVersion?: string;

  @ApiPropertyOptional({ example: '1517776481860111' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  appId?: string;

  @ApiPropertyOptional({ example: 'a1b2c3d4e5f6...' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  appSecret?: string;

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

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subscribedFields?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoHidePhoneComments?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  syncEchoMessagesFromNativeApp?: boolean;

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
