import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class StandalonePhoneAbuseReportDto {
  @ApiProperty({
    description: 'Số điện thoại cần báo cáo xấu',
    example: '0988123456',
  })
  @IsString()
  @IsNotEmpty()
  rawPhone: string;

  @ApiProperty({
    enum: ['BOM_HANG', 'BOOM_AO_SPAM', 'TU_CHOI_NHAN_NHIEU_LAN', 'SAI_SO_DIEN_THOAI', 'OTHER'],
    default: 'BOM_HANG',
  })
  @IsString()
  @IsIn(['BOM_HANG', 'BOOM_AO_SPAM', 'TU_CHOI_NHAN_NHIEU_LAN', 'SAI_SO_DIEN_THOAI', 'OTHER'])
  reasonCode:
    | 'BOM_HANG'
    | 'BOOM_AO_SPAM'
    | 'TU_CHOI_NHAN_NHIEU_LAN'
    | 'SAI_SO_DIEN_THOAI'
    | 'OTHER';

  @ApiProperty({
    description: 'Mô tả chi tiết tình huống bom hàng / từ chối nhận hàng',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reasonNote: string;

  @ApiPropertyOptional({ description: 'Mã hãng vận chuyển (GHN | GHTK | VTP | JT | SPX)' })
  @IsOptional()
  @IsString()
  carrierCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  orderCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  markBlacklisted?: boolean;
}
