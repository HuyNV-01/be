import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { MessageTypeEnum } from 'src/common/enum';

export class SendMessageDto {
  @ApiProperty({ example: 'b0122a22-98e7-422c-ae10-752f889456f9' })
  @IsUUID()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty({ example: 'Xin chào!' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  content: string;

  @ApiPropertyOptional({ enum: MessageTypeEnum, example: MessageTypeEnum.TEXT })
  @IsEnum(MessageTypeEnum)
  @IsOptional()
  type?: MessageTypeEnum = MessageTypeEnum.TEXT;

  @ApiPropertyOptional({
    description: 'ID tin nhắn gốc nếu đây là tin nhắn trả lời (Reply/Quote)',
  })
  @IsOptional()
  @IsUUID()
  replyToMessageId?: string;

  @ApiPropertyOptional({
    description: 'Danh sách File ID đã tải lên để đính kèm vào tin nhắn',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  fileIds?: string[];

  @ApiPropertyOptional({
    description: 'Đánh dấu nội dung đã được mã hóa Đầu-Cuối (E2EE) từ phía Client',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isE2EE?: boolean;

  @ApiPropertyOptional({
    description: 'Mã định danh khóa công khai E2EE (Key ID)',
  })
  @IsOptional()
  @IsString()
  e2eeKeyId?: string;

  @ApiPropertyOptional({ example: {} })
  @IsOptional()
  metadata?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tempId?: string;
}

export class CreateGroupDto {
  @ApiProperty({ example: 'Team Dự Án' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: [], type: [String] })
  @IsArray()
  @IsUUID('4', { each: true })
  memberIds: string[];
}
