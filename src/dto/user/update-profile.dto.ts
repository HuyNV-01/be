import { ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class UserPrivacySettingsDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  showEmail?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  showPhone?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  showAlias?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  showOnlineStatus?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  showSharedMedia?: boolean;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Nguyễn Văn Huy' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'Full-Stack Engineer | NestJS & NextJS' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string | null;

  @ApiPropertyOptional({ example: '0987654321' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[0-9+\-\s()]*$/, {
    message: 'Số điện thoại không hợp lệ',
  })
  phone?: string | null;

  @ApiPropertyOptional({ type: UserPrivacySettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UserPrivacySettingsDto)
  privacySettings?: UserPrivacySettingsDto;
}
