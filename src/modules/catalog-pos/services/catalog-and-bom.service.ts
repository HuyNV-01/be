import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InventoryMovementTypeEnum, ProductIndustryTypeEnum } from 'src/common/enum';
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

/**
 * Khi một Cửa hàng mới được tạo, danh mục ngành hàng khởi đầu hoàn toàn trống (`[]`).
 * Toàn bộ ngành hàng, trục thuộc tính biến thể, quy tắc tư vấn thông số và sản phẩm đều do Người bán chủ động khởi tạo.
 */
export function buildInitialSellerCategories(): SellerCategoryBlueprintItem[] {
  return [];
}

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
   * Lấy Cấu hình Ngành hàng Động, Tư vấn Thông số, Quà tặng kèm & Ngân hàng VietQR của Cửa hàng (`getShopCatalogAndPosConfig`).
   * Tuyệt đối không tự động tạo sẵn ngành hàng mẫu, quy tắc quà tặng mẫu hay tài khoản ngân hàng hardcode.
   * Mọi dữ liệu cấu hình đều khởi đầu ở trạng thái sạch (`[]` / `''`) để Người bán tự thiết lập theo thực tế kinh doanh.
   */
  public async getShopCatalogAndPosConfig(shopId: string): Promise<ShopCatalogAndPosConfig> {
    const shop = await this.shopRepo.findOne({ where: { id: shopId } });
    const existing = shop?.catalogAndPosConfigJson;

    if (existing) {
      return {
        categories: Array.isArray(existing.categories) ? existing.categories : [],
        freeGiftRules: Array.isArray(existing.freeGiftRules) ? existing.freeGiftRules : [],
        vietQrBankConfig: {
          bankBin: existing.vietQrBankConfig?.bankBin || '',
          bankShortName: existing.vietQrBankConfig?.bankShortName || '',
          accountNumber: existing.vietQrBankConfig?.accountNumber || '',
          accountName: existing.vietQrBankConfig?.accountName || '',
          transferPrefix: existing.vietQrBankConfig?.transferPrefix || '',
          autoConfirmWebhookEnabled: existing.vietQrBankConfig?.autoConfirmWebhookEnabled ?? true,
        },
        autoSeedDemoCatalogWhenEmpty: false,
        hasInitializedDefaultCatalog: true,
        updatedAt: existing.updatedAt || new Date().toISOString(),
      };
    }

    const emptyConfig: ShopCatalogAndPosConfig = {
      categories: [],
      freeGiftRules: [],
      vietQrBankConfig: {
        bankBin: '',
        bankShortName: '',
        accountNumber: '',
        accountName: '',
        transferPrefix: '',
        autoConfirmWebhookEnabled: true,
      },
      autoSeedDemoCatalogWhenEmpty: false,
      hasInitializedDefaultCatalog: true,
      updatedAt: new Date().toISOString(),
    };

    return emptyConfig;
  }

  /**
   * Cập nhật Cấu hình Tổng thể Danh mục Ngành hàng Động, Quy tắc Quà tặng kèm & Tài khoản Ngân hàng VietQR do Người bán thiết lập
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
      autoSeedDemoCatalogWhenEmpty: false,
      hasInitializedDefaultCatalog: true,
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
   * Người bán chủ động Thêm mới hoặc Cập nhật 1 Ngành hàng / Danh mục sản phẩm tùy chỉnh (`upsertSellerCategoryBlueprint`)
   */
  public async upsertSellerCategoryBlueprint(
    shopId: string,
    dto: UpsertSellerCategoryBlueprintDto,
  ): Promise<ShopCatalogAndPosConfig> {
    const config = await this.getShopCatalogAndPosConfig(shopId);
    const cleanCode = this.stripDiacriticsCode(dto.code || dto.name);
    if (!cleanCode) {
      throw new BadRequestException('CATEGORY_CODE_OR_NAME_REQUIRED');
    }
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
      iconEmoji: dto.iconEmoji ?? existingItem?.iconEmoji ?? '',
      industryType:
        dto.industryType ||
        existingItem?.industryType ||
        ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY,
      defaultUnitName: (dto.defaultUnitName || existingItem?.defaultUnitName || '').trim(),
      attributeAxis1Name: (dto.attributeAxis1Name || existingItem?.attributeAxis1Name || '').trim(),
      attributeAxis1SampleValues: Array.isArray(dto.attributeAxis1SampleValues)
        ? dto.attributeAxis1SampleValues.map((v) => v.trim()).filter(Boolean)
        : existingItem?.attributeAxis1SampleValues || [],
      attributeAxis2Name: (dto.attributeAxis2Name || existingItem?.attributeAxis2Name || '').trim(),
      attributeAxis2SampleValues: Array.isArray(dto.attributeAxis2SampleValues)
        ? dto.attributeAxis2SampleValues.map((v) => v.trim()).filter(Boolean)
        : existingItem?.attributeAxis2SampleValues || [],
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
        dto.defaultMaxDiscountPercent ?? existingItem?.defaultMaxDiscountPercent ?? 0,
      ),
      enableAdvisorInPos: dto.enableAdvisorInPos ?? existingItem?.enableAdvisorInPos ?? false,
      advisorTitle: (dto.advisorTitle || existingItem?.advisorTitle || '').trim(),
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
   * Người bán xóa một Ngành hàng / Danh mục tùy chỉnh khỏi cấu hình của Cửa hàng
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
    const actualWeight = Math.max(0, Number(params.weightGrams || 0));
    const l = Math.max(0, Number(params.lengthCm || 0));
    const w = Math.max(0, Number(params.widthCm || 0));
    const h = Math.max(0, Number(params.heightCm || 0));
    const volumetricWeightGrams = l > 0 && w > 0 && h > 0 ? Math.round((l * w * h) / 5) : 0;
    const chargeableWeightGrams = Math.max(actualWeight, volumetricWeightGrams);
    return { volumetricWeightGrams, chargeableWeightGrams };
  }

  /**
   * Phương thức giữ lại chữ ký hàm để tương thích ngược với Controller, nhưng hoàn toàn không tự động tạo bất kỳ ngành hàng,
   * sản phẩm hay kho hàng mẫu hardcode nào. Mọi dữ liệu sản phẩm và ngành hàng đều do Người bán chủ động khởi tạo.
   */
  public async ensureSeededCatalogForShop(_shopId: string, _forceSeed = false): Promise<void> {
    return;
  }

  /**
   * F05.1 & F05.2: Lấy toàn bộ Danh mục Biến thể SKU kèm Tồn kho 4 trạng thái tại từng Kho thực tế do Người bán tạo,
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
    const [warehouses, allVariants, allStocks, catalogConfig] = await Promise.all([
      this.inventoryService.listWarehousesForShop(params.shopId),
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
          (v.barcode || '').toLowerCase().includes(q) ||
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
              binLocationCode: '',
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
            binLocationCode: st?.binLocationCode || '',
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
   * F05.1: Người bán khởi tạo Sản phẩm mới kèm Ma trận Biến thể Tự động dựa trên Cấu hình Ngành hàng Động của Người bán (`SellerCategoryBlueprintItem`).
   * Tuyệt đối không gán giá bán/giá vốn/tồn kho/thương hiệu hardcode nếu Người bán không nhập.
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
      this.inventoryService.listWarehousesForShop(shopId),
      this.getShopCatalogAndPosConfig(shopId),
    ]);
    const defaultWh = warehouses.find((w) => w.isDefault) || warehouses[0] || null;

    const cleanCode = this.stripDiacriticsCode(dto.code);
    if (!cleanCode) {
      throw new BadRequestException('PRODUCT_CODE_REQUIRED');
    }
    const existingProd = await this.productRepo.findOne({
      where: { shopId, code: cleanCode },
    });
    if (existingProd) {
      throw new BadRequestException(`Mã sản phẩm [${cleanCode}] đã tồn tại trong cửa hàng.`);
    }

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

    const resolvedCategoryId = sellerCategory?.categoryId || dto.customCategoryId || null;
    const resolvedCategoryName = (dto.categoryName || sellerCategory?.name || '').trim();
    const resolvedUnitName = (dto.unitName || sellerCategory?.defaultUnitName || '').trim();

    const axis1Name = (dto.attributeAxis1Name || sellerCategory?.attributeAxis1Name || '').trim();
    const axis2Name = (dto.attributeAxis2Name || sellerCategory?.attributeAxis2Name || '').trim();

    const sizeChart =
      Array.isArray(dto.sizeChartMetadataJson) && dto.sizeChartMetadataJson.length > 0
        ? dto.sizeChartMetadataJson
        : null;

    const requiresSerialImei =
      dto.requiresSerialImei !== undefined
        ? dto.requiresSerialImei
        : Boolean(sellerCategory?.requiresSerialImei);
    const requiresBatchExpiry =
      dto.requiresBatchExpiry !== undefined
        ? dto.requiresBatchExpiry
        : Boolean(sellerCategory?.requiresBatchExpiry);

    const product = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: cleanCode,
        name: dto.name.trim(),
        customCategoryId: resolvedCategoryId,
        industryType,
        categoryName: resolvedCategoryName,
        brandName: dto.brandName?.trim() || null,
        unitName: resolvedUnitName,
        attributeAxis1Name: axis1Name,
        attributeAxis2Name: axis2Name,
        thumbnailUrl: dto.thumbnailUrl || null,
        description: dto.description || null,
        requiresBatchExpiry,
        shelfLifeMonths: Number(dto.shelfLifeMonths ?? sellerCategory?.defaultShelfLifeMonths ?? 0),
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
        ? dto.attributeAxis1Values.map((v) => v.trim()).filter(Boolean)
        : Array.isArray(dto.colors) && dto.colors.length > 0
          ? dto.colors.map((v) => v.trim()).filter(Boolean)
          : sellerCategory?.attributeAxis1SampleValues?.length
            ? sellerCategory.attributeAxis1SampleValues
            : [''];

    const rawAxis2List =
      Array.isArray(dto.attributeAxis2Values) && dto.attributeAxis2Values.length > 0
        ? dto.attributeAxis2Values.map((v) => v.trim()).filter(Boolean)
        : Array.isArray(dto.sizes) && dto.sizes.length > 0
          ? dto.sizes.map((v) => v.trim()).filter(Boolean)
          : sellerCategory?.attributeAxis2SampleValues?.length
            ? sellerCategory.attributeAxis2SampleValues
            : [''];

    const initQty = Math.max(0, Number(dto.initialOnHandQtyPerVariant ?? 0));

    const createdVariants: ProductVariantEntity[] = [];
    let seq = 1;

    for (const val1 of rawAxis1List) {
      for (const val2 of rawAxis2List) {
        const slug1 = this.stripDiacriticsCode(val1).slice(0, 8);
        const slug2 = this.stripDiacriticsCode(val2).slice(0, 8);
        const skuParts = [cleanCode, slug1, slug2].filter(Boolean);
        const skuCode =
          skuParts.length > 1
            ? skuParts.join('-')
            : seq === 1
              ? cleanCode
              : `${cleanCode}-${String(seq).padStart(2, '0')}`;
        const barcode = `893${String(Date.now()).slice(-7)}${String(seq).padStart(2, '0')}`;
        seq += 1;

        const variantLabelParts = [product.name];
        if (val1) {
          variantLabelParts.push(axis1Name ? `${axis1Name}: ${val1}` : val1);
        }
        if (val2) {
          variantLabelParts.push(axis2Name ? `${axis2Name}: ${val2}` : val2);
        }

        const attributesJson: Record<string, string> = {};
        if (axis1Name && val1) attributesJson[axis1Name] = val1;
        if (axis2Name && val2) attributesJson[axis2Name] = val2;

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
            colorName: val1 || null,
            sizeCode: val2 ? val2.toUpperCase() : null,
            attributeAxis1Name: axis1Name || null,
            attributeAxis1Value: val1 || null,
            attributeAxis2Name: axis2Name || null,
            attributeAxis2Value: val2 || null,
            attributesJson: Object.keys(attributesJson).length > 0 ? attributesJson : null,
            retailPrice: Math.max(0, Number(dto.retailPrice ?? 0)),
            wholesalePrice: Math.max(0, Number(dto.wholesalePrice ?? 0)),
            costPrice: Math.max(0, Number(dto.costPrice ?? 0)),
            maxDiscountPercent: Math.max(
              0,
              Number(dto.maxDiscountPercent ?? sellerCategory?.defaultMaxDiscountPercent ?? 0),
            ),
            weightGrams: Math.max(0, Number(dto.weightGrams ?? 0)),
            lengthCm: Math.max(0, Number(dto.lengthCm ?? 0)),
            widthCm: Math.max(0, Number(dto.widthCm ?? 0)),
            heightCm: Math.max(0, Number(dto.heightCm ?? 0)),
            isBundleBom: false,
            isFreeGiftItem: Boolean(dto.isFreeGiftItem),
            requiresSerialImei,
            warrantyMonths: Math.max(
              0,
              Number(dto.warrantyMonths ?? sellerCategory?.defaultWarrantyMonths ?? 0),
            ),
            requiresBatchExpiry,
            batchCode: dto.batchCode?.trim() || null,
            manufacturingDate: dto.manufacturingDate || null,
            expiryDate: dto.expiryDate || null,
            shelfLifeMonths: Math.max(
              0,
              Number(dto.shelfLifeMonths ?? sellerCategory?.defaultShelfLifeMonths ?? 0),
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
          const qtyForWh = defaultWh && wh.id === defaultWh.id ? initQty : 0;
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
              binLocationCode: '',
              lowStockThreshold: 0,
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
              referenceType: 'SELLER_PRODUCT_INIT',
              referenceId: product.code,
              note: `Người bán khởi tạo tồn kho ban đầu cho biến thể [${variant.skuCode}]`,
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
   * F05.7: Người bán tạo Sản phẩm Combo (`Bundle BOM`) định nghĩa định mức các SKU thành phần.
   * Tồn kho khả dụng của Combo được tính động 100% từ tồn kho thực tế của các SKU thành phần: min(floor(Avail_i / Qty_i)).
   */
  public async createBundleBomVariant(
    shopId: string,
    dto: CreateBundleBomVariantDto,
  ): Promise<ProductVariantEntity> {
    if (!Array.isArray(dto.components) || dto.components.length === 0) {
      throw new BadRequestException('BUNDLE_BOM_REQUIRES_AT_LEAST_ONE_COMPONENT');
    }

    const catalogConfig = await this.getShopCatalogAndPosConfig(shopId);
    const sellerCategory = dto.customCategoryId
      ? catalogConfig.categories.find((c) => c.categoryId === dto.customCategoryId) || null
      : null;

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
      totalWeightGrams += Number(compVar.weightGrams || 0) * Math.max(1, comp.requiredQty);
    }

    const cleanSku = this.stripDiacriticsCode(dto.skuCode) || dto.skuCode.trim().toUpperCase();
    const bundleParentProduct = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: cleanSku,
        name: dto.variantName.trim(),
        customCategoryId: dto.customCategoryId || null,
        industryType:
          dto.industryType ||
          sellerCategory?.industryType ||
          ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY,
        categoryName: sellerCategory?.name || '',
        brandName: null,
        unitName: sellerCategory?.defaultUnitName || '',
        isActive: true,
      }),
    );

    const bundleVariant = await this.variantRepo.save(
      this.variantRepo.create({
        shopId,
        productId: bundleParentProduct.id,
        customCategoryId: dto.customCategoryId || null,
        industryType:
          dto.industryType ||
          sellerCategory?.industryType ||
          ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY,
        categoryName: sellerCategory?.name || '',
        brandName: null,
        unitName: sellerCategory?.defaultUnitName || '',
        skuCode: cleanSku,
        barcode: `893BOM${String(Date.now()).slice(-6)}`,
        variantName: dto.variantName.trim(),
        colorName: null,
        sizeCode: null,
        attributeAxis1Name: null,
        attributeAxis1Value: null,
        attributeAxis2Name: null,
        attributeAxis2Value: null,
        retailPrice: Math.max(0, Number(dto.retailPrice || 0)),
        wholesalePrice: Math.max(0, Number(dto.retailPrice || 0)),
        costPrice: totalCostPrice,
        maxDiscountPercent: Math.max(0, Number(dto.maxDiscountPercent ?? 0)),
        weightGrams: totalWeightGrams,
        isBundleBom: true,
        bundleComponentsJson: dto.components,
        isActive: true,
      }),
    );

    return bundleVariant;
  }

  /**
   * Động cơ Tư vấn Thông số & Kích cỡ Động dựa trên Cấu hình Ngành hàng của Người bán (`recommendApparelSize`)
   * - Đọc trực tiếp `advisorFields` và `advisorRules` từ `ShopCatalogAndPosConfig.categories` do Người bán khởi tạo.
   * - Tự động tìm và trả về danh sách các Biến thể SKU thực tế của cửa hàng đang còn tồn khả dụng (`suggestedVariantsInStock`).
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

    const categoryName = targetCategory?.name || '';
    const rules = targetCategory?.advisorRules || [];

    let bestCode = '';
    let bestNote = '';
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
      categoryName && inputSummaryParts.length > 0
        ? `[${categoryName} • ${inputSummaryParts.join(' | ')}]`
        : categoryName
          ? `[${categoryName}]`
          : '';

    const matchedRow: ProductSizeChartRowItem = {
      sizeCode: bestCode,
      minHeightCm: Number(normalizedInputs.heightCm || 0),
      maxHeightCm: Number(normalizedInputs.heightCm || 0),
      minWeightKg: Number(normalizedInputs.weightKg || 0),
      maxWeightKg: Number(normalizedInputs.weightKg || 0),
      fitNote: bestNote,
    };

    const adviceMessage = bestCode
      ? `${summaryPrefix ? `${summaryPrefix} ` : ''}Gợi ý: ${bestCode}${bestNote ? ` — ${bestNote}` : ''}`
      : 'Chưa có quy tắc tư vấn cho ngành hàng này. Người bán có thể thêm quy tắc trong phần Cấu hình Ngành hàng.';

    return {
      recommendedSizeCode: bestCode,
      confidenceScore: bestCode ? 96 : 0,
      matchedRow,
      adviceMessage,
      categoryName,
      suggestedVariantsInStock,
    };
  }
}
