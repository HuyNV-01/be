import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InventoryMovementTypeEnum, ProductSerialStatusEnum } from 'src/common/enum';
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
    maxWeightKg: 72,
    chestCm: 96,
    waistCm: 78,
    hipCm: 100,
    fitNote: 'Form thoải mái, che khuyết điểm vòng eo tốt',
  },
];

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
   * Khởi tạo bộ dữ liệu Danh mục Sản phẩm, Biến thể SKU, Sản phẩm Combo (`Bundle BOM`), Quà tặng kèm và Mã `Serial/IMEI` mẫu
   * ngay lần đầu mở cửa hàng để nhân viên Sale có thể thực hành `In-Chat POS` và `Counter POS` tức thì.
   */
  public async ensureSeededCatalogForShop(shopId: string): Promise<void> {
    const existingCount = await this.variantRepo.count({ where: { shopId } });
    if (existingCount > 0) return;

    const warehouses = await this.inventoryService.ensureDefaultWarehousesForShop(shopId);
    const hnWh = warehouses[0];
    const hcmWh = warehouses[1] || warehouses[0];

    // 1. Tạo Sản phẩm Thời trang có Ma trận Biến thể (Màu x Size)
    const dressProd = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: 'DAM-LUA-A12',
        name: 'Đầm Lụa Thiết Kế Dự Tiệc Cao Cấp A12',
        categoryName: 'Thời trang Nữ',
        brandName: 'Pancake Couture',
        unitName: 'Chiếc',
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
          skuCode: item.sku,
          barcode: `89385059701${i + 1}`,
          variantName: `${dressProd.name} - Màu ${item.color} - Size ${item.size}`,
          colorName: item.color,
          sizeCode: item.size,
          attributesJson: { color: item.color, size: item.size },
          retailPrice: item.price,
          wholesalePrice: item.price - 60000,
          costPrice: item.cost,
          maxDiscountPercent: 15,
          weightGrams: 350,
          isBundleBom: false,
          requiresSerialImei: false,
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

    // 2. Tạo Sản phẩm Phụ kiện & Quà tặng kèm 0đ (chỉ có tồn ở Kho TP.HCM để minh họa Tách đơn Đa kho)
    const bagProd = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: 'TUI-COI-B05',
        name: 'Túi Cói Đi Biển Thêu Hoa Vintage B05',
        categoryName: 'Phụ kiện & Túi xách',
        brandName: 'Pancake Chic',
        unitName: 'Chiếc',
        isActive: true,
      }),
    );

    const bagVariant = await this.variantRepo.save(
      this.variantRepo.create({
        shopId,
        productId: bagProd.id,
        skuCode: 'B05-BE-FREE',
        barcode: '893850597021',
        variantName: 'Túi Cói Đi Biển Thêu Hoa B05 - Màu Be (Freesize)',
        colorName: 'Be',
        sizeCode: 'FREESIZE',
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

    // 3. Tạo Sản phẩm Combo (`Bundle BOM` — F05.7): Gộp Đầm A12-KEM-M + Túi Cói B05-BE-FREE
    const bundleVariant = await this.variantRepo.save(
      this.variantRepo.create({
        shopId,
        productId: dressProd.id,
        skuCode: 'COMBO-A12-B05',
        barcode: '893850597099',
        variantName: 'Combo Dự Tiệc & Dạo Phố (Đầm Lụa A12 Kem Size M + Túi Cói B05)',
        colorName: 'Kem + Be',
        sizeCode: 'M',
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

    // 4. Tạo Sản phẩm Thiết bị Công nghệ quản lý theo Serial / IMEI (`F05.8`)
    const deviceProd = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: 'MAY-RUA-MAT-S9',
        name: 'Máy Rửa Mặt & Đẩy Tinh Chất Sóng Âm S9 Pro',
        categoryName: 'Thiết bị Làm đẹp & Công nghệ',
        brandName: 'Pancake BeautyTech',
        unitName: 'Máy',
        isActive: true,
      }),
    );

    const deviceVariant = await this.variantRepo.save(
      this.variantRepo.create({
        shopId,
        productId: deviceProd.id,
        skuCode: 'S9-PRO-ROSE',
        barcode: '893850597088',
        variantName: 'Máy Rửa Mặt Sóng Âm S9 Pro - Hồng Ngọc Trai (BH Điện tử 12T)',
        colorName: 'Hồng',
        sizeCode: 'STANDARD',
        retailPrice: 1290000,
        wholesalePrice: 990000,
        costPrice: 680000,
        maxDiscountPercent: 12,
        weightGrams: 420,
        isBundleBom: false,
        requiresSerialImei: true,
        warrantyMonths: 12,
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
  }

  /**
   * F05.1 & F05.2: Lấy toàn bộ Danh mục Biến thể SKU kèm Tồn kho 4 trạng thái tại từng Kho và tính toán động tồn khả dụng cho `Bundle BOM`
   */
  public async listCatalogVariantsWithMultiWarehouseStock(params: {
    shopId: string;
    search?: string;
    warehouseId?: string;
    bundleOnly?: boolean;
  }): Promise<{
    warehouses: WarehouseEntity[];
    variants: Array<
      ProductVariantEntity & {
        totalOnHandQty: number;
        totalReservedQty: number;
        totalAvailableQty: number;
        totalDefectiveHoldQty: number;
        stocksByWarehouse: Array<{
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
        }>;
      }
    >;
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

    const whMap = new Map<string, WarehouseEntity>();
    for (const w of warehouses) {
      whMap.set(w.id, w);
    }

    const stockByVariantAndWh = new Map<string, WarehouseStockItemEntity>();
    for (const st of allStocks) {
      stockByVariantAndWh.set(`${st.variantId}:${st.warehouseId}`, st);
    }

    const q = (params.search || '').trim().toLowerCase();

    const enriched = allVariants
      .filter((v) => {
        if (params.bundleOnly && !v.isBundleBom) return false;
        if (!q) return true;
        return (
          v.skuCode.toLowerCase().includes(q) ||
          v.barcode.toLowerCase().includes(q) ||
          v.variantName.toLowerCase().includes(q)
        );
      })
      .map((v) => {
        const stocksByWarehouse = warehouses.map((wh) => {
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

        return {
          ...v,
          retailPrice: Number(v.retailPrice || 0),
          wholesalePrice: Number(v.wholesalePrice || 0),
          costPrice: Number(v.costPrice || 0),
          totalOnHandQty,
          totalReservedQty,
          totalAvailableQty,
          totalDefectiveHoldQty,
          stocksByWarehouse,
        };
      });

    return {
      warehouses,
      variants: enriched,
    };
  }

  /**
   * F05.1: Khởi tạo Sản phẩm mới kèm Ma trận Biến thể Tự động (`Màu sắc x Kích cỡ`)
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

    const sizeChart =
      Array.isArray(dto.sizeChartMetadataJson) && dto.sizeChartMetadataJson.length > 0
        ? dto.sizeChartMetadataJson
        : DEFAULT_APPAREL_SIZE_CHART;

    const product = await this.productRepo.save(
      this.productRepo.create({
        shopId,
        code: cleanCode,
        name: dto.name.trim(),
        categoryName: dto.categoryName || 'Thời trang & Phụ kiện',
        brandName: dto.brandName || 'Pancake Brand',
        unitName: dto.unitName || 'Chiếc',
        thumbnailUrl: dto.thumbnailUrl || null,
        description: dto.description || null,
        sizeChartMetadataJson: sizeChart,
        freeGiftRulesJson: dto.freeGiftRulesJson || null,
        isActive: true,
      }),
    );

    const colors = Array.isArray(dto.colors) && dto.colors.length > 0 ? dto.colors : ['Tiêu chuẩn'];
    const sizes = Array.isArray(dto.sizes) && dto.sizes.length > 0 ? dto.sizes : ['FREESIZE'];
    const initQty = Math.max(0, Number(dto.initialOnHandQtyPerVariant ?? 25));

    const createdVariants: ProductVariantEntity[] = [];
    let seq = 1;

    for (const color of colors) {
      for (const size of sizes) {
        const colorSlug = this.stripDiacriticsCode(color).slice(0, 6);
        const sizeSlug = this.stripDiacriticsCode(size).slice(0, 6);
        const skuCode = `${cleanCode}-${colorSlug}-${sizeSlug}`;
        const barcode = `893${String(Date.now()).slice(-7)}${String(seq).padStart(2, '0')}`;
        seq += 1;

        const variant = await this.variantRepo.save(
          this.variantRepo.create({
            shopId,
            productId: product.id,
            skuCode,
            barcode,
            variantName: `${product.name} - ${color} - Size ${size}`,
            colorName: color,
            sizeCode: size.toUpperCase(),
            attributesJson: { color, size: size.toUpperCase() },
            retailPrice: Number(dto.retailPrice ?? 350000),
            wholesalePrice: Number(dto.wholesalePrice ?? 280000),
            costPrice: Number(dto.costPrice ?? 185000),
            maxDiscountPercent: Number(dto.maxDiscountPercent ?? 15),
            weightGrams: Number(dto.weightGrams ?? 300),
            isBundleBom: false,
            requiresSerialImei: Boolean(dto.requiresSerialImei),
            warrantyMonths: Number(dto.warrantyMonths ?? 0),
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
              note: `Khởi tạo tồn kho ban đầu cho biến thể [${variant.skuCode}]`,
              actorUserId,
            });
          }
        }
      }
    }

    return { product, createdVariants };
  }

  /**
   * F05.7: Tạo Sản phẩm Combo (`Bundle BOM`) định nghĩa định mức các SKU thành phần
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
        skuCode: cleanSku,
        barcode: `893BOM${String(Date.now()).slice(-6)}`,
        variantName: dto.variantName.trim(),
        colorName: 'Combo',
        sizeCode: 'COMBO',
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
   * F05.1: Công cụ Tư vấn Size tự động theo Chiều cao (`heightCm`) & Cân nặng (`weightKg`) của khách hàng
   */
  public async recommendApparelSize(
    shopId: string,
    dto: RecommendSizeAdvisorDto,
  ): Promise<{
    recommendedSizeCode: string;
    confidenceScore: number;
    matchedRow: ProductSizeChartRowItem;
    adviceMessage: string;
  }> {
    let chart = DEFAULT_APPAREL_SIZE_CHART;
    if (dto.productId) {
      const prod = await this.productRepo.findOne({
        where: { id: dto.productId, shopId },
      });
      if (prod?.sizeChartMetadataJson && prod.sizeChartMetadataJson.length > 0) {
        chart = prod.sizeChartMetadataJson;
      }
    }

    const h = Number(dto.heightCm);
    const w = Number(dto.weightKg);

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
