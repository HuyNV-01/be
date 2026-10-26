import { ApiPropertyOptional } from '@nestjs/swagger';

import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { NotificationTypeEnum } from 'src/common/enum';

import { DBaseQuery } from '../base-query.dto';

export class GetNotificationsQueryDto extends DBaseQuery {
  @ApiPropertyOptional({
    description: 'Lọc theo trạng thái đã đọc (true/false)',
    type: Boolean,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  isRead?: boolean;

  @ApiPropertyOptional({
    description: 'Lọc theo loại thông báo',
    enum: NotificationTypeEnum,
  })
  @IsOptional()
  @IsEnum(NotificationTypeEnum)
  type?: NotificationTypeEnum;
}

export class MarkNotificationByResourceDto {
  @ApiPropertyOptional({ description: 'ID tài nguyên liên quan (ví dụ conversationId)' })
  @IsString()
  resourceId: string;
}
