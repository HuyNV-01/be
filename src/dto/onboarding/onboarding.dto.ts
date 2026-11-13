import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  DataScopeEnum,
  MembershipStatusEnum,
  PermissionCodeEnum,
  RoutingStrategyEnum,
  ShiftStatusEnum,
  ShopRoleEnum,
} from 'src/common/enum/permission.enum';

export class CreateShopWorkspaceDto {
  @ApiProperty({ example: 'Thời Trang Milano' })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(150)
  shopName: string;

  @ApiPropertyOptional({ example: '0988123456' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  contactPhone?: string;

  @ApiPropertyOptional({ example: '01' })
  @IsOptional()
  @IsString()
  defaultProvinceCode?: string;

  @ApiPropertyOptional({ example: '001' })
  @IsOptional()
  @IsString()
  defaultDistrictCode?: string;

  @ApiPropertyOptional({ example: '00001' })
  @IsOptional()
  @IsString()
  defaultWardCode?: string;

  @ApiPropertyOptional({ example: 'Số 12 Phố Huế, Hai Bà Trưng, Hà Nội' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  defaultAddressLine?: string;
}

export class JoinShopByCodeDto {
  @ApiProperty({ example: 'PAN88291' })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(16)
  joinCode: string;

  @ApiPropertyOptional({ example: 'Em Minh ứng tuyển vị trí Kế toán ca sáng' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  requestedNote?: string;
}

export class CreateRoleInvitationDto {
  @ApiProperty({ example: 'ketoan@milano.vn' })
  @IsEmail()
  @IsNotEmpty()
  invitedEmail: string;

  @ApiPropertyOptional({ example: 'Nguyễn Thị Lan' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  invitedName?: string;

  @ApiProperty({ enum: ShopRoleEnum, example: ShopRoleEnum.ACCOUNTANT })
  @IsEnum(ShopRoleEnum)
  targetRole: ShopRoleEnum;

  @ApiPropertyOptional({ enum: DataScopeEnum })
  @IsOptional()
  @IsEnum(DataScopeEnum)
  targetDataScope?: DataScopeEnum;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxDiscountPercent?: number;

  @ApiPropertyOptional({ example: 15 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  unmaskPhoneHourlyLimit?: number;

  @ApiPropertyOptional({ isArray: true, enum: PermissionCodeEnum })
  @IsOptional()
  @IsArray()
  customGrantedPermissions?: PermissionCodeEnum[];

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  allowedChannelIds?: string[];

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  allowedWarehouseIds?: string[];
}

export class ApprovePendingMemberDto {
  @ApiProperty({ enum: ShopRoleEnum, example: ShopRoleEnum.SALE_AGENT })
  @IsEnum(ShopRoleEnum)
  assignedRole: ShopRoleEnum;

  @ApiPropertyOptional({ enum: DataScopeEnum })
  @IsOptional()
  @IsEnum(DataScopeEnum)
  assignedDataScope?: DataScopeEnum;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxDiscountPercent?: number;

  @ApiPropertyOptional({ example: 15 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  unmaskPhoneHourlyLimit?: number;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  allowedChannelIds?: string[];

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  allowedWarehouseIds?: string[];
}

export class RejectPendingMemberDto {
  @ApiPropertyOptional({ example: 'Không khớp thông tin nhân sự ứng tuyển' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class UpdateMemberRoleAndPermissionsDto {
  @ApiProperty({ enum: ShopRoleEnum })
  @IsEnum(ShopRoleEnum)
  role: ShopRoleEnum;

  @ApiProperty({ enum: DataScopeEnum })
  @IsEnum(DataScopeEnum)
  dataScope: DataScopeEnum;

  @ApiProperty({ example: 5 })
  @IsNumber()
  @Min(0)
  @Max(100)
  maxDiscountPercent: number;

  @ApiProperty({ example: 15 })
  @IsNumber()
  @Min(0)
  unmaskPhoneHourlyLimit: number;

  @ApiPropertyOptional({ example: 'TEAM_CA_SANG' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  teamCode?: string;

  @ApiPropertyOptional({ example: 25 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(500)
  maxConcurrentChats?: number;

  @ApiPropertyOptional({ isArray: true, enum: PermissionCodeEnum })
  @IsOptional()
  @IsArray()
  grantedPermissionsJson?: PermissionCodeEnum[];

  @ApiPropertyOptional({ isArray: true, enum: PermissionCodeEnum })
  @IsOptional()
  @IsArray()
  revokedPermissionsJson?: PermissionCodeEnum[];

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  allowedChannelIdsJson?: string[];

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  allowedWarehouseIdsJson?: string[];
}

export class UpdateMemberStatusDto {
  @ApiProperty({
    enum: [
      MembershipStatusEnum.ACTIVE,
      MembershipStatusEnum.SUSPENDED,
      MembershipStatusEnum.TERMINATED,
    ],
  })
  @IsEnum(MembershipStatusEnum)
  membershipStatus: MembershipStatusEnum;
}

export class TransferShopOwnershipDto {
  @ApiProperty({ example: 'uuid-of-target-active-member' })
  @IsString()
  @IsNotEmpty()
  targetMemberId: string;
}

export class UpdateShiftStatusDto {
  @ApiProperty({ enum: ShiftStatusEnum, example: ShiftStatusEnum.ONLINE })
  @IsEnum(ShiftStatusEnum)
  targetStatus: ShiftStatusEnum;

  @ApiPropertyOptional({
    enum: ['AUTO_REDISTRIBUTE', 'TRANSFER_TO_AGENT', 'KEEP_ASSIGNED'],
  })
  @IsOptional()
  @IsIn(['AUTO_REDISTRIBUTE', 'TRANSFER_TO_AGENT', 'KEEP_ASSIGNED'])
  handoverMode?: 'AUTO_REDISTRIBUTE' | 'TRANSFER_TO_AGENT' | 'KEEP_ASSIGNED';

  @ApiPropertyOptional({ example: 'uuid-of-colleague-agent' })
  @IsOptional()
  @IsString()
  targetHandoverAgentId?: string;
}

export class ForceOfflineShiftDto {
  @ApiPropertyOptional({
    enum: ['AUTO_REDISTRIBUTE', 'TRANSFER_TO_AGENT', 'KEEP_ASSIGNED'],
    default: 'AUTO_REDISTRIBUTE',
  })
  @IsOptional()
  @IsIn(['AUTO_REDISTRIBUTE', 'TRANSFER_TO_AGENT', 'KEEP_ASSIGNED'])
  handoverMode?: 'AUTO_REDISTRIBUTE' | 'TRANSFER_TO_AGENT' | 'KEEP_ASSIGNED';

  @ApiPropertyOptional({ example: 'uuid-of-colleague-agent' })
  @IsOptional()
  @IsString()
  targetHandoverAgentId?: string;
}

export class SavedPageGroupPresetItemDto {
  @ApiProperty({ example: 'preset-fashion-01' })
  @IsString()
  @IsNotEmpty()
  presetId: string;

  @ApiProperty({ example: 'Tổ hợp 5 Fanpage Thời Trang Nữ + TikTok' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ isArray: true, type: String })
  @IsArray()
  channelIntegrationIds: string[];

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class SavePageGroupPresetsDto {
  @ApiProperty({ type: [SavedPageGroupPresetItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SavedPageGroupPresetItemDto)
  presets: SavedPageGroupPresetItemDto[];
}

export class UpdateShopWorkspaceSettingsDto {
  @ApiPropertyOptional({ example: 180 })
  @IsOptional()
  @IsNumber()
  @Min(15)
  @Max(86400)
  slaResponseSeconds?: number;

  @ApiPropertyOptional({ example: 180 })
  @IsOptional()
  @IsNumber()
  @Min(15)
  @Max(86400)
  ghostedAlertSeconds?: number;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1440)
  autoReclaimMinutes?: number;

  @ApiPropertyOptional({ enum: RoutingStrategyEnum })
  @IsOptional()
  @IsEnum(RoutingStrategyEnum)
  routingStrategy?: RoutingStrategyEnum;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  lockOrderAfterPrint?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  requireDepositOnHighRisk?: boolean;

  @ApiPropertyOptional({ example: 0.4 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  leadCollectorWeight?: number;

  @ApiPropertyOptional({ example: 0.6 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  orderCloserWeight?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  deductOnReturnedOrder?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  autoReserveStockOnMarketplaceOrder?: boolean;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  safetyBufferStockQty?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  pushAvailableStockToShopeeTikTok?: boolean;
}
