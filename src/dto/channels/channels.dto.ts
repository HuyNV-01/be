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

export class CreateSaasAppProfileDto {
  @ApiProperty({
    description: 'Tên định danh Hồ sơ Ứng dụng SaaS (VD: Meta App BM Chính - Thời Trang Nữ)',
    example: 'Meta App BM Chính — Thời Trang Nữ',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name: string;

  @ApiProperty({ enum: ChannelTypeEnum, example: ChannelTypeEnum.FACEBOOK_PAGE })
  @IsEnum(ChannelTypeEnum)
  channelType: ChannelTypeEnum;

  @ApiPropertyOptional({ example: 'v27.1', default: 'v27.1' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  apiVersion?: string;

  @ApiProperty({
    description:
      'App ID / Partner ID trên nền tảng (Meta App ID, Zalo App ID, TikTok App Key, Shopee Partner ID)',
    example: '1517776481860111',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  appId: string;

  @ApiPropertyOptional({
    description:
      'App Secret / Partner Key dùng để ký HMAC-SHA256 appsecret_proof, đổi Never-Expiring Page Token (fb_exchange_token) và xác thực chữ ký Webhook',
    example: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  appSecret?: string;

  @ApiPropertyOptional({
    description: 'Chuỗi Verify Token dùng để xác thực Webhook Challenge tự động',
    example: 'pancake_seller_os_verify_2026',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  webhookVerifyToken?: string;

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

  @ApiPropertyOptional({
    description:
      'Tự động tiêm (Auto-Inject) đăng ký Webhook ngay khi nhập Access Token kết nối kênh',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  autoInjectWebhookOnConnect?: boolean;

  @ApiPropertyOptional({
    description:
      'Đặt làm cấu hình SaaS mặc định cho nền tảng này (Khi kết nối kênh chỉ cần dán Access Token)',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({
    description:
      'Tự động gọi API đăng ký Webhook cấp App (POST /{appId}/subscriptions) ngay khi lưu',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  autoRegisterAppWebhookOnPlatform?: boolean;
}

export class UpdateSaasAppProfileDto {
  @ApiPropertyOptional({ example: 'Meta App BM Chính — Thời Trang Nữ' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name?: string;

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

  @ApiPropertyOptional({ example: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  appSecret?: string;

  @ApiPropertyOptional({ example: 'pancake_seller_os_verify_2026' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  webhookVerifyToken?: string;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoInjectWebhookOnConnect?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  propagateToBoundChannels?: boolean;
}

export class ResolveChannelTokenMetadataDto {
  @ApiProperty({ enum: ChannelTypeEnum, example: ChannelTypeEnum.FACEBOOK_PAGE })
  @IsEnum(ChannelTypeEnum)
  channelType: ChannelTypeEnum;

  @ApiProperty({
    description:
      'Access Token của Fanpage / User / Zalo OA / TikTok Shop / Shopee để tự động kiểm tra, đổi Never-Expiring Page Token và lấy đúng thông tin Trang, Avatar, ID',
    example: 'EAAGm0PX4ZCpsBA...',
  })
  @IsString()
  @IsNotEmpty()
  accessToken: string;

  @ApiPropertyOptional({
    description:
      'ID Hồ sơ Cấu hình SaaS (Nếu bỏ trống, hệ thống tự động lấy Hồ sơ SaaS mặc định của nền tảng)',
    example: 'saas_prof_fb_01',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  saasAppProfileId?: string;

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
      'App Secret / Partner Key để tạo appsecret_proof (HMAC-SHA256), đổi fb_exchange_token vĩnh viễn và gọi /debug_token xác thực chính xác Page ID',
    example: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
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
      'Tự động đổi Short-Lived Token sang Long-Lived User Token (60 ngày) và rút trích Never-Expiring Page Access Token (expires_at = 0)',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  autoExchangeNeverExpiringToken?: boolean;

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

  @ApiPropertyOptional({
    description:
      'ID Hồ sơ Cấu hình SaaS áp dụng cho kênh này (Tự động lấy hồ sơ mặc định nếu bỏ trống)',
    example: 'saas_prof_fb_01',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  saasAppProfileId?: string;

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
  @MaxLength(255)
  pageName?: string;

  @ApiPropertyOptional({ example: 'FB-MILANO-01' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(32)
  pageShortCode?: string;

  // Cho phép URL ảnh đại diện CDN dài tới 4096 ký tự để không bị chặn bởi bộ kiểm tra DTO
  @ApiPropertyOptional({ example: 'https://scontent.fhan2-1.fna.fbcdn.net/v/t39.30808-1/...' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
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
  @MaxLength(512)
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

  @ApiPropertyOptional({
    description:
      'User Access Token gốc (hoặc Long-Lived User Token) để hệ thống mã hóa lưu trữ phục vụ tự động cấp lại Page Access Token vĩnh viễn khi cần',
    example: 'EAAGm0PX4ZCpsBA_USER...',
  })
  @IsOptional()
  @IsString()
  userAccessToken?: string;

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

  @ApiPropertyOptional({
    description:
      'Tự động nâng cấp lên Never-Expiring Page Access Token (expires_at = 0) và tự động cấp lại khi gửi tin nhắn',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  autoExchangeNeverExpiringToken?: boolean;

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

export class BatchPageCandidateItemDto {
  @ApiProperty({ example: '108294819201948' })
  @IsString()
  @IsNotEmpty()
  externalPageId: string;

  @ApiProperty({ example: 'Thời Trang Milano — Fanpage 01' })
  @IsString()
  @IsNotEmpty()
  pageName: string;

  @ApiPropertyOptional({ example: 'FB-MILANO-01' })
  @IsOptional()
  @IsString()
  pageShortCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  avatarUrl?: string;

  @ApiProperty({ example: 'EAAGm0PX4ZCpsBA...' })
  @IsString()
  @IsNotEmpty()
  pageAccessToken: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isNeverExpiringPageToken?: boolean;
}

export class BatchConnectChannelsDto {
  @ApiPropertyOptional({ type: [ConnectChannelOAuthDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConnectChannelOAuthDto)
  channels?: ConnectChannelOAuthDto[];

  @ApiPropertyOptional({ enum: ChannelTypeEnum })
  @IsOptional()
  @IsEnum(ChannelTypeEnum)
  channelType?: ChannelTypeEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  saasAppProfileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(24)
  apiVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  appId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  appSecret?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userAccessToken?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  webhookVerifySecret?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  metaDatasetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  capiAccessToken?: string;

  @ApiPropertyOptional({ type: [BatchPageCandidateItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchPageCandidateItemDto)
  pages?: BatchPageCandidateItemDto[];
}

export class UpdateChannelIntegrationDto {
  @ApiPropertyOptional({ example: 'saas_prof_fb_01' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  saasAppProfileId?: string;

  @ApiPropertyOptional({ example: 'Thời Trang Milano — Fanpage Chính' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  pageName?: string;

  @ApiPropertyOptional({ example: 'FB-MILANO-01' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  pageShortCode?: string;

  @ApiPropertyOptional({ example: 'https://scontent.fhan2-1.fna.fbcdn.net/...' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
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
  @MaxLength(512)
  appSecret?: string;

  @ApiPropertyOptional({ example: 'EAAGm0PX4ZCpsBA_NEW...' })
  @IsOptional()
  @IsString()
  accessToken?: string;

  @ApiPropertyOptional({ example: 'EAAGm0PX4ZCpsBA_USER...' })
  @IsOptional()
  @IsString()
  userAccessToken?: string;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoExchangeNeverExpiringToken?: boolean;

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
  @IsString()
  channelIds?: string | string[];

  @ApiPropertyOptional({ example: 'WAITING_AGENT_REPLY' })
  @IsOptional()
  @IsString()
  supportStatus?: string;
}
