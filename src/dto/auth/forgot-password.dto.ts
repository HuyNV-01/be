import { ApiProperty } from '@nestjs/swagger';

import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'huyhuhyhoa@gmail.com' })
  @IsString()
  @IsNotEmpty()
  @IsEmail()
  email: string;
}
