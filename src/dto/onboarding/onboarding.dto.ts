import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsArray,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  DataScopeEnum,
  MembershipStatusEnum,
  PermissionCodeEnum,
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
