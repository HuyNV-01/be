import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsOptional, IsString } from 'class-validator';
import { PaginationOptions } from 'src/types/query.types';

export class DBaseQuery implements PaginationOptions {
  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 10 })
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ description: 'Search by Name or Email' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Sort field (e.g. createdAt:DESC)' })
  @IsOptional()
  @IsString()
  sort?: string;

  @ApiPropertyOptional({
    description: 'Format: field:operator:value (VD: age:gt:18,name:like:Huy)',
    example: 'age:gt:18,name:like:Huy',
    type: String,
  })
  @IsOptional()
  @IsString()
  filter?: string;

  [key: string]: any;
}
