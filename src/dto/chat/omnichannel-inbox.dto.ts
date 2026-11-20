import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { type QuickReplyVariableSourceType } from 'src/entity/quick-reply-custom-variable.entity';
import {
  type QuickReplyAttachmentItem,
  type QuickReplyProductCardItem,
  type QuickReplyScopeType,
  type QuickReplySequenceStep,
  type QuickReplyUsageContext,
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

  @ApiPropertyOptional({
    enum: ['AND', 'OR'],
    default: 'OR',
    description: 'Chế độ khớp tập hợp Tag (AND bắt buộc đủ / OR có ít nhất 1)',
  })
  @IsOptional()
  @IsEnum(['AND', 'OR'])
  includeTagMatchMode?: 'AND' | 'OR';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludeTagIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  searchKeyword?: string;

  @ApiPropertyOptional({ description: 'Lọc từ ngày (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Lọc đến ngày (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

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

  @ApiProperty({ example: 'Mẫu chào khách mới & gửi video sản phẩm' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title: string;

  @ApiPropertyOptional({ default: 'GENERAL' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;

  @ApiPropertyOptional({ enum: ['SHOP', 'CHANNEL', 'PERSONAL'], default: 'SHOP' })
  @IsOptional()
  @IsEnum(['SHOP', 'CHANNEL', 'PERSONAL'])
  scope?: QuickReplyScopeType;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  allowedChannelIdsJson?: string[] | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  usageContextJson?: QuickReplyUsageContext | null;

  @ApiProperty({
    example:
      'Dạ {{shop_name}} xin chào {{salutation}} {{customer_name}} ạ! Hotline hỗ trợ: {{hotline}}.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  contentTemplate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  messageSequenceJson?: QuickReplySequenceStep[] | null;

  @ApiPropertyOptional({ description: 'Danh sách hình ảnh & video đính kèm' })
  @IsOptional()
  @IsArray()
  attachmentsJson?: QuickReplyAttachmentItem[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  productCardsJson?: QuickReplyProductCardItem[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  autoAssignTagIdsJson?: string[] | null;

  @ApiPropertyOptional({ description: 'Giá trị mặc định riêng cho các biến tùy chỉnh trong mẫu' })
  @IsOptional()
  @IsObject()
  customVariableDefaultsJson?: Record<string, string> | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
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

  @ApiPropertyOptional({ enum: ['SHOP', 'CHANNEL', 'PERSONAL'] })
  @IsOptional()
  @IsEnum(['SHOP', 'CHANNEL', 'PERSONAL'])
  scope?: QuickReplyScopeType;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  allowedChannelIdsJson?: string[] | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  usageContextJson?: QuickReplyUsageContext | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  contentTemplate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  messageSequenceJson?: QuickReplySequenceStep[] | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  attachmentsJson?: QuickReplyAttachmentItem[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  productCardsJson?: QuickReplyProductCardItem[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  autoAssignTagIdsJson?: string[] | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  customVariableDefaultsJson?: Record<string, string> | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateQuickReplyCustomVariableDto {
  @ApiProperty({ example: 'hotline' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  variableKey: string;

  @ApiProperty({ example: 'Số hotline cửa hàng' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label: string;

  @ApiPropertyOptional({ example: 'Hiển thị ở cuối mẫu câu tư vấn và bảo hành' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string | null;

  @ApiPropertyOptional({
    enum: ['STATIC_TEXT', 'DYNAMIC_EXPRESSION', 'PROMPT_ON_USE'],
    default: 'STATIC_TEXT',
  })
  @IsOptional()
  @IsEnum(['STATIC_TEXT', 'DYNAMIC_EXPRESSION', 'PROMPT_ON_USE'])
  sourceType?: QuickReplyVariableSourceType;

  @ApiPropertyOptional({ example: '1900 6868' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  defaultValue?: string | null;

  @ApiPropertyOptional({ example: '1900 6868' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  sampleValue?: string | null;

  @ApiPropertyOptional({ example: 'customer.tier' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  dynamicPath?: string | null;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateQuickReplyCustomVariableDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  variableKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string | null;

  @ApiPropertyOptional({ enum: ['STATIC_TEXT', 'DYNAMIC_EXPRESSION', 'PROMPT_ON_USE'] })
  @IsOptional()
  @IsEnum(['STATIC_TEXT', 'DYNAMIC_EXPRESSION', 'PROMPT_ON_USE'])
  sourceType?: QuickReplyVariableSourceType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  defaultValue?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  sampleValue?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  dynamicPath?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class InterpolateQuickReplyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  salutation?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  agentName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pageName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  trackingLink?: string;

  @ApiPropertyOptional({ description: 'Giá trị ghi đè cho biến tùy chỉnh hoặc PROMPT_ON_USE' })
  @IsOptional()
  @IsObject()
  customOverrides?: Record<string, string>;
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
