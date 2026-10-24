import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class UploadFileQueryDto {
  @ApiPropertyOptional({
    description: 'Thư mục lưu trữ logic (vd: general, chat, avatars, documents)',
    example: 'chat',
  })
  @IsOptional()
  @IsString()
  folder?: string = 'general';

  @ApiPropertyOptional({
    description: 'Tự động tối ưu hoá ảnh sang WebP và xoay đúng chiều EXIF',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  optimize?: boolean = true;

  @ApiPropertyOptional({
    description: 'Tự động sinh thêm ảnh Thumbnail nhẹ cho ảnh upload',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  generateThumbnail?: boolean = false;

  @ApiPropertyOptional({
    description: 'Chiều rộng tối đa khi resize ảnh (px)',
    example: 1920,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(64)
  @Max(4096)
  resizeWidth?: number;

  @ApiPropertyOptional({
    description: 'Chống trùng lặp nội dung bằng mã băm SHA-256 (Deduplication)',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  deduplicate?: boolean = true;

  @ApiPropertyOptional({
    description: 'Số ngày lưu trữ trước khi tự động hết hạn và dọn dẹp',
    example: 30,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  retentionDays?: number;
}

export class SingleFileUploadBodyDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'File cần tải lên',
  })
  file: any;
}

export class MultipleFilesUploadBodyDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'string', format: 'binary' },
    description: 'Danh sách các file cần tải lên (tối đa 10 files)',
  })
  files: any[];
}

export class CreatePresignedUploadDto {
  @ApiProperty({
    description: 'Tên file gốc trên thiết bị người dùng',
    example: 'demo-video.mp4',
  })
  @IsString()
  @IsNotEmpty()
  originalName: string;

  @ApiProperty({
    description: 'MIME type của file',
    example: 'video/mp4',
  })
  @IsString()
  @IsNotEmpty()
  mimeType: string;

  @ApiProperty({
    description: 'Kích thước file tính bằng bytes',
    example: 15728640,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  size: number;

  @ApiPropertyOptional({
    description: 'Thư mục lưu trữ',
    example: 'videos',
  })
  @IsOptional()
  @IsString()
  folder?: string = 'general';

  @ApiPropertyOptional({
    description: 'Số ngày lưu trữ file',
    example: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  retentionDays?: number;
}

export class ConfirmPresignedUploadDto {
  @ApiProperty({
    description: 'Object key đã được cấp từ API presigned-upload',
    example: 'videos/550e8400-e29b-41d4-a716-446655440000.mp4',
  })
  @IsString()
  @IsNotEmpty()
  key: string;

  @ApiProperty({
    description: 'Tên file gốc',
    example: 'demo-video.mp4',
  })
  @IsString()
  @IsNotEmpty()
  originalName: string;

  @ApiProperty({
    description: 'MIME type của file',
    example: 'video/mp4',
  })
  @IsString()
  @IsNotEmpty()
  mimeType: string;

  @ApiPropertyOptional({
    description: 'Bucket lưu trữ (mặc định dùng bucket chính)',
  })
  @IsOptional()
  @IsString()
  bucket?: string;

  @ApiPropertyOptional({
    description: 'Số ngày lưu trữ file',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  retentionDays?: number;
}
