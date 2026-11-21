import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  type AutoTagRuleConfig,
  type TagApplicableScope,
  TagCategoryEnum,
  type TagWorkflowActionItem,
  type TagWorkflowExecutionCondition,
} from 'src/entity/custom-tag.entity';
import {
  type TagEventCategoryType,
  type TagEventDirectionType,
  type TagEventMatchConditions,
  type TagEventTagBinding,
} from 'src/entity/tag-event-definition.entity';

export class CreateCustomTagDto {
  @ApiProperty({ example: 'Đã chốt đơn' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ example: 'ORDER_CREATED' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @ApiPropertyOptional({ example: 'Gắn khi khách đã xác nhận đơn hàng' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string | null;

  @ApiPropertyOptional({ example: '#10B981' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  colorHex?: string;

  @ApiPropertyOptional({ example: 'oklch(0.69 0.17 162)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  colorOklch?: string;

  @ApiPropertyOptional({
    enum: TagCategoryEnum,
    default: TagCategoryEnum.CONSULTATION_STATUS,
  })
  @IsOptional()
  @IsEnum(TagCategoryEnum)
  category?: TagCategoryEnum;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isMutuallyExclusiveGroup?: boolean;

  @ApiPropertyOptional({
    example: ['CONVERSATION', 'MESSAGE'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  applicableScopesJson?: TagApplicableScope[];

  @ApiPropertyOptional({ example: '3', description: 'Phím tắt Alt+1..9' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  shortcutKey?: string | null;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  autoRuleConfigJson?: AutoTagRuleConfig | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  linkedEventKeysJson?: string[] | null;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  onApplyActionsJson?: TagWorkflowActionItem[] | null;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  onRemoveActionsJson?: TagWorkflowActionItem[] | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  executionConditionJson?: TagWorkflowExecutionCondition | null;
}

export class UpdateCustomTagDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  colorHex?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  colorOklch?: string;

  @ApiPropertyOptional({ enum: TagCategoryEnum })
  @IsOptional()
  @IsEnum(TagCategoryEnum)
  category?: TagCategoryEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isMutuallyExclusiveGroup?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  applicableScopesJson?: TagApplicableScope[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(8)
  shortcutKey?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  autoRuleConfigJson?: AutoTagRuleConfig | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  linkedEventKeysJson?: string[] | null;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  onApplyActionsJson?: TagWorkflowActionItem[] | null;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  onRemoveActionsJson?: TagWorkflowActionItem[] | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  executionConditionJson?: TagWorkflowExecutionCondition | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class QueryCustomTagsDto {
  @ApiPropertyOptional({ enum: TagCategoryEnum })
  @IsOptional()
  @IsEnum(TagCategoryEnum)
  category?: TagCategoryEnum;

  @ApiPropertyOptional({ example: 'CONVERSATION' })
  @IsOptional()
  @IsString()
  scope?: TagApplicableScope;
}

export class ToggleConversationTagDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  tagId: string;

  @ApiPropertyOptional({ enum: ['ADD', 'REMOVE'] })
  @IsOptional()
  @IsEnum(['ADD', 'REMOVE'])
  forceState?: 'ADD' | 'REMOVE';
}

export class BulkAssignConversationTagsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  conversationIds: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  addTagIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  removeTagIds?: string[];
}

export class AssignMessageBookmarkTagDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  tagId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  noteText?: string;
}

export class CreateTagEventDefinitionDto {
  @ApiProperty({ example: 'wholesale_inquiry' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  eventKey: string;

  @ApiProperty({ example: 'Khách hỏi mua sỉ / CTV' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @ApiPropertyOptional({
    enum: [
      'SYSTEM_BUILT_IN',
      'INBOUND_MESSAGE',
      'ORDER_COMMERCE',
      'PAYMENT_FINANCE',
      'CUSTOMER_LIFECYCLE',
      'EXTERNAL_WEBHOOK',
      'CUSTOM_MANUAL',
    ],
    default: 'CUSTOM_MANUAL',
  })
  @IsOptional()
  @IsEnum([
    'SYSTEM_BUILT_IN',
    'INBOUND_MESSAGE',
    'ORDER_COMMERCE',
    'PAYMENT_FINANCE',
    'CUSTOMER_LIFECYCLE',
    'EXTERNAL_WEBHOOK',
    'CUSTOM_MANUAL',
  ])
  category?: TagEventCategoryType;

  @ApiPropertyOptional({
    enum: ['EVENT_TO_TAG', 'TAG_TO_EVENT', 'BIDIRECTIONAL'],
    default: 'BIDIRECTIONAL',
  })
  @IsOptional()
  @IsEnum(['EVENT_TO_TAG', 'TAG_TO_EVENT', 'BIDIRECTIONAL'])
  direction?: TagEventDirectionType;

  @ApiPropertyOptional({ example: 'chat.message.inbound' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  systemEventTopic?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  matchConditionsJson?: TagEventMatchConditions | null;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  linkedTagBindingsJson?: TagEventTagBinding[] | null;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  outboundActionsJson?: TagWorkflowActionItem[] | null;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400)
  cooldownSeconds?: number;
}

export class UpdateTagEventDefinitionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(140)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @ApiPropertyOptional({
    enum: [
      'SYSTEM_BUILT_IN',
      'INBOUND_MESSAGE',
      'ORDER_COMMERCE',
      'PAYMENT_FINANCE',
      'CUSTOMER_LIFECYCLE',
      'EXTERNAL_WEBHOOK',
      'CUSTOM_MANUAL',
    ],
  })
  @IsOptional()
  @IsEnum([
    'SYSTEM_BUILT_IN',
    'INBOUND_MESSAGE',
    'ORDER_COMMERCE',
    'PAYMENT_FINANCE',
    'CUSTOMER_LIFECYCLE',
    'EXTERNAL_WEBHOOK',
    'CUSTOM_MANUAL',
  ])
  category?: TagEventCategoryType;

  @ApiPropertyOptional({ enum: ['EVENT_TO_TAG', 'TAG_TO_EVENT', 'BIDIRECTIONAL'] })
  @IsOptional()
  @IsEnum(['EVENT_TO_TAG', 'TAG_TO_EVENT', 'BIDIRECTIONAL'])
  direction?: TagEventDirectionType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  systemEventTopic?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  matchConditionsJson?: TagEventMatchConditions | null;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  linkedTagBindingsJson?: TagEventTagBinding[] | null;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  outboundActionsJson?: TagWorkflowActionItem[] | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400)
  cooldownSeconds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class FireTagEventDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  conversationId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  messageContent?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
