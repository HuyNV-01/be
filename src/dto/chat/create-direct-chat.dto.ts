import { IsNotEmpty, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDirectChatDto {
  @ApiProperty({ description: 'ID of the person you want to chat with' })
  @IsNotEmpty()
  @IsUUID()
  receiverId: string;
}
