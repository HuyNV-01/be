import { ApiProperty } from '@nestjs/swagger';

import { IsNotEmpty, IsUUID } from 'class-validator';

export class CreateDirectChatDto {
  @ApiProperty({ description: 'ID of the person you want to chat with' })
  @IsNotEmpty()
  @IsUUID()
  receiverId: string;
}
