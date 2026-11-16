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
} from 'src/dto/catalog-pos/catalog-pos.dto';
import { ProductSerialItemEntity } from 'src/entity/product-serial-item.entity';
import { ProductVariantEntity } from 'src/entity/product-variant.entity';
import { ProductEntity, ProductSizeChartRowItem } from 'src/entity/product.entity';
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
   * Tính trọng lượng quy đổi thể tích chuẩn hãng vận chuyển 3PL (`(Dài x Rộng x Cao) / 5` tính ra gram)
   * giúp các shop bán đồ gia dụng, bỉm sữa, thùng thực phẩm cồng kềnh tính đúng phí vận chuyển GHN/GHTK/VTP/J&T.
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
    // Theo chuẩn GHN/GHTK: Trọng lượng quy đổi (kg) = (D x R x C) / 5000 => Quy ra gram = (D x R x C) / 5
    const volumetricWeightGrams = Math.round((l * w * h) / 5);
    const chargeableWeightGrams = Math.max(actualWeight, volumetricWeightGrams);
    return { volumetricWeightGrams, chargeableWeightGrams };
  }

  /**
   * Khởi tạo bộ dữ liệu Danh mục Sản phẩm Đa Ngành Hàng (Thời trang, Phụ kiện, Combo BOM, Thiết bị Công nghệ Serial/IMEI,
   * Mỹ phẩm có Lô/Hạn sử dụng FEFO và Thực phẩm dinh dưỡng F&B) để người bán trải nghiệm đầy đủ mọi nghiệp vụ.
   */
  public async ensureSeededCatalogForShop(shopId: string): Promise<void> {
    const existingCount = await this.variantRepo.count({ where: { shopId } });
    if (existingCount > 0) return;

    const warehouses = await this.inventoryService.ensureDefaultWarehousesForShop(shopId);
    const hnWh = warehouses[0];
    const hcmWh = warehouses[1] || warehouses[0];

    // 1. Ngành Thời trang (`FASHION_APPAREL`): Đầm Lụa có Ma trận Biến thể (Màu x Size)
    const dressProd = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: 'DAM-LUA-A12',
        name: 'Đầm Lụa Thiết Kế Dự Tiệc Cao Cấp A12',
        industryType: ProductIndustryTypeEnum.FASHION_APPAREL,
        categoryName: 'Thời trang Nữ',
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

    // 2. Ngành Phụ kiện & Quà tặng kèm (`FASHION_APPAREL`)
    const bagProd = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: 'TUI-COI-B05',
        name: 'Túi Cói Đi Biển Thêu Hoa Vintage B05',
        industryType: ProductIndustryTypeEnum.FASHION_APPAREL,
        categoryName: 'Phụ kiện & Túi xách',
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

    // 4. Ngành Điện tử & Thiết bị Công nghệ quản lý theo Serial / IMEI (`ELECTRONICS_TECH` — F05.8)
    const deviceProd = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: 'MAY-RUA-MAT-S9',
        name: 'Máy Rửa Mặt & Đẩy Tinh Chất Sóng Âm S9 Pro',
        industryType: ProductIndustryTypeEnum.ELECTRONICS_TECH,
        categoryName: 'Thiết bị Làm đẹp & Công nghệ',
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

    // 5. Ngành Mỹ phẩm & Chăm sóc da quản lý Lô & Hạn sử dụng FEFO (`COSMETICS_BEAUTY`)
    const serumProd = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: 'SERUM-B5-HYDRA',
        name: 'Tinh Chất Phục Hồi Cấp Ẩm Chuyên Sâu Vitamin B5 + HA',
        industryType: ProductIndustryTypeEnum.COSMETICS_BEAUTY,
        categoryName: 'Mỹ phẩm & Chăm sóc da',
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

    // 6. Ngành Thực phẩm & Đồ uống (`FOOD_BEVERAGE`) có Quy đổi Đơn vị tính & Hạn sử dụng
    const foodProd = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: 'GRANOLA-MATCHA-01',
        name: 'Ngũ Cốc Hạt Dinh Dưỡng Nướng Mật Ong & Matcha Uji Nhật Bản',
        industryType: ProductIndustryTypeEnum.FOOD_BEVERAGE,
        categoryName: 'Thực phẩm Dinh dưỡng & Healthy F&B',
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
  }

  /**
   * F05.1 & F05.2: Lấy toàn bộ Danh mục Biến thể SKU Đa Ngành Hàng kèm Tồn kho 4 trạng thái tại từng Kho,
   * tính toán động tồn khả dụng cho `Bundle BOM`, cảnh báo cận hạn FEFO và bảo toàn đầy đủ phương thức của `ProductVariantEntity`.
   */
  public async listCatalogVariantsWithMultiWarehouseStock(params: {
    shopId: string;
    search?: string;
    warehouseId?: string;
    bundleOnly?: boolean;
    industryType?: ProductIndustryTypeEnum;
  }): Promise<{
    warehouses: WarehouseEntity[];
    variants: EnrichedCatalogVariantItem[];
  }> {
    await this.ensureSeededCatalogForShop(params.shopId);

    const [warehouses, allVariants, allStocks] = await Promise.all([
      this.inventoryService.ensureDefaultWarehousesForShop(params.shopId),
      this.variantRepo.find({
        where: { shopId: params.shopId, isActive: true },
        order: { createdAt: 'DESC' },
      }),
      this.stockRepo.find({ where: { shopId: params.shopId } }),
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
          // Nếu là sản phẩm Combo (`Bundle BOM`), tồn khả dụng tại kho được tính động từ các SKU con
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

        // Sử dụng Object.assign trên thực thể `v` để bảo toàn đầy đủ các phương thức của BaseEntity (`hasId`, `save`, `remove`, `softRemove`, `recover`, `reload`)
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
    };
  }

  /**
   * F05.1: Khởi tạo Sản phẩm mới kèm Ma trận Biến thể Tự động Đa Ngành Hàng
   * Hỗ trợ linh hoạt 2 trục thuộc tính tùy biến (`attributeAxis1Name` x `attributeAxis2Name`),
   * tự động thiết lập cờ `requiresSerialImei` (Điện tử) hoặc `requiresBatchExpiry` (Mỹ phẩm, Thực phẩm, Mẹ & Bé).
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
    const warehouses = await this.inventoryService.ensureDefaultWarehousesForShop(shopId);
    const defaultWh = warehouses.find((w) => w.isDefault) || warehouses[0];

    const cleanCode = this.stripDiacriticsCode(dto.code);
    const existingProd = await this.productRepo.findOne({
      where: { shopId, code: cleanCode },
    });
    if (existingProd) {
      throw new BadRequestException(`Mã sản phẩm [${cleanCode}] đã tồn tại trong cửa hàng.`);
    }

    const industryType = dto.industryType || ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY;
    const blueprint =
      INDUSTRY_ATTRIBUTE_BLUEPRINTS[industryType] ||
      INDUSTRY_ATTRIBUTE_BLUEPRINTS[ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY];

    const axis1Name = (dto.attributeAxis1Name || blueprint.axis1Name).trim();
    const axis2Name = (dto.attributeAxis2Name || blueprint.axis2Name).trim();

    const defaultChart =
      industryType === ProductIndustryTypeEnum.MOTHER_AND_BABY
        ? DEFAULT_BABY_DIAPER_SIZE_CHART
        : DEFAULT_APPAREL_SIZE_CHART;

    const sizeChart =
      Array.isArray(dto.sizeChartMetadataJson) && dto.sizeChartMetadataJson.length > 0
        ? dto.sizeChartMetadataJson
        : defaultChart;

    const requiresSerialImei =
      dto.requiresSerialImei !== undefined ? dto.requiresSerialImei : blueprint.requiresSerialImei;
    const requiresBatchExpiry =
      dto.requiresBatchExpiry !== undefined
        ? dto.requiresBatchExpiry
        : blueprint.requiresBatchExpiry;

    const product = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: cleanCode,
        name: dto.name.trim(),
        industryType,
        categoryName: dto.categoryName || blueprint.defaultCategoryName,
        brandName: dto.brandName || 'Pancake Brand',
        unitName: dto.unitName || blueprint.defaultUnitName,
        attributeAxis1Name: axis1Name,
        attributeAxis2Name: axis2Name,
        thumbnailUrl: dto.thumbnailUrl || null,
        description: dto.description || null,
        requiresBatchExpiry,
        shelfLifeMonths: Number(dto.shelfLifeMonths ?? (requiresBatchExpiry ? 24 : 0)),
        storageCondition: dto.storageCondition || null,
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
          : ['Tiêu chuẩn'];

    const rawAxis2List =
      Array.isArray(dto.attributeAxis2Values) && dto.attributeAxis2Values.length > 0
        ? dto.attributeAxis2Values
        : Array.isArray(dto.sizes) && dto.sizes.length > 0
          ? dto.sizes
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
            maxDiscountPercent: Number(dto.maxDiscountPercent ?? 15),
            weightGrams: Number(dto.weightGrams ?? 300),
            lengthCm: Number(dto.lengthCm ?? 20),
            widthCm: Number(dto.widthCm ?? 15),
            heightCm: Number(dto.heightCm ?? 5),
            isBundleBom: false,
            requiresSerialImei,
            warrantyMonths: Number(dto.warrantyMonths ?? (requiresSerialImei ? 12 : 0)),
            requiresBatchExpiry,
            batchCode:
              dto.batchCode || (requiresBatchExpiry ? `LOT-${cleanCode.slice(0, 6)}` : null),
            manufacturingDate: dto.manufacturingDate || null,
            expiryDate: dto.expiryDate || null,
            shelfLifeMonths: Number(dto.shelfLifeMonths ?? (requiresBatchExpiry ? 24 : 0)),
            storageCondition: dto.storageCondition || null,
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

  public async recommendApparelSize(
    shopId: string,
    dto: RecommendSizeAdvisorDto,
  ): Promise<{
    recommendedSizeCode: string;
    confidenceScore: number;
    matchedRow: ProductSizeChartRowItem;
    adviceMessage: string;
  }> {
    let industryType = dto.industryType || ProductIndustryTypeEnum.FASHION_APPAREL;
    let chart = DEFAULT_APPAREL_SIZE_CHART;

    if (dto.productId) {
      const prod = await this.productRepo.findOne({
        where: { id: dto.productId, shopId },
      });
      if (prod) {
        industryType = prod.industryType || industryType;
        if (prod.sizeChartMetadataJson && prod.sizeChartMetadataJson.length > 0) {
          chart = prod.sizeChartMetadataJson;
        }
      }
    }

    // 1. Tư vấn cho ngành Mỹ phẩm & Chăm sóc da
    if (industryType === ProductIndustryTypeEnum.COSMETICS_BEAUTY || dto.skinType) {
      const skin = (dto.skinType || 'COMBINATION').toUpperCase();
      const skinMap: Record<string, { code: string; note: string }> = {
        OILY: {
          code: 'Bản Kiềm Dầu BHA 2% / Gel 50ml',
          note: 'Da dầu/hỗn hợp thiên dầu nên ưu tiên kết cấu mỏng nhẹ thấm nhanh (Serum B5 + HA hoặc Gel 50ml).',
        },
        DRY: {
          code: 'Bản Cấp Ẩm Sâu Vitamin B5 + Ceramide 50ml',
          note: 'Da khô bong tróc cần phục hồi màng ẩm chuyên sâu với Vitamin B5 + HA dung tích 50ml.',
        },
        SENSITIVE: {
          code: 'Bản Dịu Nhẹ Phục Hồi B5 (Không Cồn/Hương Liệu)',
          note: 'Da nhạy cảm/kích ứng phù hợp nhất với Tinh chất B5 + HA lành tính, test thử size 30ml hoặc 50ml.',
        },
        COMBINATION: {
          code: 'Bản Cân Bằng Ẩm B5 + Niacinamide 50ml',
          note: 'Da hỗn hợp phù hợp dùng Tinh chất B5 cấp ẩm vùng chữ U và kiềm dầu vùng chữ T.',
        },
      };
      const picked = skinMap[skin] || skinMap.COMBINATION;
      const syntheticRow: ProductSizeChartRowItem = {
        sizeCode: picked.code,
        minHeightCm: 0,
        maxHeightCm: 0,
        minWeightKg: 0,
        maxWeightKg: 0,
        skinTypeRecommendation: skin,
        fitNote: picked.note,
      };
      return {
        recommendedSizeCode: picked.code,
        confidenceScore: 95,
        matchedRow: syntheticRow,
        adviceMessage: `Tư vấn Mỹ phẩm (Loại da: ${skin}): Khuyên dùng [${picked.code}] — ${picked.note}`,
      };
    }

    // 2. Tư vấn cho ngành Mẹ & Bé (Bỉm, Sữa, Quần áo sơ sinh)
    if (
      industryType === ProductIndustryTypeEnum.MOTHER_AND_BABY ||
      (dto.babyAgeMonths !== undefined && Number(dto.weightKg || 0) <= 25)
    ) {
      const babyChart = DEFAULT_BABY_DIAPER_SIZE_CHART;
      const w = Number(dto.weightKg || 7);
      const ageM = Number(dto.babyAgeMonths ?? 6);
      let bestRow = babyChart[2];
      let bestScore = -999;

      for (const row of babyChart) {
        const wMatch = w >= row.minWeightKg && w <= row.maxWeightKg;
        const ageMatch =
          row.minAgeMonths !== undefined &&
          row.maxAgeMonths !== undefined &&
          ageM >= row.minAgeMonths &&
          ageM <= row.maxAgeMonths;
        const midW = (row.minWeightKg + row.maxWeightKg) / 2;
        const score = (wMatch ? 60 : 0) + (ageMatch ? 30 : 0) - Math.abs(w - midW) * 4;
        if (score > bestScore) {
          bestScore = score;
          bestRow = row;
        }
      }

      return {
        recommendedSizeCode: bestRow.sizeCode,
        confidenceScore: 97,
        matchedRow: bestRow,
        adviceMessage: `Tư vấn Mẹ & Bé (Bé ${w}kg • ${ageM} tháng tuổi): Chuẩn đẹp Size ${bestRow.sizeCode} — ${bestRow.fitNote}.`,
      };
    }

    // 3. Tư vấn cho ngành Điện tử / Gia dụng / Thực phẩm theo nhu cầu
    if (
      industryType === ProductIndustryTypeEnum.ELECTRONICS_TECH ||
      industryType === ProductIndustryTypeEnum.FOOD_BEVERAGE ||
      industryType === ProductIndustryTypeEnum.HOME_LIVING_APPLIANCES
    ) {
      const needText = (dto.usageNeed || 'Sử dụng gia đình / Tiêu chuẩn').trim();
      const recCode =
        industryType === ProductIndustryTypeEnum.ELECTRONICS_TECH
          ? 'Bản Pro (Bảo hành Điện tử 12 Tháng)'
          : industryType === ProductIndustryTypeEnum.FOOD_BEVERAGE
            ? 'Combo 2 Hộp 500g (Tiết kiệm 15%)'
            : 'Phiên bản Tiêu chuẩn Gia đình';
      const syntheticRow: ProductSizeChartRowItem = {
        sizeCode: recCode,
        minHeightCm: 0,
        maxHeightCm: 0,
        minWeightKg: 0,
        maxWeightKg: 0,
        fitNote: `Phù hợp nhu cầu: ${needText}`,
      };
      return {
        recommendedSizeCode: recCode,
        confidenceScore: 94,
        matchedRow: syntheticRow,
        adviceMessage: `Gợi ý cấu hình / quy cách cho nhu cầu "${needText}": Nên chọn [${recCode}] để tối ưu chi phí và hiệu năng sử dụng.`,
      };
    }

    // 4. Tư vấn cho ngành Thời trang & Giày dép theo Chiều cao (cm) & Cân nặng (kg)
    const h = Number(dto.heightCm || 160);
    const w = Number(dto.weightKg || 52);

    let bestMatch = chart[0];
    let bestScore = -999;

    for (const row of chart) {
      const hInRange = h >= row.minHeightCm && h <= row.maxHeightCm;
      const wInRange = w >= row.minWeightKg && w <= row.maxWeightKg;
      const midH = (row.minHeightCm + row.maxHeightCm) / 2;
      const midW = (row.minWeightKg + row.maxWeightKg) / 2;
      const distancePenalty = Math.abs(h - midH) * 0.8 + Math.abs(w - midW) * 1.8;
      const bonus = (hInRange ? 30 : 0) + (wInRange ? 50 : 0);
      const score = bonus - distancePenalty;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = row;
      }
    }

    return {
      recommendedSizeCode: bestMatch.sizeCode,
      confidenceScore: 96,
      matchedRow: bestMatch,
      adviceMessage: `Với chiều cao ${h}cm và cân nặng ${w}kg, khách mặc chuẩn đẹp Size ${bestMatch.sizeCode} (${bestMatch.fitNote || 'Form chuẩn'}).`,
    };
  }
}
