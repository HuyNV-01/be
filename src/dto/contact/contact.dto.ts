import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { ContactStatusEnum } from 'src/common/enum';

import { DBaseQuery } from '../base-query.dto';

export class SendFriendRequestDto {
  @ApiProperty({
    example: 'uuid-string',
  })
  @IsNotEmpty()
  @IsUUID()
  targetUserId: string;
}

export class UpdateContactAliasDto {
  @ApiProperty({ example: 'A' })
  @IsNotEmpty()
  @IsString()
  alias: string;
}

export class ActionRequestDto {
  @ApiProperty({
    example: 'uuid-string',
  })
  @IsNotEmpty()
  @IsUUID()
  targetUserId: string;
}

export class GetContactsDto extends DBaseQuery {
  @ApiPropertyOptional({
    example: 'PENDING_SENT',
    enum: ContactStatusEnum,
  })
  @IsOptional()
  @IsEnum(ContactStatusEnum)
  type?: ContactStatusEnum;
}
