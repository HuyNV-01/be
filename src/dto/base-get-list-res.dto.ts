import { ApiProperty } from '@nestjs/swagger';

export class DBaseGetListRes<T> {
  @ApiProperty({ isArray: true, example: [] })
  data: T[];

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 10 })
  limit: number;

  @ApiProperty({ example: 1 })
  totalPages: number;
}
