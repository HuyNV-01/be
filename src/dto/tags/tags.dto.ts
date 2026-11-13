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
} from 'src/entity/custom-tag.entity';

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
