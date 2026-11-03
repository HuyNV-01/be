import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
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

  @ApiPropertyOptional({
    description: 'Danh sách User UUID được nhắc tên (@Mention) trong tin nhắn',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  mentionedUserIds?: string[];

  @ApiPropertyOptional({
    description: 'Đánh dấu nhắc tên toàn bộ thành viên nhóm (@All)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  mentionAll?: boolean;
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

export class CreatePollDto {
  @ApiProperty({ description: 'Conversation UUID' })
  @IsUUID()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty({ example: 'Cuối tuần này họp nhóm ở đâu?' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  question: string;

  @ApiProperty({
    type: [String],
    example: ['Quán Cafe A', 'Văn phòng công ty', 'Họp Online Google Meet'],
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(150, { each: true })
  options: string[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  allowMultipleAnswers?: boolean = false;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isAnonymous?: boolean = false;

  @ApiPropertyOptional({
    description: 'Tự động ghim cuộc bình chọn ngay sau khi tạo',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean = false;
}

export class VotePollDto {
  @ApiProperty({ description: 'Conversation UUID' })
  @IsUUID()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty({ description: 'Poll Message UUID' })
  @IsUUID()
  @IsNotEmpty()
  messageId: string;

  @ApiProperty({
    type: [String],
    description: 'Danh sách ID các phương án mà người dùng chọn',
  })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  optionIds: string[];
}

export class ClosePollDto {
  @ApiProperty({ description: 'Conversation UUID' })
  @IsUUID()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty({ description: 'Poll Message UUID' })
  @IsUUID()
  @IsNotEmpty()
  messageId: string;
}

export class FetchLinkPreviewQueryDto {
  @ApiProperty({ example: 'https://nextjs.org' })
  @IsNotEmpty()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  url: string;
}
