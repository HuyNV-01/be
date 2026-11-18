import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  InventoryMovementTypeEnum,
  ProductIndustryTypeEnum,
  ProductSerialStatusEnum,
} from 'src/common/enum';
import {
  CreateBundleBomVariantDto,
  CreateProductWithMatrixDto,
  RecommendSizeAdvisorDto,
  UpdateProductVariantDto,
  UpdateShopCatalogPosConfigDto,
  UpsertSellerCategoryBlueprintDto,
} from 'src/dto/catalog-pos/catalog-pos.dto';
import { ProductSerialItemEntity } from 'src/entity/product-serial-item.entity';
import { ProductVariantEntity } from 'src/entity/product-variant.entity';
import { ProductEntity, ProductSizeChartRowItem } from 'src/entity/product.entity';
import {
  SellerCategoryBlueprintItem,
  ShopCatalogAndPosConfig,
  ShopWorkspaceEntity,
} from 'src/entity/shop-workspace.entity';
import { WarehouseStockItemEntity } from 'src/entity/warehouse-stock-item.entity';
import { WarehouseEntity } from 'src/entity/warehouse.entity';
import { Repository } from 'typeorm';

import { AtomicInventoryAndTransferService } from './atomic-inventory-and-transfer.service';

export interface WarehouseStockSummaryItem {
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  provinceCode: string;
  onHandQty: number;
  reservedQty: number;
  availableQty: number;
  inTransitQty: number;
  defectiveHoldQty: number;
  binLocationCode: string;
}

export type EnrichedCatalogVariantItem = ProductVariantEntity & {
  volumetricWeightGrams: number;
  chargeableWeightGrams: number;
  daysUntilExpiry: number | null;
  isNearExpiryWarning: boolean;
  totalOnHandQty: number;
  totalReservedQty: number;
  totalAvailableQty: number;
  totalDefectiveHoldQty: number;
  stocksByWarehouse: WarehouseStockSummaryItem[];
};

export interface SuggestedVariantAdvisorItem {
  variantId: string;
  skuCode: string;
  variantName: string;
  retailPrice: number;
  totalAvailableQty: number;
  categoryName: string;
}

export const DEFAULT_APPAREL_SIZE_CHART: ProductSizeChartRowItem[] = [
  {
    sizeCode: 'S',
    minHeightCm: 148,
    maxHeightCm: 158,
    minWeightKg: 40,
    maxWeightKg: 48,
    chestCm: 84,
    waistCm: 66,
    hipCm: 88,
    fitNote: 'Form chuẩn vừa vặn cho dáng người nhỏ nhắn',
  },
  {
    sizeCode: 'M',
    minHeightCm: 155,
    maxHeightCm: 165,
    minWeightKg: 48,
    maxWeightKg: 55,
    chestCm: 88,
    waistCm: 70,
    hipCm: 92,
    fitNote: 'Size phổ biến nhất — thoải mái vận động',
  },
  {
    sizeCode: 'L',
    minHeightCm: 160,
    maxHeightCm: 170,
    minWeightKg: 55,
    maxWeightKg: 62,
    chestCm: 92,
    waistCm: 74,
    hipCm: 96,
    fitNote: 'Phù hợp dáng người đầy đặn hoặc thích mặc rộng nhẹ',
  },
  {
    sizeCode: 'XL',
    minHeightCm: 162,
    maxHeightCm: 176,
    minWeightKg: 62,
    maxWeightKg: 75,
    chestCm: 96,
    waistCm: 78,
    hipCm: 100,
    fitNote: 'Form thoải mái, che khuyết điểm tốt',
  },
];

export const DEFAULT_BABY_DIAPER_SIZE_CHART: ProductSizeChartRowItem[] = [
  {
    sizeCode: 'NB (<5kg)',
    minHeightCm: 45,
    maxHeightCm: 58,
    minWeightKg: 2,
    maxWeightKg: 5,
    minAgeMonths: 0,
    maxAgeMonths: 2,
    fitNote: 'Dành cho bé sơ sinh dưới 5kg (rốn chưa rụng hoặc mới sinh)',
  },
  {
    sizeCode: 'S (4-8kg)',
    minHeightCm: 55,
    maxHeightCm: 68,
    minWeightKg: 4,
    maxWeightKg: 8,
    minAgeMonths: 1,
    maxAgeMonths: 5,
    fitNote: 'Bỉm dán/quần êm dịu cho bé từ 4kg đến 8kg',
  },
  {
    sizeCode: 'M (6-11kg)',
    minHeightCm: 65,
    maxHeightCm: 78,
    minWeightKg: 6,
    maxWeightKg: 11,
    minAgeMonths: 4,
    maxAgeMonths: 12,
    fitNote: 'Phù hợp giai đoạn bé tập lẫy, bò (6–11kg)',
  },
  {
    sizeCode: 'L (9-14kg)',
    minHeightCm: 72,
    maxHeightCm: 88,
    minWeightKg: 9,
    maxWeightKg: 14,
    minAgeMonths: 9,
    maxAgeMonths: 24,
    fitNote: 'Chống tràn năng động cho bé tập đứng & tập đi (9–14kg)',
  },
  {
    sizeCode: 'XL (12-17kg)',
    minHeightCm: 82,
    maxHeightCm: 100,
    minWeightKg: 12,
    maxWeightKg: 17,
    minAgeMonths: 18,
    maxAgeMonths: 36,
    fitNote: 'Lưng thun co giãn siêu mềm cho bé lớn 12–17kg',
  },
];

/**
 * Bộ mẫu Ngành hàng Khởi tạo Ban đầu (`buildInitialSellerCategories`)
 * Khi một Cửa hàng mới được tạo, hệ thống lưu cấu hình này vào `shop_workspaces.catalog_and_pos_config_json`
 * để Người bán có thể tự do Thêm / Sửa / Xóa / Bật / Tắt bất kỳ ngành hàng, trục biến thể, trường nhập tư vấn và quy tắc tư vấn nào.
 */
export function buildInitialSellerCategories(): SellerCategoryBlueprintItem[] {
  return [
    {
      categoryId: 'CAT_FASHION_APPAREL',
      code: 'FASHION_APPAREL',
      name: 'Thời trang, Giày dép & Phụ kiện',
      badgeLabel: 'Thời trang',
      iconEmoji: '👗',
      industryType: ProductIndustryTypeEnum.FASHION_APPAREL,
      defaultUnitName: 'Chiếc',
      attributeAxis1Name: 'Màu sắc',
      attributeAxis1SampleValues: ['Kem', 'Đen', 'Trắng', 'Be'],
      attributeAxis2Name: 'Kích cỡ (Size)',
      attributeAxis2SampleValues: ['S', 'M', 'L', 'XL'],
      requiresSerialImei: false,
      defaultWarrantyMonths: 0,
      requiresBatchExpiry: false,
      defaultShelfLifeMonths: 0,
      defaultStorageCondition: null,
      defaultMaxDiscountPercent: 15,
      enableAdvisorInPos: true,
      advisorTitle: 'Tư vấn Size Thời trang theo Chiều cao & Cân nặng',
      advisorFields: [
        {
          fieldKey: 'heightCm',
          label: 'Chiều cao khách',
          unit: 'cm',
          fieldType: 'NUMBER',
          defaultValue: 160,
          min: 130,
          max: 210,
          nerAutoFillField: 'heightCm',
        },
        {
          fieldKey: 'weightKg',
          label: 'Cân nặng khách',
          unit: 'kg',
          fieldType: 'NUMBER',
          defaultValue: 52,
          min: 30,
          max: 130,
          nerAutoFillField: 'weightKg',
        },
      ],
      advisorRules: [
        {
          ruleId: 'RULE_APPAREL_S',
          recommendedResultCode: 'S',
          fitNote: 'Form chuẩn vừa vặn cho dáng người nhỏ nhắn (40–48kg, 148–158cm)',
          numericRanges: {
            heightCm: { min: 148, max: 158 },
            weightKg: { min: 40, max: 48 },
          },
          linkedSkuKeyword: '-S',
        },
        {
          ruleId: 'RULE_APPAREL_M',
          recommendedResultCode: 'M',
          fitNote: 'Size phổ biến nhất — thoải mái vận động (48–55kg, 155–165cm)',
          numericRanges: {
            heightCm: { min: 155, max: 165 },
            weightKg: { min: 48, max: 55 },
          },
          linkedSkuKeyword: '-M',
        },
        {
          ruleId: 'RULE_APPAREL_L',
          recommendedResultCode: 'L',
          fitNote: 'Phù hợp dáng người đầy đặn hoặc thích mặc rộng nhẹ (55–62kg, 160–170cm)',
          numericRanges: {
            heightCm: { min: 160, max: 170 },
            weightKg: { min: 55, max: 62 },
          },
          linkedSkuKeyword: '-L',
        },
        {
          ruleId: 'RULE_APPAREL_XL',
          recommendedResultCode: 'XL',
          fitNote: 'Form thoải mái, che khuyết điểm tốt (62–75kg, 162–176cm)',
          numericRanges: {
            heightCm: { min: 162, max: 176 },
            weightKg: { min: 62, max: 75 },
          },
          linkedSkuKeyword: '-XL',
        },
      ],
      isActive: true,
      sortOrder: 1,
    },
    {
      categoryId: 'CAT_COSMETICS_BEAUTY',
      code: 'COSMETICS_BEAUTY',
      name: 'Mỹ phẩm, Chăm sóc da & Làm đẹp (FEFO)',
      badgeLabel: 'Mỹ phẩm • FEFO',
      iconEmoji: '💄',
      industryType: ProductIndustryTypeEnum.COSMETICS_BEAUTY,
      defaultUnitName: 'Chai',
      attributeAxis1Name: 'Dung tích / Trọng lượng',
      attributeAxis1SampleValues: ['30ml', '50ml', '100ml'],
      attributeAxis2Name: 'Loại da phù hợp',
      attributeAxis2SampleValues: ['Mọi loại da', 'Da dầu mụn', 'Da khô nhạy cảm'],
      requiresSerialImei: false,
      defaultWarrantyMonths: 0,
      requiresBatchExpiry: true,
      defaultShelfLifeMonths: 24,
      defaultStorageCondition: 'Bảo quản nơi thoáng mát < 25°C, tránh ánh nắng trực tiếp',
      defaultMaxDiscountPercent: 18,
      enableAdvisorInPos: true,
      advisorTitle: 'Tư vấn Dòng Mỹ phẩm & Hoạt chất theo Tình trạng Da',
      advisorFields: [
        {
          fieldKey: 'skinType',
          label: 'Loại da / Tình trạng da',
          fieldType: 'SELECT',
          defaultValue: 'COMBINATION',
          options: [
            { value: 'OILY', label: 'Da dầu / Lỗ chân lông to / Dễ mụn' },
            { value: 'DRY', label: 'Da khô / Thiếu ẩm bong tróc' },
            { value: 'SENSITIVE', label: 'Da nhạy cảm / Đang treatment' },
            { value: 'COMBINATION', label: 'Da hỗn hợp / Mọi loại da' },
          ],
        },
      ],
      advisorRules: [
        {
          ruleId: 'RULE_SKIN_OILY',
          recommendedResultCode: '50ml (Cấp ẩm kiềm dầu B5 + HA)',
          fitNote: 'Da dầu/hỗn hợp nên ưu tiên kết cấu mỏng nhẹ thấm nhanh (Serum B5 + HA 50ml).',
          exactMatches: { skinType: 'OILY' },
          linkedSkuKeyword: 'SRM-B5',
        },
        {
          ruleId: 'RULE_SKIN_DRY',
          recommendedResultCode: '50ml (Phục hồi màng ẩm sâu B5 + HA)',
          fitNote: 'Da khô bong tróc cần phục hồi màng ẩm chuyên sâu với Vitamin B5 + HA.',
          exactMatches: { skinType: 'DRY' },
          linkedSkuKeyword: 'SRM-B5',
        },
        {
          ruleId: 'RULE_SKIN_SENSITIVE',
          recommendedResultCode: '50ml (Dịu nhẹ cho Mọi loại da & Da nhạy cảm)',
          fitNote: 'Da nhạy cảm/treatment phù hợp nhất với Tinh chất B5 + HA lành tính không cồn.',
          exactMatches: { skinType: 'SENSITIVE' },
          linkedSkuKeyword: 'SRM-B5',
        },
        {
          ruleId: 'RULE_SKIN_COMBINATION',
          recommendedResultCode: '50ml (Cân bằng ẩm B5 + HA)',
          fitNote: 'Da hỗn hợp phù hợp dùng Tinh chất B5 cấp ẩm vùng chữ U và kiềm dầu vùng chữ T.',
          exactMatches: { skinType: 'COMBINATION' },
          linkedSkuKeyword: 'SRM-B5',
        },
      ],
      isActive: true,
      sortOrder: 2,
    },
    {
      categoryId: 'CAT_ELECTRONICS_TECH',
      code: 'ELECTRONICS_TECH',
      name: 'Điện tử, Thiết bị số & Công nghệ (Serial/IMEI)',
      badgeLabel: 'Điện tử • IMEI',
      iconEmoji: '📱',
      industryType: ProductIndustryTypeEnum.ELECTRONICS_TECH,
      defaultUnitName: 'Máy',
      attributeAxis1Name: 'Phiên bản / Dung lượng',
      attributeAxis1SampleValues: ['Standard', 'Pro Ion+'],
      attributeAxis2Name: 'Màu sắc',
      attributeAxis2SampleValues: ['Đen Không Gian', 'Hồng Ngọc Trai', 'Bạc Titan'],
      requiresSerialImei: true,
      defaultWarrantyMonths: 12,
      requiresBatchExpiry: false,
      defaultShelfLifeMonths: 0,
      defaultStorageCondition: null,
      defaultMaxDiscountPercent: 12,
      enableAdvisorInPos: true,
      advisorTitle: 'Tư vấn Thiết bị Công nghệ & Gói Bảo hành Điện tử',
      advisorFields: [
        {
          fieldKey: 'usageNeed',
          label: 'Nhu cầu sử dụng',
          fieldType: 'SELECT',
          defaultValue: 'PRO_CARE',
          options: [
            { value: 'PRO_CARE', label: 'Chăm sóc chuyên sâu / Tần suất hàng ngày' },
            { value: 'GIFT_COMBO', label: 'Mua làm quà tặng cao cấp trọn bộ' },
          ],
        },
      ],
      advisorRules: [
        {
          ruleId: 'RULE_TECH_PRO',
          recommendedResultCode: 'Phiên bản Pro Ion+ (Bảo hành Điện tử 12T)',
          fitNote: 'Tích hợp sóng âm T-Sonic & đẩy tinh chất Ion+, bảo hành 1 đổi 1 theo Serial.',
          exactMatches: { usageNeed: 'PRO_CARE' },
          linkedSkuKeyword: 'S9-PRO',
        },
        {
          ruleId: 'RULE_TECH_GIFT',
          recommendedResultCode: 'Combo Thiết bị S9 Pro + Serum B5',
          fitNote: 'Phù hợp làm quà tặng cao cấp kèm kích hoạt bảo hành điện tử chính hãng.',
          exactMatches: { usageNeed: 'GIFT_COMBO' },
          linkedSkuKeyword: 'S9-PRO',
        },
      ],
      isActive: true,
      sortOrder: 3,
    },
    {
      categoryId: 'CAT_FOOD_BEVERAGE',
      code: 'FOOD_BEVERAGE',
      name: 'Thực phẩm, Đồ uống & Dinh dưỡng F&B',
      badgeLabel: 'Thực phẩm • HSD',
      iconEmoji: '🍵',
      industryType: ProductIndustryTypeEnum.FOOD_BEVERAGE,
      defaultUnitName: 'Hộp',
      attributeAxis1Name: 'Quy cách đóng gói',
      attributeAxis1SampleValues: ['Gói 250g', 'Hộp 500g', 'Thùng 12 Hộp'],
      attributeAxis2Name: 'Hương vị',
      attributeAxis2SampleValues: ['Nguyên bản', 'Vị Matcha Ít Ngọt', 'Vị Socola'],
      requiresSerialImei: false,
      defaultWarrantyMonths: 0,
      requiresBatchExpiry: true,
      defaultShelfLifeMonths: 12,
      defaultStorageCondition: 'Đậy kín nắp sau khi mở, bảo quản nơi khô mát',
      defaultMaxDiscountPercent: 15,
      enableAdvisorInPos: true,
      advisorTitle: 'Tư vấn Quy cách Đóng gói & Liệu trình Dinh dưỡng',
      advisorFields: [
        {
          fieldKey: 'weightKg',
          label: 'Cân nặng hiện tại',
          unit: 'kg',
          fieldType: 'NUMBER',
          defaultValue: 55,
          min: 30,
          max: 150,
          nerAutoFillField: 'weightKg',
        },
        {
          fieldKey: 'dietGoal',
          label: 'Mục tiêu dinh dưỡng',
          fieldType: 'SELECT',
          defaultValue: 'EAT_CLEAN',
          options: [
            { value: 'EAT_CLEAN', label: 'Ăn kiêng Eat Clean / Giảm đường' },
            { value: 'FAMILY_USE', label: 'Bữa sáng dinh dưỡng cho cả gia đình' },
          ],
        },
      ],
      advisorRules: [
        {
          ruleId: 'RULE_FOOD_MATCHA',
          recommendedResultCode: 'Hộp 500g - Vị Matcha Ít Ngọt',
          fitNote: 'Nướng mật ong tự nhiên không đường tinh luyện, dùng được 15–20 bữa sáng.',
          exactMatches: { dietGoal: 'EAT_CLEAN' },
          linkedSkuKeyword: 'GRN-500G',
        },
        {
          ruleId: 'RULE_FOOD_FAMILY',
          recommendedResultCode: 'Combo 2 Hộp 500g hoặc Thùng Sỉ',
          fitNote: 'Tiết kiệm chi phí cho gia đình 3–4 người sử dụng hàng ngày.',
          exactMatches: { dietGoal: 'FAMILY_USE' },
          linkedSkuKeyword: 'GRN-500G',
        },
      ],
      isActive: true,
      sortOrder: 4,
    },
    {
      categoryId: 'CAT_MOTHER_AND_BABY',
      code: 'MOTHER_AND_BABY',
      name: 'Mẹ & Bé (Bỉm, Sữa, Đồ sơ sinh)',
      badgeLabel: 'Mẹ & Bé',
      iconEmoji: '🍼',
      industryType: ProductIndustryTypeEnum.MOTHER_AND_BABY,
      defaultUnitName: 'Bịch',
      attributeAxis1Name: 'Size cân nặng / Độ tuổi',
      attributeAxis1SampleValues: ['S (4-8kg)', 'M (6-11kg)', 'L (9-14kg)', 'XL (12-17kg)'],
      attributeAxis2Name: 'Phân loại',
      attributeAxis2SampleValues: ['Tã dán', 'Tã quần'],
      requiresSerialImei: false,
      defaultWarrantyMonths: 0,
      requiresBatchExpiry: true,
      defaultShelfLifeMonths: 24,
      defaultStorageCondition: 'Nơi khô ráo, tránh ẩm ướt',
      defaultMaxDiscountPercent: 12,
      enableAdvisorInPos: true,
      advisorTitle: 'Tư vấn Size Bỉm / Quần áo cho Bé theo Cân nặng & Tháng tuổi',
      advisorFields: [
        {
          fieldKey: 'weightKg',
          label: 'Cân nặng của bé',
          unit: 'kg',
          fieldType: 'NUMBER',
          defaultValue: 8,
          min: 2,
          max: 30,
          nerAutoFillField: 'weightKg',
        },
        {
          fieldKey: 'babyAgeMonths',
          label: 'Tháng tuổi của bé',
          unit: 'tháng',
          fieldType: 'NUMBER',
          defaultValue: 6,
          min: 0,
          max: 60,
        },
      ],
      advisorRules: DEFAULT_BABY_DIAPER_SIZE_CHART.map((row, idx) => ({
        ruleId: `RULE_BABY_${idx + 1}`,
        recommendedResultCode: row.sizeCode,
        fitNote: row.fitNote || 'Form chuẩn cho bé',
        numericRanges: {
          weightKg: { min: row.minWeightKg, max: row.maxWeightKg },
          babyAgeMonths: {
            min: row.minAgeMonths ?? 0,
            max: row.maxAgeMonths ?? 36,
          },
        },
      })),
      isActive: true,
      sortOrder: 5,
    },
    {
      categoryId: 'CAT_HOME_LIVING',
      code: 'HOME_LIVING_APPLIANCES',
      name: 'Gia dụng, Nội thất & Đời sống',
      badgeLabel: 'Gia dụng',
      iconEmoji: '🏠',
      industryType: ProductIndustryTypeEnum.HOME_LIVING_APPLIANCES,
      defaultUnitName: 'Bộ',
      attributeAxis1Name: 'Kích thước / Công suất',
      attributeAxis1SampleValues: ['Tiêu chuẩn 3.5L', 'Cỡ lớn 5.5L'],
      attributeAxis2Name: 'Chất liệu / Màu',
      attributeAxis2SampleValues: ['Inox 304', 'Phủ Gốm Ceramic'],
      requiresSerialImei: true,
      defaultWarrantyMonths: 12,
      requiresBatchExpiry: false,
      defaultShelfLifeMonths: 0,
      defaultStorageCondition: null,
      defaultMaxDiscountPercent: 15,
      enableAdvisorInPos: false,
      advisorTitle: 'Tư vấn Dung tích & Công suất Gia dụng',
      advisorFields: [],
      advisorRules: [],
      isActive: true,
      sortOrder: 6,
    },
  ];
}

export const INDUSTRY_ATTRIBUTE_BLUEPRINTS: Record<
  ProductIndustryTypeEnum,
  {
    defaultCategoryName: string;
    defaultUnitName: string;
    axis1Name: string;
    axis2Name: string;
    requiresSerialImei: boolean;
    requiresBatchExpiry: boolean;
  }
> = {
  [ProductIndustryTypeEnum.FASHION_APPAREL]: {
    defaultCategoryName: 'Thời trang & Phụ kiện',
    defaultUnitName: 'Chiếc',
    axis1Name: 'Màu sắc',
    axis2Name: 'Kích cỡ (Size)',
    requiresSerialImei: false,
    requiresBatchExpiry: false,
  },
  [ProductIndustryTypeEnum.COSMETICS_BEAUTY]: {
    defaultCategoryName: 'Mỹ phẩm & Chăm sóc sắc đẹp',
    defaultUnitName: 'Chai',
    axis1Name: 'Dung tích / Trọng lượng',
    axis2Name: 'Phân loại da / Tone màu',
    requiresSerialImei: false,
    requiresBatchExpiry: true,
  },
  [ProductIndustryTypeEnum.ELECTRONICS_TECH]: {
    defaultCategoryName: 'Thiết bị Điện tử & Công nghệ',
    defaultUnitName: 'Máy',
    axis1Name: 'Phiên bản / Dung lượng',
    axis2Name: 'Màu sắc / Chuẩn kết nối',
    requiresSerialImei: true,
    requiresBatchExpiry: false,
  },
  [ProductIndustryTypeEnum.FOOD_BEVERAGE]: {
    defaultCategoryName: 'Thực phẩm, Đồ uống & Đặc sản',
    defaultUnitName: 'Hộp',
    axis1Name: 'Quy cách đóng gói',
    axis2Name: 'Hương vị',
    requiresSerialImei: false,
    requiresBatchExpiry: true,
  },
  [ProductIndustryTypeEnum.MOTHER_AND_BABY]: {
    defaultCategoryName: 'Mẹ & Bé (Bỉm, Sữa, Đồ sơ sinh)',
    defaultUnitName: 'Bịch',
    axis1Name: 'Độ tuổi / Size cân nặng',
    axis2Name: 'Phân loại / Quy cách',
    requiresSerialImei: false,
    requiresBatchExpiry: true,
  },
  [ProductIndustryTypeEnum.HOME_LIVING_APPLIANCES]: {
    defaultCategoryName: 'Gia dụng & Đời sống',
    defaultUnitName: 'Bộ',
    axis1Name: 'Kích thước / Công suất',
    axis2Name: 'Chất liệu / Kiểu dáng',
    requiresSerialImei: false,
    requiresBatchExpiry: false,
  },
  [ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY]: {
    defaultCategoryName: 'Đa ngành hàng',
    defaultUnitName: 'Sản phẩm',
    axis1Name: 'Phân loại 1',
    axis2Name: 'Phân loại 2',
    requiresSerialImei: false,
    requiresBatchExpiry: false,
  },
};

@Injectable()
export class CatalogAndBomService {
  constructor(
    @InjectRepository(ProductEntity)
    private readonly productRepo: Repository<ProductEntity>,
    @InjectRepository(ProductVariantEntity)
    private readonly variantRepo: Repository<ProductVariantEntity>,
    @InjectRepository(WarehouseStockItemEntity)
    private readonly stockRepo: Repository<WarehouseStockItemEntity>,
    @InjectRepository(ProductSerialItemEntity)
    private readonly serialRepo: Repository<ProductSerialItemEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    private readonly inventoryService: AtomicInventoryAndTransferService,
  ) {}

  private stripDiacriticsCode(raw: string): string {
    return (raw || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .replace(/[^a-zA-Z0-9]+/g, '')
      .toUpperCase();
  }

  /**
   * Lấy hoặc Khởi tạo Cấu hình Ngành hàng Động, Tư vấn Size/Thông số, Quà tặng kèm & Ngân hàng VietQR của Cửa hàng (`getShopCatalogAndPosConfig`)
   * Lưu trữ trực tiếp trong `shop_workspaces.catalog_and_pos_config_json` để Người bán toàn quyền tùy biến.
   */
  public async getShopCatalogAndPosConfig(shopId: string): Promise<ShopCatalogAndPosConfig> {
    const shop = await this.shopRepo.findOne({ where: { id: shopId } });
    const existing = shop?.catalogAndPosConfigJson;

    if (existing && Array.isArray(existing.categories) && existing.categories.length > 0) {
      return existing;
    }

    // Tìm SKU quà tặng hoặc SKU phụ kiện hiện có trong shop (nếu có) để gợi ý quy tắc quà tặng mặc định
    const giftCandidate = await this.variantRepo.findOne({
      where: { shopId, isActive: true },
      order: { retailPrice: 'ASC' },
    });

    const initialConfig: ShopCatalogAndPosConfig = {
      categories: buildInitialSellerCategories(),
      freeGiftRules: giftCandidate
        ? [
            {
              ruleId: 'GIFT_RULE_500K',
              ruleName: 'Tặng kèm phụ kiện cho đơn hàng từ 500.000đ',
              minOrderSubtotalVnd: 500000,
              requiredCategoryId: null,
              giftVariantId: giftCandidate.id,
              giftSkuCode: giftCandidate.skuCode,
              giftVariantName: giftCandidate.variantName,
              giftQty: 1,
              isActive: true,
            },
          ]
        : [],
      vietQrBankConfig: {
        bankBin: '970422',
        bankShortName: 'MBBank',
        accountNumber: '0988123456888',
        accountName: shop?.name
          ? this.stripDiacriticsCode(shop.name)
          : 'CONG TY TNHH PANCAKE SELLER OS',
        transferPrefix: 'SEVQR ORD',
        autoConfirmWebhookEnabled: true,
      },
      autoSeedDemoCatalogWhenEmpty: false,
      hasInitializedDefaultCatalog: existing?.hasInitializedDefaultCatalog ?? false,
      updatedAt: new Date().toISOString(),
    };

    if (shop) {
      shop.catalogAndPosConfigJson = initialConfig;
      await this.shopRepo.save(shop);
    }

    return initialConfig;
  }

  /**
   * Cập nhật Cấu hình Tổng thể Danh mục Ngành hàng Động, Quy tắc Quà tặng kèm & Tài khoản Ngân hàng VietQR của Cửa hàng
   */
  public async updateShopCatalogAndPosConfig(
    shopId: string,
    dto: UpdateShopCatalogPosConfigDto,
  ): Promise<ShopCatalogAndPosConfig> {
    const current = await this.getShopCatalogAndPosConfig(shopId);
    const updated: ShopCatalogAndPosConfig = {
      ...current,
      categories: Array.isArray(dto.categories) ? dto.categories : current.categories,
      freeGiftRules: Array.isArray(dto.freeGiftRules) ? dto.freeGiftRules : current.freeGiftRules,
      vietQrBankConfig: dto.vietQrBankConfig
        ? {
            ...current.vietQrBankConfig,
            ...dto.vietQrBankConfig,
          }
        : current.vietQrBankConfig,
      autoSeedDemoCatalogWhenEmpty:
        dto.autoSeedDemoCatalogWhenEmpty !== undefined
          ? dto.autoSeedDemoCatalogWhenEmpty
          : current.autoSeedDemoCatalogWhenEmpty,
      updatedAt: new Date().toISOString(),
    };

    const shop = await this.shopRepo.findOne({ where: { id: shopId } });
    if (shop) {
      shop.catalogAndPosConfigJson = updated;
      await this.shopRepo.save(shop);
    }

    return updated;
  }

  /**
   * Thêm mới hoặc Cập nhật 1 Ngành hàng / Danh mục sản phẩm tùy chỉnh của Người bán (`upsertSellerCategoryBlueprint`)
   */
  public async upsertSellerCategoryBlueprint(
    shopId: string,
    dto: UpsertSellerCategoryBlueprintDto,
  ): Promise<ShopCatalogAndPosConfig> {
    const config = await this.getShopCatalogAndPosConfig(shopId);
    const cleanCode = this.stripDiacriticsCode(dto.code || dto.name);
    const categoryId = (dto.categoryId || `CAT_${cleanCode}`).trim();

    const existingIdx = config.categories.findIndex(
      (c) => c.categoryId === categoryId || c.code === cleanCode,
    );
    const existingItem = existingIdx >= 0 ? config.categories[existingIdx] : null;

    const blueprintItem: SellerCategoryBlueprintItem = {
      categoryId,
      code: cleanCode,
      name: dto.name.trim(),
      badgeLabel: (dto.badgeLabel || dto.name).trim(),
      iconEmoji: dto.iconEmoji ?? existingItem?.iconEmoji ?? '📦',
      industryType:
        dto.industryType ||
        existingItem?.industryType ||
        ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY,
      defaultUnitName: (dto.defaultUnitName || existingItem?.defaultUnitName || 'Sản phẩm').trim(),
      attributeAxis1Name: (
        dto.attributeAxis1Name ||
        existingItem?.attributeAxis1Name ||
        'Phân loại 1'
      ).trim(),
      attributeAxis1SampleValues:
        Array.isArray(dto.attributeAxis1SampleValues) && dto.attributeAxis1SampleValues.length > 0
          ? dto.attributeAxis1SampleValues
          : existingItem?.attributeAxis1SampleValues || ['Tiêu chuẩn'],
      attributeAxis2Name: (
        dto.attributeAxis2Name ||
        existingItem?.attributeAxis2Name ||
        'Phân loại 2'
      ).trim(),
      attributeAxis2SampleValues:
        Array.isArray(dto.attributeAxis2SampleValues) && dto.attributeAxis2SampleValues.length > 0
          ? dto.attributeAxis2SampleValues
          : existingItem?.attributeAxis2SampleValues || ['Mặc định'],
      requiresSerialImei: dto.requiresSerialImei ?? existingItem?.requiresSerialImei ?? false,
      defaultWarrantyMonths: Number(
        dto.defaultWarrantyMonths ?? existingItem?.defaultWarrantyMonths ?? 0,
      ),
      requiresBatchExpiry: dto.requiresBatchExpiry ?? existingItem?.requiresBatchExpiry ?? false,
      defaultShelfLifeMonths: Number(
        dto.defaultShelfLifeMonths ?? existingItem?.defaultShelfLifeMonths ?? 0,
      ),
      defaultStorageCondition:
        dto.defaultStorageCondition !== undefined
          ? dto.defaultStorageCondition
          : (existingItem?.defaultStorageCondition ?? null),
      defaultMaxDiscountPercent: Number(
        dto.defaultMaxDiscountPercent ?? existingItem?.defaultMaxDiscountPercent ?? 15,
      ),
      enableAdvisorInPos: dto.enableAdvisorInPos ?? existingItem?.enableAdvisorInPos ?? true,
      advisorTitle:
        dto.advisorTitle || existingItem?.advisorTitle || `Tư vấn thông số ${dto.name.trim()}`,
      advisorFields: Array.isArray(dto.advisorFields)
        ? dto.advisorFields
        : existingItem?.advisorFields || [],
      advisorRules: Array.isArray(dto.advisorRules)
        ? dto.advisorRules
        : existingItem?.advisorRules || [],
      isActive: dto.isActive ?? existingItem?.isActive ?? true,
      sortOrder: Number(dto.sortOrder ?? existingItem?.sortOrder ?? config.categories.length + 1),
    };

    const nextCategories = [...config.categories];
    if (existingIdx >= 0) {
      nextCategories[existingIdx] = blueprintItem;
    } else {
      nextCategories.push(blueprintItem);
    }

    return this.updateShopCatalogAndPosConfig(shopId, {
      categories: nextCategories,
    });
  }

  /**
   * Xóa một Ngành hàng / Danh mục tùy chỉnh khỏi cấu hình của Cửa hàng
   */
  public async deleteSellerCategoryBlueprint(
    shopId: string,
    categoryId: string,
  ): Promise<ShopCatalogAndPosConfig> {
    const config = await this.getShopCatalogAndPosConfig(shopId);
    const nextCategories = config.categories.filter((c) => c.categoryId !== categoryId);
    return this.updateShopCatalogAndPosConfig(shopId, {
      categories: nextCategories,
    });
  }

  /**
   * Tính trọng lượng quy đổi thể tích chuẩn hãng vận chuyển 3PL (`(Dài x Rộng x Cao) / 5` tính ra gram)
   */
  public computeVolumetricAndChargeableWeightGrams(params: {
    weightGrams?: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
  }): {
    volumetricWeightGrams: number;
    chargeableWeightGrams: number;
  } {
    const actualWeight = Math.max(50, Number(params.weightGrams || 300));
    const l = Math.max(1, Number(params.lengthCm || 20));
    const w = Math.max(1, Number(params.widthCm || 15));
    const h = Math.max(1, Number(params.heightCm || 5));
    const volumetricWeightGrams = Math.round((l * w * h) / 5);
    const chargeableWeightGrams = Math.max(actualWeight, volumetricWeightGrams);
    return { volumetricWeightGrams, chargeableWeightGrams };
  }

  /**
   * Khởi tạo bộ dữ liệu Danh mục Sản phẩm Mẫu cho Cửa hàng mới (chỉ chạy 1 lần duy nhất khi shop mới tinh chưa khởi tạo
   * hoặc khi người bán chủ động bấm nút "Nạp dữ liệu mẫu tham khảo" `forceSeed = true`).
   * Nếu người bán đã xóa toàn bộ sản phẩm để tự nhập hàng riêng, hệ thống tôn trọng tuyệt đối và không tự ý chèn lại!
   */
  public async ensureSeededCatalogForShop(shopId: string, forceSeed = false): Promise<void> {
    const existingCount = await this.variantRepo.count({ where: { shopId } });
    if (existingCount > 0 && !forceSeed) return;

    const shop = await this.shopRepo.findOne({ where: { id: shopId } });
    const currentConfig = shop?.catalogAndPosConfigJson;
    if (
      !forceSeed &&
      currentConfig?.hasInitializedDefaultCatalog &&
      !currentConfig?.autoSeedDemoCatalogWhenEmpty
    ) {
      return;
    }

    if (existingCount > 0 && forceSeed) {
      return;
    }

    const warehouses = await this.inventoryService.ensureDefaultWarehousesForShop(shopId);
    const hnWh = warehouses[0];
    const hcmWh = warehouses[1] || warehouses[0];

    // 1. Ngành Thời trang (`CAT_FASHION_APPAREL`): Đầm Lụa có Ma trận Biến thể (Màu x Size)
    const dressProd = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: 'DAM-LUA-A12',
        name: 'Đầm Lụa Thiết Kế Dự Tiệc Cao Cấp A12',
        customCategoryId: 'CAT_FASHION_APPAREL',
        industryType: ProductIndustryTypeEnum.FASHION_APPAREL,
        categoryName: 'Thời trang, Giày dép & Phụ kiện',
        brandName: 'Pancake Couture',
        unitName: 'Chiếc',
        attributeAxis1Name: 'Màu sắc',
        attributeAxis2Name: 'Kích cỡ',
        sizeChartMetadataJson: DEFAULT_APPAREL_SIZE_CHART,
        isActive: true,
      }),
    );

    const dressVariantsSeed = [
      {
        sku: 'A12-KEM-S',
        color: 'Kem',
        size: 'S',
        price: 450000,
        cost: 220000,
        hnQty: 18,
        hcmQty: 12,
      },
      {
        sku: 'A12-KEM-M',
        color: 'Kem',
        size: 'M',
        price: 450000,
        cost: 220000,
        hnQty: 25,
        hcmQty: 15,
      },
      {
        sku: 'A12-KEM-L',
        color: 'Kem',
        size: 'L',
        price: 450000,
        cost: 220000,
        hnQty: 10,
        hcmQty: 8,
      },
      {
        sku: 'A12-DEN-M',
        color: 'Đen',
        size: 'M',
        price: 450000,
        cost: 220000,
        hnQty: 14,
        hcmQty: 0,
      },
    ];

    const createdDressVariants: ProductVariantEntity[] = [];
    for (let i = 0; i < dressVariantsSeed.length; i++) {
      const item = dressVariantsSeed[i];
      const v = await this.variantRepo.save(
        this.variantRepo.create({
          shopId,
          productId: dressProd.id,
          customCategoryId: 'CAT_FASHION_APPAREL',
          industryType: ProductIndustryTypeEnum.FASHION_APPAREL,
          categoryName: dressProd.categoryName,
          brandName: dressProd.brandName,
          unitName: dressProd.unitName,
          skuCode: item.sku,
          barcode: `89385059701${i + 1}`,
          variantName: `${dressProd.name} - Màu ${item.color} - Size ${item.size}`,
          colorName: item.color,
          sizeCode: item.size,
          attributeAxis1Name: 'Màu sắc',
          attributeAxis1Value: item.color,
          attributeAxis2Name: 'Kích cỡ',
          attributeAxis2Value: item.size,
          attributesJson: { 'Màu sắc': item.color, 'Kích cỡ': item.size },
          retailPrice: item.price,
          wholesalePrice: item.price - 60000,
          costPrice: item.cost,
          maxDiscountPercent: 15,
          weightGrams: 350,
          isBundleBom: false,
          requiresSerialImei: false,
          requiresBatchExpiry: false,
          sizeChartMetadataJson: DEFAULT_APPAREL_SIZE_CHART,
          isActive: true,
        }),
      );
      createdDressVariants.push(v);

      await this.stockRepo.save([
        this.stockRepo.create({
          shopId,
          warehouseId: hnWh.id,
          variantId: v.id,
          skuCode: v.skuCode,
          onHandQty: item.hnQty,
          reservedQty: 0,
          availableQty: item.hnQty,
          inTransitQty: 0,
          defectiveHoldQty: 0,
          binLocationCode: `HN-A0${i + 1}`,
          lowStockThreshold: 5,
        }),
        this.stockRepo.create({
          shopId,
          warehouseId: hcmWh.id,
          variantId: v.id,
          skuCode: v.skuCode,
          onHandQty: item.hcmQty,
          reservedQty: 0,
          availableQty: item.hcmQty,
          inTransitQty: 0,
          defectiveHoldQty: 0,
          binLocationCode: `HCM-B0${i + 1}`,
          lowStockThreshold: 5,
        }),
      ]);
    }

    // 2. Ngành Phụ kiện & Quà tặng kèm (`CAT_FASHION_APPAREL`)
    const bagProd = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: 'TUI-COI-B05',
        name: 'Túi Cói Đi Biển Thêu Hoa Vintage B05',
        customCategoryId: 'CAT_FASHION_APPAREL',
        industryType: ProductIndustryTypeEnum.FASHION_APPAREL,
        categoryName: 'Thời trang, Giày dép & Phụ kiện',
        brandName: 'Pancake Chic',
        unitName: 'Chiếc',
        attributeAxis1Name: 'Màu sắc',
        attributeAxis2Name: 'Kích cỡ',
        isActive: true,
      }),
    );

    const bagVariant = await this.variantRepo.save(
      this.variantRepo.create({
        shopId,
        productId: bagProd.id,
        customCategoryId: 'CAT_FASHION_APPAREL',
        industryType: ProductIndustryTypeEnum.FASHION_APPAREL,
        categoryName: bagProd.categoryName,
        brandName: bagProd.brandName,
        unitName: bagProd.unitName,
        skuCode: 'B05-BE-FREE',
        barcode: '893850597021',
        variantName: 'Túi Cói Đi Biển Thêu Hoa B05 - Màu Be (Freesize)',
        colorName: 'Be',
        sizeCode: 'FREESIZE',
        attributeAxis1Name: 'Màu sắc',
        attributeAxis1Value: 'Be',
        attributeAxis2Name: 'Kích cỡ',
        attributeAxis2Value: 'FREESIZE',
        attributesJson: { 'Màu sắc': 'Be', 'Kích cỡ': 'FREESIZE' },
        retailPrice: 240000,
        wholesalePrice: 180000,
        costPrice: 110000,
        maxDiscountPercent: 20,
        weightGrams: 250,
        isBundleBom: false,
        isFreeGiftItem: true,
        requiresSerialImei: false,
        isActive: true,
      }),
    );

    await this.stockRepo.save([
      this.stockRepo.create({
        shopId,
        warehouseId: hnWh.id,
        variantId: bagVariant.id,
        skuCode: bagVariant.skuCode,
        onHandQty: 6,
        reservedQty: 0,
        availableQty: 6,
        inTransitQty: 0,
        defectiveHoldQty: 0,
        binLocationCode: 'HN-C01',
        lowStockThreshold: 3,
      }),
      this.stockRepo.create({
        shopId,
        warehouseId: hcmWh.id,
        variantId: bagVariant.id,
        skuCode: bagVariant.skuCode,
        onHandQty: 20,
        reservedQty: 0,
        availableQty: 20,
        inTransitQty: 0,
        defectiveHoldQty: 0,
        binLocationCode: 'HCM-C01',
        lowStockThreshold: 5,
      }),
    ]);

    // 3. Sản phẩm Combo (`Bundle BOM` — F05.7): Gộp Đầm A12-KEM-M + Túi Cói B05-BE-FREE
    const bundleVariant = await this.variantRepo.save(
      this.variantRepo.create({
        shopId,
        productId: dressProd.id,
        customCategoryId: 'CAT_FASHION_APPAREL',
        industryType: ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY,
        categoryName: 'Combo Tiết Kiệm (Bundle BOM)',
        brandName: 'Pancake Combo',
        unitName: 'Bộ',
        skuCode: 'COMBO-A12-B05',
        barcode: '893850597099',
        variantName: 'Combo Dự Tiệc & Dạo Phố (Đầm Lụa A12 Kem Size M + Túi Cói B05)',
        colorName: 'Kem + Be',
        sizeCode: 'M',
        attributeAxis1Name: 'Gói Combo',
        attributeAxis1Value: 'Kem + Be',
        attributeAxis2Name: 'Kích cỡ',
        attributeAxis2Value: 'M',
        retailPrice: 590000,
        wholesalePrice: 520000,
        costPrice: 330000,
        maxDiscountPercent: 10,
        weightGrams: 600,
        isBundleBom: true,
        bundleComponentsJson: [
          {
            componentVariantId: createdDressVariants[1].id,
            componentSkuCode: createdDressVariants[1].skuCode,
            componentName: createdDressVariants[1].variantName,
            requiredQty: 1,
            retailPriceSnapshot: 450000,
          },
          {
            componentVariantId: bagVariant.id,
            componentSkuCode: bagVariant.skuCode,
            componentName: bagVariant.variantName,
            requiredQty: 1,
            retailPriceSnapshot: 240000,
          },
        ],
        isActive: true,
      }),
    );

    await this.stockRepo.save([
      this.stockRepo.create({
        shopId,
        warehouseId: hnWh.id,
        variantId: bundleVariant.id,
        skuCode: bundleVariant.skuCode,
        onHandQty: 6,
        reservedQty: 0,
        availableQty: 6,
        inTransitQty: 0,
        defectiveHoldQty: 0,
        binLocationCode: 'BOM-VIRTUAL',
        lowStockThreshold: 2,
      }),
      this.stockRepo.create({
        shopId,
        warehouseId: hcmWh.id,
        variantId: bundleVariant.id,
        skuCode: bundleVariant.skuCode,
        onHandQty: 15,
        reservedQty: 0,
        availableQty: 15,
        inTransitQty: 0,
        defectiveHoldQty: 0,
        binLocationCode: 'BOM-VIRTUAL',
        lowStockThreshold: 2,
      }),
    ]);

    // 4. Ngành Điện tử & Thiết bị Công nghệ quản lý theo Serial / IMEI (`CAT_ELECTRONICS_TECH` — F05.8)
    const deviceProd = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: 'MAY-RUA-MAT-S9',
        name: 'Máy Rửa Mặt & Đẩy Tinh Chất Sóng Âm S9 Pro',
        customCategoryId: 'CAT_ELECTRONICS_TECH',
        industryType: ProductIndustryTypeEnum.ELECTRONICS_TECH,
        categoryName: 'Điện tử, Thiết bị số & Công nghệ (Serial/IMEI)',
        brandName: 'Pancake BeautyTech',
        unitName: 'Máy',
        attributeAxis1Name: 'Phiên bản',
        attributeAxis2Name: 'Màu sắc',
        technicalSpecsJson: {
          'Tần số rung': '12.000 nhịp/phút (T-Sonic)',
          'Chuẩn kháng nước': 'IPX7 chống nước toàn thân',
          'Dung lượng Pin': '650mAh (Sạc nhanh Type-C)',
          'Bảo hành điện tử': '12 tháng 1 đổi 1 theo Serial/IMEI',
        },
        isActive: true,
      }),
    );

    const deviceVariant = await this.variantRepo.save(
      this.variantRepo.create({
        shopId,
        productId: deviceProd.id,
        customCategoryId: 'CAT_ELECTRONICS_TECH',
        industryType: ProductIndustryTypeEnum.ELECTRONICS_TECH,
        categoryName: deviceProd.categoryName,
        brandName: deviceProd.brandName,
        unitName: deviceProd.unitName,
        skuCode: 'S9-PRO-ROSE',
        barcode: '893850597088',
        variantName: 'Máy Rửa Mặt Sóng Âm S9 Pro - Hồng Ngọc Trai (BH Điện tử 12T)',
        colorName: 'Hồng Ngọc Trai',
        sizeCode: 'PRO',
        attributeAxis1Name: 'Phiên bản',
        attributeAxis1Value: 'Pro Ion+',
        attributeAxis2Name: 'Màu sắc',
        attributeAxis2Value: 'Hồng Ngọc Trai',
        attributesJson: { 'Phiên bản': 'Pro Ion+', 'Màu sắc': 'Hồng Ngọc Trai' },
        retailPrice: 1290000,
        wholesalePrice: 990000,
        costPrice: 680000,
        maxDiscountPercent: 12,
        weightGrams: 420,
        isBundleBom: false,
        requiresSerialImei: true,
        warrantyMonths: 12,
        technicalSpecsJson: deviceProd.technicalSpecsJson,
        isActive: true,
      }),
    );

    await this.stockRepo.save([
      this.stockRepo.create({
        shopId,
        warehouseId: hnWh.id,
        variantId: deviceVariant.id,
        skuCode: deviceVariant.skuCode,
        onHandQty: 5,
        reservedQty: 0,
        availableQty: 5,
        inTransitQty: 0,
        defectiveHoldQty: 0,
        binLocationCode: 'HN-TECH-01',
        lowStockThreshold: 2,
      }),
    ]);

    const sampleSerials = ['SN-S9PRO-2026001', 'SN-S9PRO-2026002', 'SN-S9PRO-2026003'];
    for (const sn of sampleSerials) {
      await this.serialRepo.save(
        this.serialRepo.create({
          shopId,
          warehouseId: hnWh.id,
          variantId: deviceVariant.id,
          skuCode: deviceVariant.skuCode,
          variantName: deviceVariant.variantName,
          serialNumber: sn,
          status: ProductSerialStatusEnum.IN_STOCK,
          warrantyMonths: 12,
        }),
      );
    }

    // 5. Ngành Mỹ phẩm & Chăm sóc da quản lý Lô & Hạn sử dụng FEFO (`CAT_COSMETICS_BEAUTY`)
    const serumProd = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: 'SERUM-B5-HYDRA',
        name: 'Tinh Chất Phục Hồi Cấp Ẩm Chuyên Sâu Vitamin B5 + HA',
        customCategoryId: 'CAT_COSMETICS_BEAUTY',
        industryType: ProductIndustryTypeEnum.COSMETICS_BEAUTY,
        categoryName: 'Mỹ phẩm, Chăm sóc da & Làm đẹp (FEFO)',
        brandName: 'Pancake DermaLab',
        unitName: 'Chai',
        attributeAxis1Name: 'Dung tích',
        attributeAxis2Name: 'Loại da phù hợp',
        requiresBatchExpiry: true,
        shelfLifeMonths: 24,
        storageCondition: 'Bảo quản nơi thoáng mát < 25°C, tránh ánh nắng trực tiếp',
        isActive: true,
      }),
    );

    const serumVariant = await this.variantRepo.save(
      this.variantRepo.create({
        shopId,
        productId: serumProd.id,
        customCategoryId: 'CAT_COSMETICS_BEAUTY',
        industryType: ProductIndustryTypeEnum.COSMETICS_BEAUTY,
        categoryName: serumProd.categoryName,
        brandName: serumProd.brandName,
        unitName: 'Chai',
        skuCode: 'SRM-B5-50ML-ALL',
        barcode: '893850597055',
        variantName: 'Tinh Chất Phục Hồi Vitamin B5 + HA - Bản 50ml (Mọi loại da & Da nhạy cảm)',
        colorName: '50ml',
        sizeCode: 'ALL-SKIN',
        attributeAxis1Name: 'Dung tích',
        attributeAxis1Value: '50ml',
        attributeAxis2Name: 'Loại da phù hợp',
        attributeAxis2Value: 'Mọi loại da & Da nhạy cảm',
        attributesJson: {
          'Dung tích': '50ml',
          'Loại da phù hợp': 'Mọi loại da & Da nhạy cảm',
        },
        retailPrice: 385000,
        wholesalePrice: 295000,
        costPrice: 175000,
        maxDiscountPercent: 18,
        weightGrams: 180,
        isBundleBom: false,
        requiresSerialImei: false,
        requiresBatchExpiry: true,
        batchCode: 'LOT-DERMA-2610',
        manufacturingDate: '2026-10-01',
        expiryDate: '2028-10-01',
        shelfLifeMonths: 24,
        storageCondition: serumProd.storageCondition,
        isActive: true,
      }),
    );

    await this.stockRepo.save([
      this.stockRepo.create({
        shopId,
        warehouseId: hnWh.id,
        variantId: serumVariant.id,
        skuCode: serumVariant.skuCode,
        onHandQty: 32,
        reservedQty: 0,
        availableQty: 32,
        inTransitQty: 0,
        defectiveHoldQty: 0,
        binLocationCode: 'HN-COSM-02',
        lowStockThreshold: 8,
      }),
      this.stockRepo.create({
        shopId,
        warehouseId: hcmWh.id,
        variantId: serumVariant.id,
        skuCode: serumVariant.skuCode,
        onHandQty: 24,
        reservedQty: 0,
        availableQty: 24,
        inTransitQty: 0,
        defectiveHoldQty: 0,
        binLocationCode: 'HCM-COSM-02',
        lowStockThreshold: 8,
      }),
    ]);

    // 6. Ngành Thực phẩm & Đồ uống (`CAT_FOOD_BEVERAGE`) có Quy đổi Đơn vị tính & Hạn sử dụng
    const foodProd = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: 'GRANOLA-MATCHA-01',
        name: 'Ngũ Cốc Hạt Dinh Dưỡng Nướng Mật Ong & Matcha Uji Nhật Bản',
        customCategoryId: 'CAT_FOOD_BEVERAGE',
        industryType: ProductIndustryTypeEnum.FOOD_BEVERAGE,
        categoryName: 'Thực phẩm, Đồ uống & Dinh dưỡng F&B',
        brandName: 'Pancake NutriFood',
        unitName: 'Hộp',
        attributeAxis1Name: 'Quy cách đóng gói',
        attributeAxis2Name: 'Hương vị',
        requiresBatchExpiry: true,
        shelfLifeMonths: 12,
        storageCondition: 'Đậy kín nắp sau khi mở, bảo quản nơi khô mát',
        uomConversionsJson: [
          { unitName: 'Hộp lẻ 500g', conversionFactor: 1, retailPrice: 195000 },
          { unitName: 'Thùng sỉ 12 Hộp', conversionFactor: 12, retailPrice: 1980000 },
        ],
        isActive: true,
      }),
    );

    const foodVariant = await this.variantRepo.save(
      this.variantRepo.create({
        shopId,
        productId: foodProd.id,
        customCategoryId: 'CAT_FOOD_BEVERAGE',
        industryType: ProductIndustryTypeEnum.FOOD_BEVERAGE,
        categoryName: foodProd.categoryName,
        brandName: foodProd.brandName,
        unitName: 'Hộp',
        skuCode: 'GRN-500G-MATCHA',
        barcode: '893850597066',
        variantName: 'Ngũ Cốc Hạt Dinh Dưỡng Granola - Hộp 500g - Vị Matcha Ít Ngọt',
        colorName: 'Hộp 500g',
        sizeCode: 'MATCHA',
        attributeAxis1Name: 'Quy cách đóng gói',
        attributeAxis1Value: 'Hộp 500g',
        attributeAxis2Name: 'Hương vị',
        attributeAxis2Value: 'Vị Matcha Ít Ngọt',
        attributesJson: {
          'Quy cách đóng gói': 'Hộp 500g',
          'Hương vị': 'Vị Matcha Ít Ngọt',
        },
        retailPrice: 195000,
        wholesalePrice: 165000,
        costPrice: 105000,
        maxDiscountPercent: 15,
        weightGrams: 550,
        isBundleBom: false,
        requiresSerialImei: false,
        requiresBatchExpiry: true,
        batchCode: 'LOT-FOOD-2611',
        manufacturingDate: '2026-11-01',
        expiryDate: '2027-11-01',
        shelfLifeMonths: 12,
        storageCondition: foodProd.storageCondition,
        uomConversionsJson: foodProd.uomConversionsJson,
        isActive: true,
      }),
    );

    await this.stockRepo.save([
      this.stockRepo.create({
        shopId,
        warehouseId: hnWh.id,
        variantId: foodVariant.id,
        skuCode: foodVariant.skuCode,
        onHandQty: 40,
        reservedQty: 0,
        availableQty: 40,
        inTransitQty: 0,
        defectiveHoldQty: 0,
        binLocationCode: 'HN-FOOD-01',
        lowStockThreshold: 10,
      }),
      this.stockRepo.create({
        shopId,
        warehouseId: hcmWh.id,
        variantId: foodVariant.id,
        skuCode: foodVariant.skuCode,
        onHandQty: 35,
        reservedQty: 0,
        availableQty: 35,
        inTransitQty: 0,
        defectiveHoldQty: 0,
        binLocationCode: 'HCM-FOOD-01',
        lowStockThreshold: 10,
      }),
    ]);

    // Đánh dấu cửa hàng đã khởi tạo catalog lần đầu để nếu người bán xóa sản phẩm mẫu thì không bao giờ tự động sinh lại nữa
    const config = await this.getShopCatalogAndPosConfig(shopId);
    config.hasInitializedDefaultCatalog = true;
    if (config.freeGiftRules.length === 0) {
      config.freeGiftRules = [
        {
          ruleId: 'GIFT_RULE_500K',
          ruleName: 'Tặng kèm Túi Cói B05 cho đơn hàng từ 500.000đ',
          minOrderSubtotalVnd: 500000,
          requiredCategoryId: null,
          giftVariantId: bagVariant.id,
          giftSkuCode: bagVariant.skuCode,
          giftVariantName: bagVariant.variantName,
          giftQty: 1,
          isActive: true,
        },
      ];
    }
    if (shop) {
      shop.catalogAndPosConfigJson = config;
      await this.shopRepo.save(shop);
    }
  }

  /**
   * F05.1 & F05.2: Lấy toàn bộ Danh mục Biến thể SKU kèm Tồn kho 4 trạng thái tại từng Kho,
   * đồng thời trả về Cấu hình Ngành hàng Động (`catalogConfig`) của Người bán.
   */
  public async listCatalogVariantsWithMultiWarehouseStock(params: {
    shopId: string;
    search?: string;
    warehouseId?: string;
    bundleOnly?: boolean;
    industryType?: ProductIndustryTypeEnum;
    customCategoryId?: string;
  }): Promise<{
    warehouses: WarehouseEntity[];
    variants: EnrichedCatalogVariantItem[];
    catalogConfig: ShopCatalogAndPosConfig;
  }> {
    await this.ensureSeededCatalogForShop(params.shopId);

    const [warehouses, allVariants, allStocks, catalogConfig] = await Promise.all([
      this.inventoryService.ensureDefaultWarehousesForShop(params.shopId),
      this.variantRepo.find({
        where: { shopId: params.shopId, isActive: true },
        order: { createdAt: 'DESC' },
      }),
      this.stockRepo.find({ where: { shopId: params.shopId } }),
      this.getShopCatalogAndPosConfig(params.shopId),
    ]);

    const stockByVariantAndWh = new Map<string, WarehouseStockItemEntity>();
    for (const st of allStocks) {
      stockByVariantAndWh.set(`${st.variantId}:${st.warehouseId}`, st);
    }

    const q = (params.search || '').trim().toLowerCase();
    const nowMs = Date.now();

    const enriched: EnrichedCatalogVariantItem[] = allVariants
      .filter((v) => {
        if (params.bundleOnly && !v.isBundleBom) return false;
        if (params.customCategoryId && v.customCategoryId !== params.customCategoryId) {
          return false;
        }
        if (params.industryType && v.industryType !== params.industryType) return false;
        if (!q) return true;
        return (
          v.skuCode.toLowerCase().includes(q) ||
          v.barcode.toLowerCase().includes(q) ||
          v.variantName.toLowerCase().includes(q) ||
          (v.categoryName || '').toLowerCase().includes(q) ||
          (v.brandName || '').toLowerCase().includes(q) ||
          (v.batchCode || '').toLowerCase().includes(q)
        );
      })
      .map((v) => {
        const stocksByWarehouse: WarehouseStockSummaryItem[] = warehouses.map((wh) => {
          if (
            v.isBundleBom &&
            Array.isArray(v.bundleComponentsJson) &&
            v.bundleComponentsJson.length > 0
          ) {
            const compAvailabilities = v.bundleComponentsJson.map((comp) => {
              const compSt = stockByVariantAndWh.get(`${comp.componentVariantId}:${wh.id}`);
              const avail = compSt ? compSt.availableQty : 0;
              return Math.floor(avail / Math.max(1, comp.requiredQty));
            });
            const bomAvailable =
              compAvailabilities.length > 0 ? Math.max(0, Math.min(...compAvailabilities)) : 0;
            return {
              warehouseId: wh.id,
              warehouseCode: wh.code,
              warehouseName: wh.name,
              provinceCode: wh.provinceCode,
              onHandQty: bomAvailable,
              reservedQty: 0,
              availableQty: bomAvailable,
              inTransitQty: 0,
              defectiveHoldQty: 0,
              binLocationCode: 'BOM-DYNAMIC',
            };
          }

          const st = stockByVariantAndWh.get(`${v.id}:${wh.id}`);
          return {
            warehouseId: wh.id,
            warehouseCode: wh.code,
            warehouseName: wh.name,
            provinceCode: wh.provinceCode,
            onHandQty: st?.onHandQty || 0,
            reservedQty: st?.reservedQty || 0,
            availableQty: st?.availableQty || 0,
            inTransitQty: st?.inTransitQty || 0,
            defectiveHoldQty: st?.defectiveHoldQty || 0,
            binLocationCode: st?.binLocationCode || 'KHU-A-01',
          };
        });

        const filteredStocks = params.warehouseId
          ? stocksByWarehouse.filter((s) => s.warehouseId === params.warehouseId)
          : stocksByWarehouse;

        const totalOnHandQty = filteredStocks.reduce((acc, s) => acc + s.onHandQty, 0);
        const totalReservedQty = filteredStocks.reduce((acc, s) => acc + s.reservedQty, 0);
        const totalAvailableQty = filteredStocks.reduce((acc, s) => acc + s.availableQty, 0);
        const totalDefectiveHoldQty = filteredStocks.reduce(
          (acc, s) => acc + s.defectiveHoldQty,
          0,
        );

        const { volumetricWeightGrams, chargeableWeightGrams } =
          this.computeVolumetricAndChargeableWeightGrams({
            weightGrams: v.weightGrams,
            lengthCm: v.lengthCm,
            widthCm: v.widthCm,
            heightCm: v.heightCm,
          });

        let daysUntilExpiry: number | null = null;
        let isNearExpiryWarning = false;
        if (v.requiresBatchExpiry && v.expiryDate) {
          const expMs = Date.parse(v.expiryDate);
          if (!Number.isNaN(expMs)) {
            daysUntilExpiry = Math.ceil((expMs - nowMs) / 86_400_000);
            isNearExpiryWarning = daysUntilExpiry <= 60;
          }
        }

        return Object.assign(v, {
          retailPrice: Number(v.retailPrice || 0),
          wholesalePrice: Number(v.wholesalePrice || 0),
          costPrice: Number(v.costPrice || 0),
          volumetricWeightGrams,
          chargeableWeightGrams,
          daysUntilExpiry,
          isNearExpiryWarning,
          totalOnHandQty,
          totalReservedQty,
          totalAvailableQty,
          totalDefectiveHoldQty,
          stocksByWarehouse,
        });
      });

    return {
      warehouses,
      variants: enriched,
      catalogConfig,
    };
  }

  /**
   * F05.1: Khởi tạo Sản phẩm mới kèm Ma trận Biến thể Tự động dựa trên Cấu hình Ngành hàng Động của Người bán (`SellerCategoryBlueprintItem`)
   */
  public async createProductWithVariantMatrix(params: {
    shopId: string;
    actorUserId: string;
    dto: CreateProductWithMatrixDto;
  }): Promise<{
    product: ProductEntity;
    createdVariants: ProductVariantEntity[];
  }> {
    const { shopId, actorUserId, dto } = params;
    const [warehouses, catalogConfig] = await Promise.all([
      this.inventoryService.ensureDefaultWarehousesForShop(shopId),
      this.getShopCatalogAndPosConfig(shopId),
    ]);
    const defaultWh = warehouses.find((w) => w.isDefault) || warehouses[0];

    const cleanCode = this.stripDiacriticsCode(dto.code);
    const existingProd = await this.productRepo.findOne({
      where: { shopId, code: cleanCode },
    });
    if (existingProd) {
      throw new BadRequestException(`Mã sản phẩm [${cleanCode}] đã tồn tại trong cửa hàng.`);
    }

    // Tra cứu cấu hình ngành hàng do Người bán tự định nghĩa
    const sellerCategory =
      catalogConfig.categories.find(
        (c) =>
          (dto.customCategoryId && c.categoryId === dto.customCategoryId) ||
          (dto.categoryName && c.name.toLowerCase() === dto.categoryName.trim().toLowerCase()) ||
          (dto.industryType && c.industryType === dto.industryType),
      ) || null;

    const industryType =
      dto.industryType ||
      sellerCategory?.industryType ||
      ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY;
    const fallbackBlueprint =
      INDUSTRY_ATTRIBUTE_BLUEPRINTS[industryType] ||
      INDUSTRY_ATTRIBUTE_BLUEPRINTS[ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY];

    const resolvedCategoryId = sellerCategory?.categoryId || dto.customCategoryId || null;
    const resolvedCategoryName =
      dto.categoryName?.trim() || sellerCategory?.name || fallbackBlueprint.defaultCategoryName;
    const resolvedUnitName =
      dto.unitName?.trim() || sellerCategory?.defaultUnitName || fallbackBlueprint.defaultUnitName;

    const axis1Name = (
      dto.attributeAxis1Name ||
      sellerCategory?.attributeAxis1Name ||
      fallbackBlueprint.axis1Name
    ).trim();
    const axis2Name = (
      dto.attributeAxis2Name ||
      sellerCategory?.attributeAxis2Name ||
      fallbackBlueprint.axis2Name
    ).trim();

    const sizeChart =
      Array.isArray(dto.sizeChartMetadataJson) && dto.sizeChartMetadataJson.length > 0
        ? dto.sizeChartMetadataJson
        : null;

    const requiresSerialImei =
      dto.requiresSerialImei !== undefined
        ? dto.requiresSerialImei
        : (sellerCategory?.requiresSerialImei ?? fallbackBlueprint.requiresSerialImei);
    const requiresBatchExpiry =
      dto.requiresBatchExpiry !== undefined
        ? dto.requiresBatchExpiry
        : (sellerCategory?.requiresBatchExpiry ?? fallbackBlueprint.requiresBatchExpiry);

    const product = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: cleanCode,
        name: dto.name.trim(),
        customCategoryId: resolvedCategoryId,
        industryType,
        categoryName: resolvedCategoryName,
        brandName: dto.brandName || 'Thương hiệu riêng',
        unitName: resolvedUnitName,
        attributeAxis1Name: axis1Name,
        attributeAxis2Name: axis2Name,
        thumbnailUrl: dto.thumbnailUrl || null,
        description: dto.description || null,
        requiresBatchExpiry,
        shelfLifeMonths: Number(
          dto.shelfLifeMonths ??
            sellerCategory?.defaultShelfLifeMonths ??
            (requiresBatchExpiry ? 24 : 0),
        ),
        storageCondition: dto.storageCondition || sellerCategory?.defaultStorageCondition || null,
        technicalSpecsJson: dto.technicalSpecsJson || null,
        uomConversionsJson: dto.uomConversionsJson || null,
        sizeChartMetadataJson: sizeChart,
        freeGiftRulesJson: dto.freeGiftRulesJson || null,
        isActive: true,
      }),
    );

    const rawAxis1List =
      Array.isArray(dto.attributeAxis1Values) && dto.attributeAxis1Values.length > 0
        ? dto.attributeAxis1Values
        : Array.isArray(dto.colors) && dto.colors.length > 0
          ? dto.colors
          : sellerCategory?.attributeAxis1SampleValues?.length
            ? sellerCategory.attributeAxis1SampleValues
            : ['Tiêu chuẩn'];

    const rawAxis2List =
      Array.isArray(dto.attributeAxis2Values) && dto.attributeAxis2Values.length > 0
        ? dto.attributeAxis2Values
        : Array.isArray(dto.sizes) && dto.sizes.length > 0
          ? dto.sizes
          : sellerCategory?.attributeAxis2SampleValues?.length
            ? sellerCategory.attributeAxis2SampleValues
            : ['MẶC ĐỊNH'];

    const initQty = Math.max(0, Number(dto.initialOnHandQtyPerVariant ?? 25));

    const createdVariants: ProductVariantEntity[] = [];
    let seq = 1;

    for (const val1 of rawAxis1List) {
      for (const val2 of rawAxis2List) {
        const slug1 = this.stripDiacriticsCode(val1).slice(0, 6) || 'V1';
        const slug2 = this.stripDiacriticsCode(val2).slice(0, 6) || 'V2';
        const skuCode = `${cleanCode}-${slug1}-${slug2}`;
        const barcode = `893${String(Date.now()).slice(-7)}${String(seq).padStart(2, '0')}`;
        seq += 1;

        const variantLabelParts = [product.name];
        if (val1 && val1 !== 'Tiêu chuẩn') variantLabelParts.push(`${axis1Name}: ${val1}`);
        if (val2 && val2 !== 'MẶC ĐỊNH' && val2 !== 'FREESIZE') {
          variantLabelParts.push(`${axis2Name}: ${val2}`);
        } else if (val2 === 'FREESIZE') {
          variantLabelParts.push('Freesize');
        }

        const variant = await this.variantRepo.save(
          this.variantRepo.create({
            shopId,
            productId: product.id,
            customCategoryId: resolvedCategoryId,
            industryType,
            categoryName: product.categoryName,
            brandName: product.brandName,
            unitName: product.unitName,
            skuCode,
            barcode,
            variantName: variantLabelParts.join(' - '),
            colorName: val1,
            sizeCode: val2.toUpperCase(),
            attributeAxis1Name: axis1Name,
            attributeAxis1Value: val1,
            attributeAxis2Name: axis2Name,
            attributeAxis2Value: val2,
            attributesJson: {
              [axis1Name]: val1,
              [axis2Name]: val2,
            },
            retailPrice: Number(dto.retailPrice ?? 350000),
            wholesalePrice: Number(dto.wholesalePrice ?? 280000),
            costPrice: Number(dto.costPrice ?? 185000),
            maxDiscountPercent: Number(
              dto.maxDiscountPercent ?? sellerCategory?.defaultMaxDiscountPercent ?? 15,
            ),
            weightGrams: Number(dto.weightGrams ?? 300),
            lengthCm: Number(dto.lengthCm ?? 20),
            widthCm: Number(dto.widthCm ?? 15),
            heightCm: Number(dto.heightCm ?? 5),
            isBundleBom: false,
            isFreeGiftItem: Boolean(dto.isFreeGiftItem),
            requiresSerialImei,
            warrantyMonths: Number(
              dto.warrantyMonths ??
                sellerCategory?.defaultWarrantyMonths ??
                (requiresSerialImei ? 12 : 0),
            ),
            requiresBatchExpiry,
            batchCode:
              dto.batchCode || (requiresBatchExpiry ? `LOT-${cleanCode.slice(0, 6)}` : null),
            manufacturingDate: dto.manufacturingDate || null,
            expiryDate: dto.expiryDate || null,
            shelfLifeMonths: Number(
              dto.shelfLifeMonths ??
                sellerCategory?.defaultShelfLifeMonths ??
                (requiresBatchExpiry ? 24 : 0),
            ),
            storageCondition:
              dto.storageCondition || sellerCategory?.defaultStorageCondition || null,
            technicalSpecsJson: dto.technicalSpecsJson || null,
            uomConversionsJson: dto.uomConversionsJson || null,
            sizeChartMetadataJson: sizeChart,
            isActive: true,
          }),
        );
        createdVariants.push(variant);

        for (const wh of warehouses) {
          const qtyForWh = wh.id === defaultWh.id ? initQty : 0;
          await this.stockRepo.save(
            this.stockRepo.create({
              shopId,
              warehouseId: wh.id,
              variantId: variant.id,
              skuCode: variant.skuCode,
              onHandQty: qtyForWh,
              reservedQty: 0,
              availableQty: qtyForWh,
              inTransitQty: 0,
              defectiveHoldQty: 0,
              binLocationCode: 'KHU-A-01',
              lowStockThreshold: 5,
            }),
          );

          if (qtyForWh > 0) {
            await this.inventoryService.appendInventoryLedger({
              shopId,
              warehouseId: wh.id,
              variantId: variant.id,
              skuCode: variant.skuCode,
              movementType: InventoryMovementTypeEnum.PO_RECEIVE,
              deltaQty: qtyForWh,
              beforeOnHandQty: 0,
              afterOnHandQty: qtyForWh,
              beforeReservedQty: 0,
              afterReservedQty: 0,
              beforeAvailableQty: 0,
              afterAvailableQty: qtyForWh,
              costPrice: Number(variant.costPrice || 0),
              referenceType: 'INITIAL_MATRIX_SEED',
              referenceId: product.code,
              note: `Khởi tạo tồn kho ban đầu cho biến thể [${variant.skuCode}] (${product.categoryName})`,
              actorUserId,
            });
          }
        }
      }
    }

    return { product, createdVariants };
  }

  /**
   * Chỉnh sửa thông tin Biến thể SKU (`updateProductVariant`) cho phép Người bán cập nhật Giá lẻ, Giá vốn, Trần chiết khấu, Lô/HSD, Ngành hàng...
   */
  public async updateProductVariant(
    shopId: string,
    variantId: string,
    dto: UpdateProductVariantDto,
  ): Promise<ProductVariantEntity> {
    const variant = await this.variantRepo.findOne({
      where: { id: variantId, shopId },
    });
    if (!variant) {
      throw new NotFoundException('PRODUCT_VARIANT_NOT_FOUND');
    }

    if (dto.variantName !== undefined) variant.variantName = dto.variantName.trim();
    if (dto.customCategoryId !== undefined) variant.customCategoryId = dto.customCategoryId;
    if (dto.industryType !== undefined) variant.industryType = dto.industryType;
    if (dto.categoryName !== undefined) variant.categoryName = dto.categoryName.trim();
    if (dto.brandName !== undefined) variant.brandName = dto.brandName;
    if (dto.unitName !== undefined) variant.unitName = dto.unitName.trim();
    if (dto.barcode !== undefined) variant.barcode = dto.barcode.trim();
    if (dto.retailPrice !== undefined) variant.retailPrice = Number(dto.retailPrice);
    if (dto.wholesalePrice !== undefined) variant.wholesalePrice = Number(dto.wholesalePrice);
    if (dto.costPrice !== undefined) variant.costPrice = Number(dto.costPrice);
    if (dto.maxDiscountPercent !== undefined) {
      variant.maxDiscountPercent = Number(dto.maxDiscountPercent);
    }
    if (dto.weightGrams !== undefined) variant.weightGrams = Number(dto.weightGrams);
    if (dto.lengthCm !== undefined) variant.lengthCm = Number(dto.lengthCm);
    if (dto.widthCm !== undefined) variant.widthCm = Number(dto.widthCm);
    if (dto.heightCm !== undefined) variant.heightCm = Number(dto.heightCm);
    if (dto.isFreeGiftItem !== undefined) variant.isFreeGiftItem = dto.isFreeGiftItem;
    if (dto.requiresSerialImei !== undefined) variant.requiresSerialImei = dto.requiresSerialImei;
    if (dto.warrantyMonths !== undefined) variant.warrantyMonths = Number(dto.warrantyMonths);
    if (dto.requiresBatchExpiry !== undefined) {
      variant.requiresBatchExpiry = dto.requiresBatchExpiry;
    }
    if (dto.batchCode !== undefined) variant.batchCode = dto.batchCode;
    if (dto.expiryDate !== undefined) variant.expiryDate = dto.expiryDate;
    if (dto.storageCondition !== undefined) variant.storageCondition = dto.storageCondition;
    if (dto.isActive !== undefined) variant.isActive = dto.isActive;

    return this.variantRepo.save(variant);
  }

  /**
   * Xóa mềm / Ngừng kinh doanh Biến thể SKU (`deleteProductVariant`)
   */
  public async deleteProductVariant(
    shopId: string,
    variantId: string,
  ): Promise<{ deleted: boolean; variantId: string }> {
    const variant = await this.variantRepo.findOne({
      where: { id: variantId, shopId },
    });
    if (!variant) {
      throw new NotFoundException('PRODUCT_VARIANT_NOT_FOUND');
    }
    variant.isActive = false;
    await this.variantRepo.save(variant);
    return { deleted: true, variantId };
  }

  /**
   * F05.7: Tạo Sản phẩm Combo (`Bundle BOM`) định nghĩa định mức các SKU thành phần (hỗ trợ kết hợp sản phẩm xuyên ngành hàng)
   */
  public async createBundleBomVariant(
    shopId: string,
    dto: CreateBundleBomVariantDto,
  ): Promise<ProductVariantEntity> {
    if (!Array.isArray(dto.components) || dto.components.length === 0) {
      throw new BadRequestException('BUNDLE_BOM_REQUIRES_AT_LEAST_ONE_COMPONENT');
    }

    const warehouses = await this.inventoryService.ensureDefaultWarehousesForShop(shopId);
    let totalCostPrice = 0;
    let totalWeightGrams = 0;

    for (const comp of dto.components) {
      const compVar = await this.variantRepo.findOne({
        where: { id: comp.componentVariantId, shopId },
      });
      if (!compVar) {
        throw new NotFoundException(`SKU thành phần [${comp.componentSkuCode}] không tồn tại.`);
      }
      totalCostPrice += Number(compVar.costPrice || 0) * Math.max(1, comp.requiredQty);
      totalWeightGrams += Number(compVar.weightGrams || 250) * Math.max(1, comp.requiredQty);
    }

    let bundleParentProduct = await this.productRepo.findOne({
      where: { shopId, code: 'BUNDLE-COMBO-MASTER' },
    });
    if (!bundleParentProduct) {
      bundleParentProduct = await this.productRepo.save(
        this.productRepo.create({
          shopId,
          code: 'BUNDLE-COMBO-MASTER',
          name: 'Danh Mục Sản Phẩm Combo & Bộ Quà Tặng (Bundle BOM)',
          customCategoryId: dto.customCategoryId || null,
          industryType: ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY,
          categoryName: 'Combo Tiết Kiệm',
          brandName: 'Pancake Combo',
          unitName: 'Bộ',
          isActive: true,
        }),
      );
    }

    const cleanSku = dto.skuCode.trim().toUpperCase();
    const bundleVariant = await this.variantRepo.save(
      this.variantRepo.create({
        shopId,
        productId: bundleParentProduct.id,
        customCategoryId: dto.customCategoryId || null,
        industryType: dto.industryType || ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY,
        categoryName: 'Combo Tiết Kiệm (Bundle BOM)',
        brandName: 'Pancake Combo',
        unitName: 'Bộ',
        skuCode: cleanSku,
        barcode: `893BOM${String(Date.now()).slice(-6)}`,
        variantName: dto.variantName.trim(),
        colorName: 'Combo',
        sizeCode: 'COMBO',
        attributeAxis1Name: 'Gói Combo',
        attributeAxis1Value: 'Đa thành phần',
        attributeAxis2Name: 'Định mức',
        attributeAxis2Value: `${dto.components.length} SKU`,
        retailPrice: Number(dto.retailPrice),
        wholesalePrice: Number(dto.retailPrice) * 0.9,
        costPrice: totalCostPrice,
        maxDiscountPercent: Number(dto.maxDiscountPercent ?? 10),
        weightGrams: Math.max(200, totalWeightGrams),
        isBundleBom: true,
        bundleComponentsJson: dto.components,
        isActive: true,
      }),
    );

    for (const wh of warehouses) {
      await this.stockRepo.save(
        this.stockRepo.create({
          shopId,
          warehouseId: wh.id,
          variantId: bundleVariant.id,
          skuCode: bundleVariant.skuCode,
          onHandQty: 10,
          reservedQty: 0,
          availableQty: 10,
          inTransitQty: 0,
          defectiveHoldQty: 0,
          binLocationCode: 'BOM-VIRTUAL',
          lowStockThreshold: 2,
        }),
      );
    }

    return bundleVariant;
  }

  /**
   * Động cơ Tư vấn Thông số & Kích cỡ Động dựa trên Cấu hình Ngành hàng của Người bán (`recommendApparelSize`)
   * - Đọc trực tiếp `advisorFields` và `advisorRules` từ `ShopCatalogAndPosConfig.categories` (hoặc `sizeChartMetadataJson` của sản phẩm cụ thể).
   * - Đánh giá đồng thời các điều kiện khoảng số học (`numericRanges`: chiều cao, cân nặng, dài chân, tháng tuổi...) và điều kiện chọn lọc (`exactMatches`: loại da, mục tiêu, nhu cầu...).
   * - Tự động tìm và trả về danh sách các Biến thể SKU đang còn tồn khả dụng (`suggestedVariantsInStock`) khớp với kết quả tư vấn để Sale bấm 1 chạm thêm ngay vào giỏ POS!
   */
  public async recommendApparelSize(
    shopId: string,
    dto: RecommendSizeAdvisorDto,
  ): Promise<{
    recommendedSizeCode: string;
    confidenceScore: number;
    matchedRow: ProductSizeChartRowItem;
    adviceMessage: string;
    categoryName: string;
    suggestedVariantsInStock: SuggestedVariantAdvisorItem[];
  }> {
    const [{ variants }, catalogConfig] = await Promise.all([
      this.listCatalogVariantsWithMultiWarehouseStock({ shopId }),
      this.getShopCatalogAndPosConfig(shopId),
    ]);

    // 1. Hợp nhất các giá trị đầu vào động từ `dto.dynamicInputs` và các trường tương thích ngược
    const normalizedInputs: Record<string, string | number> = {
      ...(dto.dynamicInputs || {}),
    };
    if (dto.heightCm !== undefined && normalizedInputs.heightCm === undefined) {
      normalizedInputs.heightCm = Number(dto.heightCm);
    }
    if (dto.weightKg !== undefined && normalizedInputs.weightKg === undefined) {
      normalizedInputs.weightKg = Number(dto.weightKg);
    }
    if (dto.babyAgeMonths !== undefined && normalizedInputs.babyAgeMonths === undefined) {
      normalizedInputs.babyAgeMonths = Number(dto.babyAgeMonths);
    }
    if (dto.skinType !== undefined && normalizedInputs.skinType === undefined) {
      normalizedInputs.skinType = dto.skinType;
    }
    if (dto.usageNeed !== undefined && normalizedInputs.usageNeed === undefined) {
      normalizedInputs.usageNeed = dto.usageNeed;
    }

    // 2. Xác định Danh mục Ngành hàng do Người bán cấu hình
    let targetCategory: SellerCategoryBlueprintItem | undefined;
    if (dto.customCategoryId) {
      targetCategory = catalogConfig.categories.find(
        (c) => c.categoryId === dto.customCategoryId || c.code === dto.customCategoryId,
      );
    }
    if (!targetCategory && dto.productId) {
      const prod = await this.productRepo.findOne({
        where: { id: dto.productId, shopId },
      });
      if (prod) {
        targetCategory = catalogConfig.categories.find(
          (c) =>
            (prod.customCategoryId && c.categoryId === prod.customCategoryId) ||
            c.industryType === prod.industryType,
        );
      }
    }
    if (!targetCategory && dto.industryType) {
      targetCategory = catalogConfig.categories.find((c) => c.industryType === dto.industryType);
    }
    if (!targetCategory) {
      targetCategory =
        catalogConfig.categories.find((c) => c.isActive && c.enableAdvisorInPos) ||
        catalogConfig.categories[0];
    }

    const categoryName = targetCategory?.name || 'Danh mục sản phẩm';
    const rules = targetCategory?.advisorRules || [];

    let bestCode = 'Tiêu chuẩn';
    let bestNote = 'Phù hợp với thông số khách hàng cung cấp';
    let bestKeyword = '';
    let bestScore = -9999;

    if (rules.length > 0) {
      for (const rule of rules) {
        let score = 0;

        if (rule.exactMatches) {
          for (const [fieldKey, expectedVal] of Object.entries(rule.exactMatches)) {
            const actualVal = String(normalizedInputs[fieldKey] ?? '')
              .trim()
              .toUpperCase();
            if (actualVal && actualVal === String(expectedVal).trim().toUpperCase()) {
              score += 80;
            } else if (actualVal && actualVal.includes(String(expectedVal).trim().toUpperCase())) {
              score += 45;
            } else {
              score -= 30;
            }
          }
        }

        if (rule.numericRanges) {
          for (const [fieldKey, range] of Object.entries(rule.numericRanges)) {
            const numVal = Number(normalizedInputs[fieldKey]);
            if (!Number.isNaN(numVal) && numVal > 0) {
              const inRange = numVal >= range.min && numVal <= range.max;
              const mid = (range.min + range.max) / 2;
              const span = Math.max(1, range.max - range.min);
              const normalizedDistance = Math.abs(numVal - mid) / span;
              score += (inRange ? 60 : 0) - normalizedDistance * 25;
            }
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestCode = rule.recommendedResultCode;
          bestNote = rule.fitNote;
          bestKeyword = (rule.linkedSkuKeyword || rule.recommendedResultCode).toUpperCase();
        }
      }
    }

    // 3. Lọc ra các Biến thể SKU thực tế đang còn tồn khả dụng (`totalAvailableQty > 0`) khớp với kết quả tư vấn
    const candidatesInCategory = variants.filter((v) => {
      if (v.totalAvailableQty <= 0) return false;
      if (targetCategory) {
        return (
          v.customCategoryId === targetCategory.categoryId ||
          v.industryType === targetCategory.industryType ||
          (v.categoryName || '').toLowerCase() === targetCategory.name.toLowerCase()
        );
      }
      return true;
    });

    const cleanBestCode = bestCode
      .split(' ')[0]
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase();
    const matchedSkus = candidatesInCategory.filter((v) => {
      const skuUpper = v.skuCode.toUpperCase();
      const sizeUpper = (v.sizeCode || '').toUpperCase();
      const axis2Upper = (v.attributeAxis2Value || '').toUpperCase();
      if (bestKeyword && skuUpper.includes(bestKeyword)) return true;
      if (cleanBestCode && (sizeUpper === cleanBestCode || axis2Upper.includes(cleanBestCode))) {
        return true;
      }
      return false;
    });

    const suggestedVariantsInStock: SuggestedVariantAdvisorItem[] = (
      matchedSkus.length > 0 ? matchedSkus : candidatesInCategory
    )
      .slice(0, 4)
      .map((v) => ({
        variantId: v.id,
        skuCode: v.skuCode,
        variantName: v.variantName,
        retailPrice: Number(v.retailPrice),
        totalAvailableQty: v.totalAvailableQty,
        categoryName: v.categoryName,
      }));

    const inputSummaryParts = (targetCategory?.advisorFields || [])
      .map((f) => {
        const val = normalizedInputs[f.fieldKey];
        if (val === undefined || val === '') return null;
        if (f.fieldType === 'SELECT' && Array.isArray(f.options)) {
          const opt = f.options.find((o) => o.value === String(val));
          return `${f.label}: ${opt ? opt.label : val}`;
        }
        return `${f.label}: ${val}${f.unit ? f.unit : ''}`;
      })
      .filter(Boolean);

    const summaryPrefix =
      inputSummaryParts.length > 0
        ? `[${categoryName} • ${inputSummaryParts.join(' | ')}]`
        : `[${categoryName}]`;

    const matchedRow: ProductSizeChartRowItem = {
      sizeCode: bestCode,
      minHeightCm: Number(normalizedInputs.heightCm || 0),
      maxHeightCm: Number(normalizedInputs.heightCm || 0),
      minWeightKg: Number(normalizedInputs.weightKg || 0),
      maxWeightKg: Number(normalizedInputs.weightKg || 0),
      fitNote: bestNote,
    };

    return {
      recommendedSizeCode: bestCode,
      confidenceScore: 96,
      matchedRow,
      adviceMessage: `${summaryPrefix} Gợi ý chuẩn: ${bestCode} — ${bestNote}`,
      categoryName,
      suggestedVariantsInStock,
    };
  }
}
