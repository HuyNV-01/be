import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ThermalLabelFormatEnum } from 'src/common/enum';

export class BatchPrintThermalLabelsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  orderIds: string[];

  @ApiPropertyOptional({ enum: ThermalLabelFormatEnum })
  @IsOptional()
  @IsEnum(ThermalLabelFormatEnum)
  labelFormat?: ThermalLabelFormatEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hideProductNames?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hideItemPrices?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showCodAmount?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showOrderNote?: boolean;
}

export class GenerateWavePicklistDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  orderIds: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warehouseId?: string;
}

export class CreateHandoverManifestDto {
  @ApiProperty()
  @IsString()
  warehouseId: string;

  @ApiProperty({ example: 'GHN' })
  @IsString()
  @MaxLength(24)
  carrierCode: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  courierDriverName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  courierDriverPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  courierVehiclePlate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class ScanOrderIntoHandoverDto {
  @ApiProperty({ description: 'Mã vận đơn 3PL hoặc mã đơn hàng nội bộ' })
  @IsString()
  scannedCode: string;
}

export class SealHandoverManifestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  courierDriverName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  courierDriverPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class ScheduleOrderCallLaterDto {
  @ApiProperty({ example: '2026-11-21T09:00:00.000Z' })
  @IsDateString()
  callLaterAt: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  subStatus?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  appendOrderTags?: string[];
}

export class UpdateOrderTagsAndSubStatusDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  orderTags: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  subStatus?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  clearCallLater?: boolean;
}

export class PartialDeliveryLineItemInputDto {
  @ApiProperty()
  @IsString()
  variantId: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  deliveredQty: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  restockReturnedImmediately?: boolean;
}

export class SettlePartialDeliveryDto {
  @ApiProperty({ type: [PartialDeliveryLineItemInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PartialDeliveryLineItemInputDto)
  items: PartialDeliveryLineItemInputDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  partialReturnShippingFee?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}
