import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  ChannelTypeEnum,
  InventoryMovementTypeEnum,
  PosOrderPaymentMethodEnum,
  PosOrderStatusEnum,
  ProductIndustryTypeEnum,
  ProductSerialStatusEnum,
} from 'src/common/enum';
import { BundleBomComponentItem } from 'src/entity/product-variant.entity';
import {
  ProductFreeGiftRuleItem,
  ProductSizeChartRowItem,
  ProductUomConversionItem,
} from 'src/entity/product.entity';

export class UpsertWarehouseDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  provinceCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  districtCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  wardCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  addressLine?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contactPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priorityOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowNegativeStock?: boolean;
}

export class CreateProductWithMatrixDto {
  @ApiProperty({ example: 'SP-DA-NGANH-2026' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ example: 'Serum Vitamin C Cấp Ẩm Trắng Da 15%' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({
    enum: ProductIndustryTypeEnum,
    default: ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY,
    description:
      'Ngành hàng sản phẩm (Thời trang, Mỹ phẩm, Điện tử, Thực phẩm/F&B, Mẹ & Bé, Gia dụng, Đa ngành)',
  })
  @IsOptional()
  @IsEnum(ProductIndustryTypeEnum)
  industryType?: ProductIndustryTypeEnum;

  @ApiPropertyOptional({ example: 'Mỹ phẩm & Chăm sóc da' })
  @IsOptional()
  @IsString()
  categoryName?: string;

  @ApiPropertyOptional({ example: 'PancakeDerma' })
  @IsOptional()
  @IsString()
  brandName?: string;

  @ApiPropertyOptional({ example: 'Chai' })
  @IsOptional()
  @IsString()
  unitName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description:
      'Tên trục thuộc tính 1 tùy theo ngành hàng (VD: Màu sắc, Dung tích, Phiên bản, Quy cách đóng gói, Độ tuổi)',
    example: 'Dung tích',
  })
  @IsOptional()
  @IsString()
  attributeAxis1Name?: string;

  @ApiPropertyOptional({
    description: 'Danh sách giá trị trục thuộc tính 1 (tương thích ngược với colors)',
  })
  @IsOptional()
  @IsArray()
  attributeAxis1Values?: string[];

  @ApiPropertyOptional({
    description:
      'Tên trục thuộc tính 2 tùy theo ngành hàng (VD: Kích cỡ, Loại da, Cấu hình, Hương vị)',
    example: 'Loại da',
  })
  @IsOptional()
  @IsString()
  attributeAxis2Name?: string;

  @ApiPropertyOptional({
    description: 'Danh sách giá trị trục thuộc tính 2 (tương thích ngược với sizes)',
  })
  @IsOptional()
  @IsArray()
  attributeAxis2Values?: string[];

  @ApiPropertyOptional({
    description: 'Danh sách màu sắc / phân loại 1 để nhân ma trận biến thể SKU',
  })
  @IsOptional()
  @IsArray()
  colors?: string[];

  @ApiPropertyOptional({
    description: 'Danh sách kích cỡ / phân loại 2 để nhân ma trận biến thể SKU',
  })
  @IsOptional()
  @IsArray()
  sizes?: string[];

  @ApiPropertyOptional({ default: 350000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  retailPrice?: number;

  @ApiPropertyOptional({ default: 280000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  wholesalePrice?: number;

  @ApiPropertyOptional({
    description: 'Giá vốn nhập hàng (chỉ hiển thị cho người có quyền CATALOG_COST_PRICE_VIEW)',
    default: 185000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPrice?: number;

  @ApiPropertyOptional({ default: 15 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  maxDiscountPercent?: number;

  @ApiPropertyOptional({ default: 300 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  weightGrams?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  lengthCm?: number;

  @ApiPropertyOptional({ default: 15 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  widthCm?: number;

  @ApiPropertyOptional({ default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  heightCm?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requiresSerialImei?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  warrantyMonths?: number;

  @ApiPropertyOptional({
    description:
      'Quản lý theo Lô sản xuất & Hạn sử dụng FEFO (Mỹ phẩm, Thực phẩm, Dược phẩm, Mẹ & Bé)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  requiresBatchExpiry?: boolean;

  @ApiPropertyOptional({ example: 'LOT-2026-11A' })
  @IsOptional()
  @IsString()
  batchCode?: string;

  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @IsString()
  manufacturingDate?: string;

  @ApiPropertyOptional({ example: '2028-11-01' })
  @IsOptional()
  @IsString()
  expiryDate?: string;

  @ApiPropertyOptional({ default: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  shelfLifeMonths?: number;

  @ApiPropertyOptional({ example: 'Nơi khô ráo, thoáng mát < 25°C' })
  @IsOptional()
  @IsString()
  storageCondition?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  technicalSpecsJson?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  uomConversionsJson?: ProductUomConversionItem[];

  @ApiPropertyOptional({
    description: 'Số lượng tồn kho khởi tạo ban đầu cho mỗi biến thể tại kho mặc định',
    default: 25,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  initialOnHandQtyPerVariant?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  sizeChartMetadataJson?: ProductSizeChartRowItem[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  freeGiftRulesJson?: ProductFreeGiftRuleItem[];
}

export class CreateBundleBomVariantDto {
  @ApiProperty({ example: 'COMBO-BIEN-01' })
  @IsString()
  @IsNotEmpty()
  skuCode: string;

  @ApiProperty({ example: 'Combo Đi Biển: Áo Sơ Mi Lụa + Chân Váy Xếp Ly + Mũ Cói' })
  @IsString()
  @IsNotEmpty()
  variantName: string;

  @ApiPropertyOptional({
    enum: ProductIndustryTypeEnum,
    default: ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY,
  })
  @IsOptional()
  @IsEnum(ProductIndustryTypeEnum)
  industryType?: ProductIndustryTypeEnum;

  @ApiProperty({ example: 590000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  retailPrice: number;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  maxDiscountPercent?: number;

  @ApiProperty({ description: 'Danh sách các SKU thành phần cấu thành bộ Combo BOM' })
  @IsArray()
  components: BundleBomComponentItem[];
}

export class RecommendSizeAdvisorDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiPropertyOptional({ enum: ProductIndustryTypeEnum })
  @IsOptional()
  @IsEnum(ProductIndustryTypeEnum)
  industryType?: ProductIndustryTypeEnum;

  @ApiPropertyOptional({ example: 160 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(40)
  @Max(230)
  heightCm?: number;

  @ApiPropertyOptional({ example: 52 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(2)
  @Max(200)
  weightKg?: number;

  @ApiPropertyOptional({
    description: 'Tháng tuổi của bé (dành cho ngành hàng Mẹ & Bé: Bỉm, Sữa, Quần áo trẻ em)',
    example: 9,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(180)
  babyAgeMonths?: number;

  @ApiPropertyOptional({
    description:
      'Loại da khách hàng (dành cho ngành Mỹ phẩm: OILY, DRY, COMBINATION, SENSITIVE, NORMAL)',
    example: 'OILY',
  })
  @IsOptional()
  @IsString()
  skinType?: string;

  @ApiPropertyOptional({
    description:
      'Nhu cầu sử dụng / diện tích phòng / số người dùng (dành cho Điện tử, Gia dụng, Thực phẩm)',
  })
  @IsOptional()
  @IsString()
  usageNeed?: string;
}

export class ReserveStockAtomicDto {
  @ApiProperty({
    description: 'ID giỏ hàng nháp POS để giữ chỗ tồn kho nguyên tử trên Redis (TTL 15 phút)',
  })
  @IsString()
  @IsNotEmpty()
  draftCartId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  warehouseId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  variantId: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  conversationId?: string;
}

export class ReleaseStockAtomicDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  draftCartId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  warehouseId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  variantId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity?: number;
}

export class AdjustWarehouseStocktakeDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  warehouseId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  variantId: string;

  @ApiProperty({ enum: InventoryMovementTypeEnum })
  @IsEnum(InventoryMovementTypeEnum)
  movementType: InventoryMovementTypeEnum;

  @ApiProperty({ description: 'Số lượng cộng thêm (+) hoặc trừ đi (-)' })
  @Type(() => Number)
  @IsInt()
  deltaQty: number;

  @ApiPropertyOptional({
    description: 'Chuyển sang hoặc giải phóng khỏi kho hàng lỗi (defectiveHoldQty)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  deltaDefectiveHoldQty?: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  note: string;
}

export class CreateWarehouseTransferDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  fromWarehouseId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  toWarehouseId: string;

  @ApiProperty({
    description: 'Danh sách mặt hàng điều chuyển kho',
  })
  @IsArray()
  items: Array<{
    variantId: string;
    requestedQty: number;
  }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({
    description: 'Tự động xuất kho bước 1 (TRANSFER_OUT) ngay khi tạo phiếu',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  dispatchImmediately?: boolean;
}

export class ReceiveWarehouseTransferDto {
  @ApiPropertyOptional({
    description:
      'Danh sách số lượng thực nhận theo từng biến thể (nếu lệch sẽ tự động ghi nhận DISCREPANCY)',
  })
  @IsOptional()
  @IsArray()
  receivedItems?: Array<{
    variantId: string;
    receivedQty: number;
    discrepancyReason?: string;
  }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class RegisterProductSerialItemsDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  warehouseId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  variantId: string;

  @ApiProperty({ description: 'Danh sách mã Serial / IMEI cần nhập kho' })
  @IsArray()
  serialNumbers: string[];

  @ApiPropertyOptional({ default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  warrantyMonths?: number;
}

export class ScanBindSerialToOrderDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  serialNumber: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;
}

export class CreateInChatPosOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiProperty({ example: 'Nguyễn Thu Trang' })
  @IsString()
  @IsNotEmpty()
  customerName: string;

  @ApiPropertyOptional({
    description:
      'SĐT gốc nếu khách mới (sẽ được mã hóa vào PII Vault) hoặc để trống dùng SĐT trong hồ sơ',
  })
  @IsOptional()
  @IsString()
  rawPhone?: string;

  @ApiPropertyOptional({ enum: ChannelTypeEnum })
  @IsOptional()
  @IsEnum(ChannelTypeEnum)
  channelType?: ChannelTypeEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pageShortCode?: string;

  @ApiPropertyOptional({
    description:
      'Kho xuất hàng ưu tiên (nếu bỏ trống hệ thống tự động định tuyến kho tối ưu hoặc tách đơn đa kho)',
  })
  @IsOptional()
  @IsString()
  preferredWarehouseId?: string;

  @ApiPropertyOptional({ default: '3_TIER' })
  @IsOptional()
  @IsString()
  addressTierMode?: '3_TIER' | '4_TIER';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiverProvinceCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiverDistrictCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiverWardCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiverHamletCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiverHamletName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiverAddressLine?: string | null;

  @ApiProperty({
    description: 'Danh sách mặt hàng trong giỏ POS',
  })
  @IsArray()
  items: Array<{
    variantId: string;
    quantity: number;
    discountPercent?: number;
    serialNumbers?: string[];
  }>;

  @ApiPropertyOptional({ default: 'GHN' })
  @IsOptional()
  @IsString()
  carrierCode?: 'GHN' | 'GHTK' | 'VTP' | 'JT' | 'COUNTER_PICKUP';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  shippingFeeAmount?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isFreeShippingForCustomer?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  orderDiscountPercent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  discountApprovalReason?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  loyaltyPointsRedeemed?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  walletCreditAppliedAmount?: number;

  @ApiPropertyOptional({ enum: PosOrderPaymentMethodEnum, default: PosOrderPaymentMethodEnum.COD })
  @IsOptional()
  @IsEnum(PosOrderPaymentMethodEnum)
  paymentMethod?: PosOrderPaymentMethodEnum;

  @ApiPropertyOptional({
    default: false,
    description:
      'Cho phép tự động tách thành nhiều đơn con nếu các mặt hàng nằm ở các kho khác nhau',
  })
  @IsOptional()
  @IsBoolean()
  allowMultiWarehouseSplit?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reservationCartId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class MergeDuplicatePosOrdersDto {
  @ApiProperty({
    description: 'ID đơn hàng chính (chưa gửi vận chuyển) sẽ nhận toàn bộ sản phẩm gộp vào',
  })
  @IsString()
  @IsNotEmpty()
  targetPrimaryOrderId: string;

  @ApiPropertyOptional({
    description: 'ID đơn hàng phụ vừa tạo cần gộp vào đơn chính (nếu đã tạo đơn)',
  })
  @IsOptional()
  @IsString()
  sourceDuplicateOrderId?: string;

  @ApiPropertyOptional({
    description: 'Hoặc gộp trực tiếp các mặt hàng đang trong giỏ nháp In-Chat POS vào đơn chính',
  })
  @IsOptional()
  @IsArray()
  additionalCartItems?: Array<{
    variantId: string;
    quantity: number;
    discountPercent?: number;
  }>;
}

export class ResolveDiscountApprovalDto {
  @ApiProperty()
  @IsBoolean()
  approved: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  managerNote?: string;
}

export class GenerateOrderVietQrDto {
  @ApiPropertyOptional({
    default: '970422',
    description:
      'Mã BIN ngân hàng NAPAS (VD: 970422 MB Bank, 970436 Vietcombank, 970407 Techcombank, 970415 VietinBank)',
  })
  @IsOptional()
  @IsString()
  bankBin?: string;

  @ApiPropertyOptional({ default: 'MBBank' })
  @IsOptional()
  @IsString()
  bankShortName?: string;

  @ApiPropertyOptional({ default: '0988123456888' })
  @IsOptional()
  @IsString()
  accountNumber?: string;

  @ApiPropertyOptional({ default: 'CONG TY TNHH PANCAKE SELLER OS' })
  @IsOptional()
  @IsString()
  accountName?: string;

  @ApiPropertyOptional({
    description: 'Số tiền cần tạo QR (mặc định lấy số tiền cọc hoặc tổng đơn)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1000)
  amountVnd?: number;
}

export class VietQrPaymentWebhookDto {
  @ApiPropertyOptional({
    description: 'ID cửa hàng (nếu gọi qua cổng Webhook công khai /webhooks/payment/vietqr)',
  })
  @IsOptional()
  @IsString()
  shopId?: string;

  @ApiProperty({
    description: 'ID hoặc Mã đơn hàng (hoặc chuỗi nội dung chuyển khoản chứa SEVQR ORD...)',
  })
  @IsString()
  @IsNotEmpty()
  orderIdOrReference: string;

  @ApiProperty({ description: 'Số tiền thực nhận từ biến động số dư ngân hàng (VND)' })
  @Type(() => Number)
  @IsNumber()
  @Min(1000)
  paidAmountVnd: number;

  @ApiPropertyOptional({ example: 'FT26319882910' })
  @IsOptional()
  @IsString()
  bankTransactionId?: string;

  @ApiPropertyOptional({ example: 'SEVQR ORDPOS-2611-889' })
  @IsOptional()
  @IsString()
  transferContent?: string;
}

export class PosOrderListQueryDto {
  @ApiPropertyOptional({ enum: PosOrderStatusEnum })
  @IsOptional()
  @IsEnum(PosOrderStatusEnum)
  status?: PosOrderStatusEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;
}

export class SerialLookupQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  variantId?: string;

  @ApiPropertyOptional({ enum: ProductSerialStatusEnum })
  @IsOptional()
  @IsEnum(ProductSerialStatusEnum)
  status?: ProductSerialStatusEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;
}
