import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  QuickReplyAttachmentItem,
  QuickReplyProductCardItem,
} from 'src/entity/quick-reply-template.entity';

export class OmnichannelInboxFilterDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  shopId: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channelIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  unreadOnly?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  unrepliedOnly?: boolean;

  @ApiPropertyOptional({ description: 'Đã mở xem > 180s nhưng chưa trả lời (F03.1 & T03)' })
  @IsOptional()
  @IsBoolean()
  ghostedByAgentOnly?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  slaBreachedOnly?: boolean;

  @ApiPropertyOptional({ description: 'Còn < 2 giờ trước khi đóng cửa sổ 24h Facebook' })
  @IsOptional()
  @IsBoolean()
  window24hExpiringOnly?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  snoozedOnly?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hasPhone?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  noPhone?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hasOrder?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  noOrder?: boolean;

  @ApiPropertyOptional({ enum: ['INBOX', 'COMMENT', 'LIVESTREAM', 'MARKETPLACE'] })
  @IsOptional()
  @IsEnum(['INBOX', 'COMMENT', 'LIVESTREAM', 'MARKETPLACE'])
  interactionType?: 'INBOX' | 'COMMENT' | 'LIVESTREAM' | 'MARKETPLACE';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourcePostId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceAdId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assignedAgentId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  includeTagIds?: string[];

  @ApiPropertyOptional({ enum: ['AND', 'OR'], default: 'OR' })
  @IsOptional()
  @IsEnum(['AND', 'OR'])
  includeTagOperator?: 'AND' | 'OR';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludeTagIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  searchKeyword?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cursorLastMessageAt?: string;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(100)
  limit?: number;
}

export class CreateInternalNoteDto {
  @ApiProperty({ example: '@Minh kiểm tra giúp tồn kho mẫu đầm kem size M nhé!' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  content: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  mentionedUserIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  replyToMessageId?: string;
}

export class SnoozeConversationDto {
  @ApiProperty({ example: '2026-11-07T09:00:00.000Z' })
  @IsDateString()
  @IsNotEmpty()
  snoozedUntilAt: string;

  @ApiPropertyOptional({ example: 'Gọi lại hỏi khách đã nhận lương chưa để chốt set vest' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  snoozeNote?: string;
}

export class TransferConversationDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  targetAgentId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  transferNote?: string;
}

export class CreateQuickReplyTemplateDto {
  @ApiProperty({ example: 'xin-chao' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  shortcut: string;

  @ApiProperty({ example: 'Mẫu chào khách mới & hỏi nhu cầu' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title: string;

  @ApiPropertyOptional({ default: 'GENERAL' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;

  @ApiProperty({
    example:
      'Dạ {{shop_name}} xin chào {{salutation}} {{customer_name}} ạ! Em là {{agent_name}}, em có thể tư vấn mẫu nào cho mình hôm nay ạ?',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  contentTemplate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  attachmentsJson?: QuickReplyAttachmentItem[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  productCardsJson?: QuickReplyProductCardItem[];
}

export class UpdateQuickReplyTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  shortcut?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  contentTemplate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  attachmentsJson?: QuickReplyAttachmentItem[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  productCardsJson?: QuickReplyProductCardItem[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class InitiateMaskedVoipCallDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerPhoneEncrypted?: string;

  @ApiPropertyOptional({ example: '098***678' })
  @IsOptional()
  @IsString()
  customerPhoneMasked?: string;

  @ApiPropertyOptional({ example: 'STRINGEE_SIP' })
  @IsOptional()
  @IsString()
  sipTrunkProvider?: string;
}

export class FinalizeMaskedVoipCallDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  callSessionId: string;

  @ApiProperty({ example: 94 })
  @IsNumber()
  @Min(0)
  durationSeconds: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  recordingFileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  recordingFileUrl?: string;

  @ApiProperty({ example: 'ORDER_CONFIRMED' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  callDispositionTag: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  callNotes?: string;
}

export class TranslateChatMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  text: string;

  @ApiProperty({ example: 'vi' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  targetLang: string;

  @ApiPropertyOptional({ example: 'auto' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  sourceLang?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  messageId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

export class ToggleCommentVisibilityDto {
  @ApiProperty({
    description: 'Ẩn hoặc hiện bình luận của khách trên nền tảng gốc (F03.3 & F03.4)',
  })
  @IsBoolean()
  isHidden: boolean;
}

export class ToggleCommentLikeDto {
  @ApiProperty({ description: 'Thích hoặc bỏ thích bình luận của khách dưới tư cách Fanpage' })
  @IsBoolean()
  isLiked: boolean;
}

export class SendPrivateReplyFromCommentDto {
  @ApiProperty({ description: 'Nội dung tin nhắn riêng (Private Reply Inbox) gửi từ bình luận' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  content: string;

  @ApiPropertyOptional({ description: 'Tự động ẩn bình luận sau khi gửi Private Reply' })
  @IsOptional()
  @IsBoolean()
  autoHideComment?: boolean;

  @ApiPropertyOptional({ description: 'Tự động thích bình luận sau khi gửi Private Reply' })
  @IsOptional()
  @IsBoolean()
  autoLikeComment?: boolean;
}
