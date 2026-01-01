import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsArray,
  IsUUID,
} from 'class-validator';
import { MessageTypeEnum } from 'src/common/enum';

export class SendMessageDto {
  @ApiProperty({ example: '1' })
  @IsUUID()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty({ example: 'Test' })
  @IsNotEmpty()
  content: string;

  @ApiProperty({ example: 'TEXT' })
  @IsEnum(MessageTypeEnum)
  @IsOptional()
  type?: MessageTypeEnum = MessageTypeEnum.TEXT;

  @ApiProperty({ example: {} })
  @IsOptional()
  metadata?: any;

  @IsOptional()
  @IsString()
  tempId?: string;
}

export class CreateGroupDto {
  @ApiProperty({ example: 'Test' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: [], type: Array })
  @IsArray()
  @IsUUID('4', { each: true })
  memberIds: string[];
}
