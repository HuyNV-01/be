import { HttpStatus } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

export class DBaseRes {
  @ApiProperty({ example: HttpStatus.OK })
  status: number;

  @ApiProperty({ example: 'Handle successfully' })
  message: string;

  @ApiProperty({ example: HttpStatus.OK })
  code: number;

  @ApiProperty({ example: null })
  data?: any;
}
