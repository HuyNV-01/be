/* eslint-disable @typescript-eslint/no-unsafe-call */
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'huyhuhyhoa@gmail.com' })
  @IsString()
  @IsNotEmpty()
  @IsEmail()
  email: string;
}
