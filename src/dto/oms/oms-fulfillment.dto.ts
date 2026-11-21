import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CodReconciliationDiscrepancyTypeEnum,
  OmsCarrierRescueActionEnum,
  OmsCarrierSlaBreachTypeEnum,
  OmsReturnConditionEnum,
  OmsRmaTypeEnum,
  PosOrderStatusEnum,
  ThermalLabelFormatEnum,
} from 'src/common/enum';

export class OmsOrderListQueryDto {
  @ApiPropertyOptional({ enum: PosOrderStatusEnum })
  @IsOptional()
  @IsEnum(PosOrderStatusEnum)
  status?: PosOrderStatusEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  carrierCode?: string;

  @ApiPropertyOptional({ enum: OmsCarrierSlaBreachTypeEnum })
  @IsOptional()
  @IsEnum(OmsCarrierSlaBreachTypeEnum)
  slaBreachType?: OmsCarrierSlaBreachTypeEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class TransitionOrderStatusDto {
  @ApiProperty({ enum: PosOrderStatusEnum })
  @IsEnum(PosOrderStatusEnum)
  targetStatus: PosOrderStatusEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reasonNote?: string;
}

export class ModifyConfirmedOrderLineItemDto {
  @ApiProperty()
  @IsString()
  variantId: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercent?: number;
}

export class ModifyConfirmedOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiverAddressLine?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  codCollectAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  shippingFeeAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({ type: [ModifyConfirmedOrderLineItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModifyConfirmedOrderLineItemDto)
  items?: ModifyConfirmedOrderLineItemDto[];

  @ApiProperty({ description: 'Bắt buộc ghi rõ lý do sửa đơn đã xác nhận/đã in' })
  @IsString()
  @MaxLength(500)
  reasonNote: string;
}

export class DispatchCarrierBatchDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  orderIds: string[];

  @ApiPropertyOptional({ enum: ['GHN', 'GHTK', 'VTP', 'JT'] })
  @IsOptional()
  @IsString()
  overrideCarrierCode?: 'GHN' | 'GHTK' | 'VTP' | 'JT';
}

export class ScanPackingBarcodeDto {
  @ApiProperty()
  @IsString()
  scannedCode: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantityDelta?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  serialNumber?: string;
}

export class CompletePackingAndPrintDto {
  @ApiProperty({ description: 'Trọng lượng cân thực tế tại bàn đóng gói (gram)' })
  @IsInt()
  @Min(10)
  actualPackedWeightGrams: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  lengthCm?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  widthCm?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  heightCm?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  packingVideoUrl?: string;

  @ApiPropertyOptional({ enum: ThermalLabelFormatEnum, default: ThermalLabelFormatEnum.A6_100X150 })
  @IsOptional()
  @IsEnum(ThermalLabelFormatEnum)
  labelFormat?: ThermalLabelFormatEnum;
}

export class ReprintShippingLabelDto {
  @ApiProperty({ enum: ThermalLabelFormatEnum, default: ThermalLabelFormatEnum.A6_100X150 })
  @IsEnum(ThermalLabelFormatEnum)
  labelFormat: ThermalLabelFormatEnum;

  @ApiProperty({ description: 'Lý do in lại phiếu vận đơn' })
  @IsString()
  @MaxLength(300)
  reprintReason: string;
}

export class CarrierRescueActionDto {
  @ApiProperty({ enum: OmsCarrierRescueActionEnum })
  @IsEnum(OmsCarrierRescueActionEnum)
  action: OmsCarrierRescueActionEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  noteToCarrier?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  preferredDeliverySlot?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  updatedReceiverName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  updatedReceiverPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  updatedReceiverAddress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  updatedCodAmount?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  notifyCustomerViaOmnichannel?: boolean;
}

export class CarrierWebhookPayloadDto {
  @ApiProperty()
  @IsString()
  trackingNumber: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  clientOrderCode?: string;

  @ApiProperty()
  @IsString()
  rawStatus: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reasonDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  locationHubName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shipperName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shipperPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  carrierChargedWeightGrams?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  shippingFeeCarrierActual?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  eventId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  occurredAt?: string;
}

export class ReturnVerificationItemDto {
  @ApiProperty()
  @IsString()
  variantId: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  verifiedQty: number;

  @ApiProperty({ enum: OmsReturnConditionEnum })
  @IsEnum(OmsReturnConditionEnum)
  condition: OmsReturnConditionEnum;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serialNumbers?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  evidenceImageUrls?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  inspectionNote?: string;
}

export class VerifyReturnedOrderDto {
  @ApiProperty({ type: [ReturnVerificationItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnVerificationItemDto)
  items: ReturnVerificationItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  createCarrierCompensationClaim?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  overallNote?: string;
}

export class RmaReturnItemInputDto {
  @ApiProperty()
  @IsString()
  variantId: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional({ enum: OmsReturnConditionEnum })
  @IsOptional()
  @IsEnum(OmsReturnConditionEnum)
  expectedCondition?: OmsReturnConditionEnum;
}

export class RmaOutboundItemInputDto {
  @ApiProperty()
  @IsString()
  variantId: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warehouseId?: string;
}

export class CreateRmaExchangeDto {
  @ApiProperty()
  @IsString()
  originalOrderId: string;

  @ApiProperty({ enum: OmsRmaTypeEnum, default: OmsRmaTypeEnum.EXCHANGE_2_WAY })
  @IsEnum(OmsRmaTypeEnum)
  rmaType: OmsRmaTypeEnum;

  @ApiProperty({ type: [RmaReturnItemInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RmaReturnItemInputDto)
  returnItems: RmaReturnItemInputDto[];

  @ApiPropertyOptional({ type: [RmaOutboundItemInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RmaOutboundItemInputDto)
  outboundItems?: RmaOutboundItemInputDto[];

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  rmaShippingFeeCustomerCharged?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  refundNegativeDeltaToWallet?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reasonNote?: string;
}

export class CodReconciliationRowInputDto {
  @ApiProperty()
  @IsString()
  trackingNumber: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  orderCode?: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  actualCodAmount: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  actualShippingFee: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  returnFeeCharged?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  carrierChargedWeightGrams?: number;
}

export class CreateCodReconciliationBatchDto {
  @ApiProperty({ enum: ['GHN', 'GHTK', 'VTP', 'JT', 'OTHER'] })
  @IsString()
  carrierCode: 'GHN' | 'GHTK' | 'VTP' | 'JT' | 'OTHER';

  @ApiProperty()
  @IsString()
  sourceFileName: string;

  @ApiPropertyOptional({ default: 100, description: 'Ngưỡng dung sai cân nặng (gram)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  weightToleranceGrams?: number;

  @ApiPropertyOptional({ default: 1000, description: 'Ngưỡng dung sai phí ship (VNĐ)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  feeToleranceVnd?: number;

  @ApiProperty({ type: [CodReconciliationRowInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CodReconciliationRowInputDto)
  rows: CodReconciliationRowInputDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class ConfirmCodReconciliationBatchDto {
  @ApiPropertyOptional({ type: [String], description: 'Nếu bỏ trống sẽ chốt tất cả dòng MATCHED' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  itemIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class ListCodReconciliationItemsQueryDto {
  @ApiPropertyOptional({ enum: CodReconciliationDiscrepancyTypeEnum })
  @IsOptional()
  @IsEnum(CodReconciliationDiscrepancyTypeEnum)
  discrepancyType?: CodReconciliationDiscrepancyTypeEnum;
}
