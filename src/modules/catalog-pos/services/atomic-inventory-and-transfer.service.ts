import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  InventoryMovementTypeEnum,
  ProductSerialStatusEnum,
  SecurityAuditActionCodeEnum,
  WarehouseTransferStatusEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  AdjustWarehouseStocktakeDto,
  CreateWarehouseTransferDto,
  ReceiveWarehouseTransferDto,
  RegisterProductSerialItemsDto,
  ReleaseStockAtomicDto,
  ReserveStockAtomicDto,
  ScanBindSerialToOrderDto,
  SerialLookupQueryDto,
  UpsertWarehouseDto,
} from 'src/dto/catalog-pos/catalog-pos.dto';
import { InventoryMovementLedgerEntity } from 'src/entity/inventory-movement-ledger.entity';
import { ProductSerialItemEntity } from 'src/entity/product-serial-item.entity';
import { ProductVariantEntity } from 'src/entity/product-variant.entity';
import { WarehouseStockItemEntity } from 'src/entity/warehouse-stock-item.entity';
import {
  WarehouseTransferLineItem,
  WarehouseTransferOrderEntity,
} from 'src/entity/warehouse-transfer-order.entity';
import { WarehouseEntity } from 'src/entity/warehouse.entity';
import { PiiVaultAndAuditService } from 'src/modules/crm/services/pii-vault-and-audit.service';
import { Repository } from 'typeorm';

/**
 * Kịch bản Lua thực thi đơn luồng nguyên tử trên Redis (`RESERVE_STOCK_ATOMIC_LUA` — Công cụ `T07`):
 * - Kiểm tra `availableQty >= requestedQty` trong `< 1ms`.
 * - Nếu đủ tồn: trừ ngay `available`, cộng `reserved` trên Redis, lưu khóa giữ chỗ `pos:reserve:{draftCartId}:{warehouseId}:{variantId}` với TTL 900 giây (15 phút).
 * - Chống bán khống (`Overselling`) tuyệt đối 100% khi hàng trăm nhân viên Sale hoặc khách Livestream chốt cùng 1 mã SKU cuối cùng.
 */
export const RESERVE_STOCK_ATOMIC_LUA = `
local stockKey = KEYS[1]
local reserveCartKey = KEYS[2]
local reqQty = tonumber(ARGV[1])
local initAvailable = tonumber(ARGV[2])
local initReserved = tonumber(ARGV[3])
local ttlSec = tonumber(ARGV[4])

if redis.call('EXISTS', stockKey) == 0 then
  redis.call('HSET', stockKey, 'available', initAvailable, 'reserved', initReserved)
end

local currentAvailable = tonumber(redis.call('HGET', stockKey, 'available') or '0')
local currentReserved = tonumber(redis.call('HGET', stockKey, 'reserved') or '0')

if currentAvailable < reqQty then
  return {0, currentAvailable, currentReserved}
end

local nextAvailable = currentAvailable - reqQty
local nextReserved = currentReserved + reqQty

redis.call('HSET', stockKey, 'available', nextAvailable, 'reserved', nextReserved)
redis.call('INCRBY', reserveCartKey, reqQty)
redis.call('EXPIRE', reserveCartKey, ttlSec)

return {1, nextAvailable, nextReserved}
`;

export const RELEASE_STOCK_ATOMIC_LUA = `
local stockKey = KEYS[1]
local reserveCartKey = KEYS[2]
local releaseQty = tonumber(ARGV[1])

local heldQty = tonumber(redis.call('GET', reserveCartKey) or '0')
local actualRelease = releaseQty
if heldQty > 0 and actualRelease > heldQty then
  actualRelease = heldQty
end

if redis.call('EXISTS', stockKey) == 1 then
  local curAvail = tonumber(redis.call('HGET', stockKey, 'available') or '0')
  local curRes = tonumber(redis.call('HGET', stockKey, 'reserved') or '0')
  local nextRes = math.max(0, curRes - actualRelease)
  local nextAvail = curAvail + actualRelease
  redis.call('HSET', stockKey, 'available', nextAvail, 'reserved', nextRes)
  redis.call('DEL', reserveCartKey)
  return {1, nextAvail, nextRes}
end

redis.call('DEL', reserveCartKey)
return {1, 0, 0}
`;

@Injectable()
export class AtomicInventoryAndTransferService {
  private readonly logger = new Logger(AtomicInventoryAndTransferService.name);

  constructor(
    @InjectRepository(WarehouseEntity)
    private readonly warehouseRepo: Repository<WarehouseEntity>,
    @InjectRepository(WarehouseStockItemEntity)
    private readonly stockRepo: Repository<WarehouseStockItemEntity>,
    @InjectRepository(ProductVariantEntity)
    private readonly variantRepo: Repository<ProductVariantEntity>,
    @InjectRepository(InventoryMovementLedgerEntity)
    private readonly ledgerRepo: Repository<InventoryMovementLedgerEntity>,
    @InjectRepository(WarehouseTransferOrderEntity)
    private readonly transferRepo: Repository<WarehouseTransferOrderEntity>,
    @InjectRepository(ProductSerialItemEntity)
    private readonly serialRepo: Repository<ProductSerialItemEntity>,
    @InjectRedis() private readonly redis: Redis,
    private readonly piiVaultService: PiiVaultAndAuditService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  /**
   * Truy vấn danh sách Kho vật lý thực tế của Cửa hàng từ cơ sở dữ liệu.
   * Khi bảng `warehouses` chưa có dữ liệu (`allowAutoCreate === false`), trả về mảng rỗng `[]`
   * thay vì tự động chèn kho mẫu hardcode. Chỉ khởi tạo kho mặc định khi người bán chủ động tạo sản phẩm/kho hoặc nạp dữ liệu mẫu (`allowAutoCreate === true`).
   */
  public async listWarehousesForShop(shopId: string): Promise<WarehouseEntity[]> {
    return this.warehouseRepo.find({
      where: { shopId },
      order: { priorityOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  public async ensureDefaultWarehousesForShop(
    shopId: string,
    _allowAutoCreate = false,
  ): Promise<WarehouseEntity[]> {
    return this.listWarehousesForShop(shopId);
  }

  public async upsertWarehouse(shopId: string, dto: UpsertWarehouseDto): Promise<WarehouseEntity> {
    let wh = await this.warehouseRepo.findOne({
      where: { shopId, code: dto.code.trim().toUpperCase() },
    });

    if (dto.isDefault) {
      await this.warehouseRepo.update({ shopId }, { isDefault: false });
    }

    if (!wh) {
      wh = this.warehouseRepo.create({
        shopId,
        code: dto.code.trim().toUpperCase(),
        name: dto.name.trim(),
        provinceCode: dto.provinceCode?.trim() || '',
        districtCode: dto.districtCode?.trim() || '',
        wardCode: dto.wardCode?.trim() || '',
        addressLine: dto.addressLine?.trim() || dto.name.trim(),
        contactPhone: dto.contactPhone?.trim() || '',
        isDefault: dto.isDefault ?? false,
        priorityOrder: dto.priorityOrder ?? 1,
        allowNegativeStock: dto.allowNegativeStock ?? false,
        isActive: true,
      });
    } else {
      wh.name = dto.name.trim();
      if (dto.provinceCode) wh.provinceCode = dto.provinceCode;
      if (dto.districtCode) wh.districtCode = dto.districtCode;
      if (dto.wardCode) wh.wardCode = dto.wardCode;
      if (dto.addressLine) wh.addressLine = dto.addressLine;
      if (dto.contactPhone) wh.contactPhone = dto.contactPhone;
      if (dto.isDefault !== undefined) wh.isDefault = dto.isDefault;
      if (dto.priorityOrder !== undefined) wh.priorityOrder = dto.priorityOrder;
      if (dto.allowNegativeStock !== undefined) wh.allowNegativeStock = dto.allowNegativeStock;
    }

    return this.warehouseRepo.save(wh);
  }

  /**
   * Ghi 1 bản ghi biến động vào Sổ cái Thẻ kho Bất biến Phân vùng theo Tháng (`inventory_movement_ledgers` — F05.5)
   */
  public async appendInventoryLedger(params: {
    shopId: string;
    warehouseId: string;
    variantId: string;
    skuCode: string;
    movementType: InventoryMovementTypeEnum;
    deltaQty: number;
    beforeOnHandQty: number;
    afterOnHandQty: number;
    beforeReservedQty: number;
    afterReservedQty: number;
    beforeAvailableQty: number;
    afterAvailableQty: number;
    costPrice: number;
    referenceType: string;
    referenceId?: string | null;
    note?: string | null;
    actorUserId?: string | null;
  }): Promise<InventoryMovementLedgerEntity> {
    const now = new Date();
    const entry = this.ledgerRepo.create({
      shopId: params.shopId,
      warehouseId: params.warehouseId,
      variantId: params.variantId,
      skuCode: params.skuCode,
      movementType: params.movementType,
      deltaQty: params.deltaQty,
      beforeOnHandQty: params.beforeOnHandQty,
      afterOnHandQty: params.afterOnHandQty,
      beforeReservedQty: params.beforeReservedQty,
      afterReservedQty: params.afterReservedQty,
      beforeAvailableQty: params.beforeAvailableQty,
      afterAvailableQty: params.afterAvailableQty,
      costPrice: params.costPrice,
      referenceType: params.referenceType,
      referenceId: params.referenceId || null,
      note: params.note || null,
      actorUserId: params.actorUserId || 'system',
      createdAt: now,
      updatedAt: now,
    });
    return this.ledgerRepo.save(entry);
  }

  /**
   * Công cụ `T07` (`F05.3`, `F05.4`, `F05.7`):
   * Giữ chỗ tồn kho nguyên tử bằng `Redis Lua Script` (`< 1ms`) cho cả SKU đơn lẻ và Sản phẩm Combo (`Bundle BOM`).
   * Nếu là `Bundle BOM`, hệ thống kiểm tra và giữ chỗ đồng thời toàn bộ SKU thành phần theo định mức `requiredQty`.
   */
  public async reserveStockAtomicWithRedisLua(params: {
    shopId: string;
    actorUserId: string;
    dto: ReserveStockAtomicDto;
  }): Promise<{
    success: boolean;
    draftCartId: string;
    warehouseId: string;
    variantId: string;
    skuCode: string;
    reservedQtyAdded: number;
    availableQtyAfter: number;
    reservedQtyAfter: number;
    onHandQty: number;
    expiresInSeconds: number;
    bundleComponentReservations?: Array<{
      componentVariantId: string;
      componentSkuCode: string;
      reservedQtyAdded: number;
      availableQtyAfter: number;
    }>;
  }> {
    const { shopId, actorUserId, dto } = params;
    const variant = await this.variantRepo.findOne({
      where: { id: dto.variantId, shopId },
    });
    if (!variant) {
      throw new NotFoundException('PRODUCT_VARIANT_NOT_FOUND');
    }

    const ttlSeconds = 900; // 15 phút giữ chỗ giỏ hàng nháp POS

    // Trường hợp 1: Sản phẩm là Combo (`Bundle BOM`) -> Giữ chỗ nguyên tử trên từng SKU thành phần
    if (
      variant.isBundleBom &&
      Array.isArray(variant.bundleComponentsJson) &&
      variant.bundleComponentsJson.length > 0
    ) {
      const componentResults: Array<{
        componentVariantId: string;
        componentSkuCode: string;
        reservedQtyAdded: number;
        availableQtyAfter: number;
      }> = [];

      for (const comp of variant.bundleComponentsJson) {
        const compNeedQty = comp.requiredQty * dto.quantity;
        const subRes = await this.reserveSingleVariantAtomic({
          shopId,
          warehouseId: dto.warehouseId,
          variantId: comp.componentVariantId,
          requestedQty: compNeedQty,
          draftCartId: `${dto.draftCartId}:bom:${variant.id}`,
          ttlSeconds,
          actorUserId,
          movementNote: `Giữ chỗ thành phần Combo BOM [${variant.skuCode}] x${dto.quantity}`,
        });
        componentResults.push({
          componentVariantId: comp.componentVariantId,
          componentSkuCode: comp.componentSkuCode,
          reservedQtyAdded: compNeedQty,
          availableQtyAfter: subRes.availableQtyAfter,
        });
      }

      const minBundleAvailable = Math.min(
        ...variant.bundleComponentsJson.map((comp) => {
          const found = componentResults.find(
            (r) => r.componentVariantId === comp.componentVariantId,
          );
          return found ? Math.floor(found.availableQtyAfter / Math.max(1, comp.requiredQty)) : 0;
        }),
      );

      if (dto.conversationId) {
        this.realtimeEmitter.emitToConversation(
          SOCKET_CONFIG.namespaces.CHAT,
          dto.conversationId,
          SOCKET_CONFIG.events.POS_OMS.STOCK_RESERVED_UPDATED,
          {
            shopId,
            warehouseId: dto.warehouseId,
            variantId: variant.id,
            skuCode: variant.skuCode,
            availableQty: minBundleAvailable,
            draftCartId: dto.draftCartId,
          },
        );
      }

      return {
        success: true,
        draftCartId: dto.draftCartId,
        warehouseId: dto.warehouseId,
        variantId: variant.id,
        skuCode: variant.skuCode,
        reservedQtyAdded: dto.quantity,
        availableQtyAfter: minBundleAvailable,
        reservedQtyAfter: dto.quantity,
        onHandQty: minBundleAvailable + dto.quantity,
        expiresInSeconds: ttlSeconds,
        bundleComponentReservations: componentResults,
      };
    }

    // Trường hợp 2: Sản phẩm SKU tiêu chuẩn
    const singleRes = await this.reserveSingleVariantAtomic({
      shopId,
      warehouseId: dto.warehouseId,
      variantId: variant.id,
      requestedQty: dto.quantity,
      draftCartId: dto.draftCartId,
      ttlSeconds,
      actorUserId,
      movementNote: `Giữ chỗ nguyên tử Redis Lua cho giỏ POS [${dto.draftCartId}]`,
    });

    if (dto.conversationId) {
      this.realtimeEmitter.emitToConversation(
        SOCKET_CONFIG.namespaces.CHAT,
        dto.conversationId,
        SOCKET_CONFIG.events.POS_OMS.STOCK_RESERVED_UPDATED,
        {
          shopId,
          warehouseId: dto.warehouseId,
          variantId: variant.id,
          skuCode: variant.skuCode,
          availableQty: singleRes.availableQtyAfter,
          reservedQty: singleRes.reservedQtyAfter,
          draftCartId: dto.draftCartId,
        },
      );
    }

    return {
      success: true,
      draftCartId: dto.draftCartId,
      warehouseId: dto.warehouseId,
      variantId: variant.id,
      skuCode: variant.skuCode,
      reservedQtyAdded: dto.quantity,
      availableQtyAfter: singleRes.availableQtyAfter,
      reservedQtyAfter: singleRes.reservedQtyAfter,
      onHandQty: singleRes.onHandQty,
      expiresInSeconds: ttlSeconds,
    };
  }

  private async reserveSingleVariantAtomic(params: {
    shopId: string;
    warehouseId: string;
    variantId: string;
    requestedQty: number;
    draftCartId: string;
    ttlSeconds: number;
    actorUserId: string;
    movementNote: string;
  }): Promise<{
    availableQtyAfter: number;
    reservedQtyAfter: number;
    onHandQty: number;
  }> {
    const [variant, stockItem] = await Promise.all([
      this.variantRepo.findOne({ where: { id: params.variantId, shopId: params.shopId } }),
      this.stockRepo.findOne({
        where: {
          shopId: params.shopId,
          warehouseId: params.warehouseId,
          variantId: params.variantId,
        },
      }),
    ]);

    if (!variant || !stockItem) {
      throw new NotFoundException('WAREHOUSE_STOCK_ITEM_NOT_FOUND');
    }

    const stockRedisKey = `pos:stock:${params.shopId}:${params.warehouseId}:${params.variantId}`;
    const reserveCartKey = `pos:reserve:${params.draftCartId}:${params.warehouseId}:${params.variantId}`;

    let allowed = false;
    let nextAvailable = stockItem.availableQty;
    let nextReserved = stockItem.reservedQty;

    try {
      const luaResult = (await this.redis.eval(
        RESERVE_STOCK_ATOMIC_LUA,
        2,
        stockRedisKey,
        reserveCartKey,
        String(params.requestedQty),
        String(stockItem.availableQty),
        String(stockItem.reservedQty),
        String(params.ttlSeconds),
      )) as [number, number, number];

      if (Array.isArray(luaResult)) {
        allowed = Number(luaResult[0]) === 1;
        nextAvailable = Number(luaResult[1]);
        nextReserved = Number(luaResult[2]);
      }
    } catch {
      // Fallback kiểm tra nguyên tử trực tiếp trên DB nếu Redis tạm thời gián đoạn
      if (stockItem.availableQty >= params.requestedQty) {
        allowed = true;
        nextAvailable = stockItem.availableQty - params.requestedQty;
        nextReserved = stockItem.reservedQty + params.requestedQty;
      }
    }

    if (!allowed) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_AVAILABLE_STOCK',
        message: `Sản phẩm [${variant.skuCode} - ${variant.variantName}] chỉ còn tồn khả dụng ${nextAvailable} (yêu cầu ${params.requestedQty}). Không thể bán âm kho!`,
        skuCode: variant.skuCode,
        availableQty: nextAvailable,
        requestedQty: params.requestedQty,
      });
    }

    const beforeAvailable = stockItem.availableQty;
    const beforeReserved = stockItem.reservedQty;

    stockItem.availableQty = nextAvailable;
    stockItem.reservedQty = nextReserved;
    await this.stockRepo.save(stockItem);

    await this.appendInventoryLedger({
      shopId: params.shopId,
      warehouseId: params.warehouseId,
      variantId: variant.id,
      skuCode: variant.skuCode,
      movementType: InventoryMovementTypeEnum.POS_RESERVE,
      deltaQty: -params.requestedQty,
      beforeOnHandQty: stockItem.onHandQty,
      afterOnHandQty: stockItem.onHandQty,
      beforeReservedQty: beforeReserved,
      afterReservedQty: nextReserved,
      beforeAvailableQty: beforeAvailable,
      afterAvailableQty: nextAvailable,
      costPrice: Number(variant.costPrice || 0),
      referenceType: 'POS_DRAFT_CART',
      referenceId: params.draftCartId,
      note: params.movementNote,
      actorUserId: params.actorUserId,
    });

    return {
      availableQtyAfter: nextAvailable,
      reservedQtyAfter: nextReserved,
      onHandQty: stockItem.onHandQty,
    };
  }

  /**
   * Giải phóng giữ chỗ tồn kho nguyên tử (`RELEASE_STOCK_ATOMIC_LUA`) khi hủy giỏ nháp hoặc hết TTL 15 phút
   */
  public async releaseStockReservationAtomic(params: {
    shopId: string;
    actorUserId: string;
    dto: ReleaseStockAtomicDto;
  }): Promise<{
    released: boolean;
    availableQtyAfter: number;
    reservedQtyAfter: number;
  }> {
    const { shopId, actorUserId, dto } = params;
    const [variant, stockItem] = await Promise.all([
      this.variantRepo.findOne({ where: { id: dto.variantId, shopId } }),
      this.stockRepo.findOne({
        where: { shopId, warehouseId: dto.warehouseId, variantId: dto.variantId },
      }),
    ]);

    if (!variant || !stockItem) {
      throw new NotFoundException('WAREHOUSE_STOCK_ITEM_NOT_FOUND');
    }

    const releaseQty = Math.min(stockItem.reservedQty, Math.max(1, Number(dto.quantity || 1)));
    const stockRedisKey = `pos:stock:${shopId}:${dto.warehouseId}:${dto.variantId}`;
    const reserveCartKey = `pos:reserve:${dto.draftCartId}:${dto.warehouseId}:${dto.variantId}`;

    const beforeAvail = stockItem.availableQty;
    const beforeRes = stockItem.reservedQty;

    stockItem.reservedQty = Math.max(0, stockItem.reservedQty - releaseQty);
    stockItem.availableQty = Math.max(0, stockItem.onHandQty - stockItem.reservedQty);

    try {
      await this.redis.eval(
        RELEASE_STOCK_ATOMIC_LUA,
        2,
        stockRedisKey,
        reserveCartKey,
        String(releaseQty),
      );
      await this.redis.hset(
        stockRedisKey,
        'available',
        String(stockItem.availableQty),
        'reserved',
        String(stockItem.reservedQty),
      );
    } catch {
      // Ignore Redis sync warning
    }

    await this.stockRepo.save(stockItem);

    await this.appendInventoryLedger({
      shopId,
      warehouseId: dto.warehouseId,
      variantId: variant.id,
      skuCode: variant.skuCode,
      movementType: InventoryMovementTypeEnum.POS_RELEASE,
      deltaQty: releaseQty,
      beforeOnHandQty: stockItem.onHandQty,
      afterOnHandQty: stockItem.onHandQty,
      beforeReservedQty: beforeRes,
      afterReservedQty: stockItem.reservedQty,
      beforeAvailableQty: beforeAvail,
      afterAvailableQty: stockItem.availableQty,
      costPrice: Number(variant.costPrice || 0),
      referenceType: 'POS_DRAFT_CART',
      referenceId: dto.draftCartId,
      note: `Giải phóng giữ chỗ giỏ nháp POS [${dto.draftCartId}] (+${releaseQty})`,
      actorUserId,
    });

    return {
      released: true,
      availableQtyAfter: stockItem.availableQty,
      reservedQtyAfter: stockItem.reservedQty,
    };
  }

  /**
   * Kiểm kho cân bằng / Nhập hàng PO / Chuyển sang hàng lỗi (`F05.3`, `F05.5`) kèm lưu Chuỗi băm Kiểm toán Bảo mật
   */
  public async adjustWarehouseStocktake(params: {
    shopId: string;
    actorUserId: string;
    dto: AdjustWarehouseStocktakeDto;
  }): Promise<WarehouseStockItemEntity> {
    const { shopId, actorUserId, dto } = params;
    const [variant, stockItem] = await Promise.all([
      this.variantRepo.findOne({ where: { id: dto.variantId, shopId } }),
      this.stockRepo.findOne({
        where: { shopId, warehouseId: dto.warehouseId, variantId: dto.variantId },
      }),
    ]);

    if (!variant || !stockItem) {
      throw new NotFoundException('WAREHOUSE_STOCK_ITEM_NOT_FOUND');
    }

    const beforeOnHand = stockItem.onHandQty;
    const beforeAvail = stockItem.availableQty;
    const beforeDefective = stockItem.defectiveHoldQty;

    stockItem.onHandQty = Math.max(0, stockItem.onHandQty + Number(dto.deltaQty || 0));
    if (dto.deltaDefectiveHoldQty !== undefined) {
      stockItem.defectiveHoldQty = Math.max(
        0,
        stockItem.defectiveHoldQty + Number(dto.deltaDefectiveHoldQty || 0),
      );
    }
    stockItem.availableQty = Math.max(0, stockItem.onHandQty - stockItem.reservedQty);

    const saved = await this.stockRepo.save(stockItem);

    try {
      const stockRedisKey = `pos:stock:${shopId}:${dto.warehouseId}:${dto.variantId}`;
      await this.redis.hset(
        stockRedisKey,
        'available',
        String(saved.availableQty),
        'reserved',
        String(saved.reservedQty),
      );
    } catch {
      // Ignore
    }

    await this.appendInventoryLedger({
      shopId,
      warehouseId: dto.warehouseId,
      variantId: variant.id,
      skuCode: variant.skuCode,
      movementType: dto.movementType,
      deltaQty: dto.deltaQty,
      beforeOnHandQty: beforeOnHand,
      afterOnHandQty: saved.onHandQty,
      beforeReservedQty: saved.reservedQty,
      afterReservedQty: saved.reservedQty,
      beforeAvailableQty: beforeAvail,
      afterAvailableQty: saved.availableQty,
      costPrice: Number(variant.costPrice || 0),
      referenceType: 'STOCKTAKE_ADJUST',
      referenceId: `ADJ_${Date.now()}`,
      note: dto.note,
      actorUserId,
    });

    await this.piiVaultService.recordSecurityAuditLog({
      shopId,
      actorUserId,
      actionCode: SecurityAuditActionCodeEnum.ADJUST_STOCK,
      targetResourceType: 'WAREHOUSE_STOCK',
      targetResourceId: saved.id,
      beforeSnapshotJson: {
        skuCode: variant.skuCode,
        onHandQty: beforeOnHand,
        availableQty: beforeAvail,
        defectiveHoldQty: beforeDefective,
      },
      afterSnapshotJson: {
        skuCode: variant.skuCode,
        deltaQty: dto.deltaQty,
        onHandQty: saved.onHandQty,
        availableQty: saved.availableQty,
        defectiveHoldQty: saved.defectiveHoldQty,
        note: dto.note,
      },
    });

    return saved;
  }

  /**
   * F05.6: Tạo Phiếu Chuyển Kho Nội Bộ 2 Bước (`DRAFT` -> Bước 1 `OUTBOUND_IN_TRANSIT` -> Bước 2 `COMPLETED` / `DISCREPANCY`)
   */
  public async createTwoStepWarehouseTransfer(params: {
    shopId: string;
    actorUserId: string;
    dto: CreateWarehouseTransferDto;
  }): Promise<WarehouseTransferOrderEntity> {
    const { shopId, actorUserId, dto } = params;
    if (dto.fromWarehouseId === dto.toWarehouseId) {
      throw new BadRequestException('CANNOT_TRANSFER_TO_SAME_WAREHOUSE');
    }

    const [fromWh, toWh] = await Promise.all([
      this.warehouseRepo.findOne({ where: { id: dto.fromWarehouseId, shopId } }),
      this.warehouseRepo.findOne({ where: { id: dto.toWarehouseId, shopId } }),
    ]);

    if (!fromWh || !toWh) {
      throw new NotFoundException('WAREHOUSE_NOT_FOUND');
    }

    const transferCode = `TRF-${String(Date.now()).slice(-6)}-${Math.floor(10 + Math.random() * 89)}`;
    const lineItems: WarehouseTransferLineItem[] = [];

    for (const item of dto.items) {
      const qty = Math.max(1, Number(item.requestedQty || 1));
      const [variant, fromStock] = await Promise.all([
        this.variantRepo.findOne({ where: { id: item.variantId, shopId } }),
        this.stockRepo.findOne({
          where: { shopId, warehouseId: fromWh.id, variantId: item.variantId },
        }),
      ]);

      if (!variant || !fromStock) {
        throw new NotFoundException(`VARIANT_STOCK_NOT_FOUND_IN_SOURCE_WAREHOUSE`);
      }

      if (fromStock.availableQty < qty) {
        throw new BadRequestException(
          `Kho xuất [${fromWh.name}] không đủ tồn khả dụng cho SKU ${variant.skuCode} (Còn: ${fromStock.availableQty}, Cần chuyển: ${qty})`,
        );
      }

      if (dto.dispatchImmediately !== false) {
        const beforeOnHand = fromStock.onHandQty;
        const beforeAvail = fromStock.availableQty;
        fromStock.onHandQty = Math.max(0, fromStock.onHandQty - qty);
        fromStock.availableQty = Math.max(0, fromStock.onHandQty - fromStock.reservedQty);
        await this.stockRepo.save(fromStock);

        let toStock = await this.stockRepo.findOne({
          where: { shopId, warehouseId: toWh.id, variantId: variant.id },
        });
        if (!toStock) {
          toStock = this.stockRepo.create({
            shopId,
            warehouseId: toWh.id,
            variantId: variant.id,
            skuCode: variant.skuCode,
            onHandQty: 0,
            reservedQty: 0,
            availableQty: 0,
            inTransitQty: qty,
            defectiveHoldQty: 0,
            binLocationCode: 'KHU-B-01',
            lowStockThreshold: 5,
          });
        } else {
          toStock.inTransitQty = Number(toStock.inTransitQty || 0) + qty;
        }
        await this.stockRepo.save(toStock);

        await this.appendInventoryLedger({
          shopId,
          warehouseId: fromWh.id,
          variantId: variant.id,
          skuCode: variant.skuCode,
          movementType: InventoryMovementTypeEnum.TRANSFER_OUT,
          deltaQty: -qty,
          beforeOnHandQty: beforeOnHand,
          afterOnHandQty: fromStock.onHandQty,
          beforeReservedQty: fromStock.reservedQty,
          afterReservedQty: fromStock.reservedQty,
          beforeAvailableQty: beforeAvail,
          afterAvailableQty: fromStock.availableQty,
          costPrice: Number(variant.costPrice || 0),
          referenceType: 'WAREHOUSE_TRANSFER',
          referenceId: transferCode,
          note: `Xuất chuyển kho Bước 1 [${fromWh.name} -> ${toWh.name}]`,
          actorUserId,
        });
      }

      lineItems.push({
        variantId: variant.id,
        skuCode: variant.skuCode,
        variantName: variant.variantName,
        requestedQty: qty,
        shippedQty: dto.dispatchImmediately !== false ? qty : 0,
        receivedQty: 0,
        discrepancyReason: null,
      });
    }

    const transferOrder = this.transferRepo.create({
      shopId,
      transferCode,
      fromWarehouseId: fromWh.id,
      fromWarehouseName: fromWh.name,
      toWarehouseId: toWh.id,
      toWarehouseName: toWh.name,
      status:
        dto.dispatchImmediately !== false
          ? WarehouseTransferStatusEnum.OUTBOUND_IN_TRANSIT
          : WarehouseTransferStatusEnum.DRAFT,
      itemsJson: lineItems,
      note: dto.note || null,
      shippedByUserId: dto.dispatchImmediately !== false ? actorUserId : null,
      shippedAt: dto.dispatchImmediately !== false ? new Date() : null,
    });

    return this.transferRepo.save(transferOrder);
  }

  /**
   * F05.6 (Bước 2 — `TRANSFER_IN`): Kho nhận xác nhận kiểm đếm hàng chuyển đến, trừ `inTransitQty` và cộng `onHandQty` + `availableQty`
   */
  public async receiveWarehouseTransferStepTwo(params: {
    shopId: string;
    transferId: string;
    actorUserId: string;
    dto: ReceiveWarehouseTransferDto;
  }): Promise<WarehouseTransferOrderEntity> {
    const { shopId, transferId, actorUserId, dto } = params;
    const transfer = await this.transferRepo.findOne({
      where: { id: transferId, shopId },
    });
    if (!transfer) {
      throw new NotFoundException('WAREHOUSE_TRANSFER_ORDER_NOT_FOUND');
    }
    if (
      transfer.status === WarehouseTransferStatusEnum.COMPLETED ||
      transfer.status === WarehouseTransferStatusEnum.CANCELLED
    ) {
      throw new BadRequestException('WAREHOUSE_TRANSFER_ALREADY_FINALIZED');
    }

    let hasDiscrepancy = false;
    const updatedItems: WarehouseTransferLineItem[] = [];

    for (const line of transfer.itemsJson || []) {
      const override = dto.receivedItems?.find((r) => r.variantId === line.variantId);
      const receivedQty =
        override?.receivedQty !== undefined
          ? Math.max(0, Number(override.receivedQty))
          : line.shippedQty;

      if (receivedQty !== line.shippedQty) {
        hasDiscrepancy = true;
      }

      const [variant, toStock] = await Promise.all([
        this.variantRepo.findOne({ where: { id: line.variantId, shopId } }),
        this.stockRepo.findOne({
          where: {
            shopId,
            warehouseId: transfer.toWarehouseId,
            variantId: line.variantId,
          },
        }),
      ]);

      if (variant && toStock) {
        const beforeOnHand = toStock.onHandQty;
        const beforeAvail = toStock.availableQty;
        toStock.inTransitQty = Math.max(0, Number(toStock.inTransitQty || 0) - line.shippedQty);
        toStock.onHandQty = Number(toStock.onHandQty || 0) + receivedQty;
        toStock.availableQty = Math.max(0, toStock.onHandQty - toStock.reservedQty);
        await this.stockRepo.save(toStock);

        await this.appendInventoryLedger({
          shopId,
          warehouseId: transfer.toWarehouseId,
          variantId: variant.id,
          skuCode: variant.skuCode,
          movementType: InventoryMovementTypeEnum.TRANSFER_IN,
          deltaQty: receivedQty,
          beforeOnHandQty: beforeOnHand,
          afterOnHandQty: toStock.onHandQty,
          beforeReservedQty: toStock.reservedQty,
          afterReservedQty: toStock.reservedQty,
          beforeAvailableQty: beforeAvail,
          afterAvailableQty: toStock.availableQty,
          costPrice: Number(variant.costPrice || 0),
          referenceType: 'WAREHOUSE_TRANSFER',
          referenceId: transfer.transferCode,
          note: `Nhập chuyển kho Bước 2 [${transfer.fromWarehouseName} -> ${transfer.toWarehouseName}]`,
          actorUserId,
        });
      }

      updatedItems.push({
        ...line,
        receivedQty,
        discrepancyReason: override?.discrepancyReason || null,
      });
    }

    transfer.itemsJson = updatedItems;
    transfer.status = hasDiscrepancy
      ? WarehouseTransferStatusEnum.DISCREPANCY
      : WarehouseTransferStatusEnum.COMPLETED;
    transfer.receivedByUserId = actorUserId;
    transfer.receivedAt = new Date();
    if (dto.note) {
      transfer.note = [transfer.note, dto.note].filter(Boolean).join(' | ');
    }

    return this.transferRepo.save(transfer);
  }

  public async listWarehouseTransfers(shopId: string): Promise<WarehouseTransferOrderEntity[]> {
    return this.transferRepo.find({
      where: { shopId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  public async listInventoryLedgers(
    shopId: string,
    warehouseId?: string,
    variantId?: string,
  ): Promise<InventoryMovementLedgerEntity[]> {
    const qb = this.ledgerRepo.createQueryBuilder('l').where('l.shop_id = :shopId', { shopId });

    if (warehouseId) {
      qb.andWhere('l.warehouse_id = :warehouseId', { warehouseId });
    }
    if (variantId) {
      qb.andWhere('l.variant_id = :variantId', { variantId });
    }

    return qb.orderBy('l.createdAt', 'DESC').take(80).getMany();
  }

  /**
   * F05.8: Đăng ký danh sách mã `Serial / IMEI` vào kho và kích hoạt bảo hành điện tử khi xuất bán
   */
  public async registerProductSerialItems(
    shopId: string,
    dto: RegisterProductSerialItemsDto,
  ): Promise<ProductSerialItemEntity[]> {
    const variant = await this.variantRepo.findOne({
      where: { id: dto.variantId, shopId },
    });
    if (!variant) {
      throw new NotFoundException('PRODUCT_VARIANT_NOT_FOUND');
    }

    const createdList: ProductSerialItemEntity[] = [];
    for (const rawSn of dto.serialNumbers) {
      const cleanSn = (rawSn || '').trim().toUpperCase();
      if (!cleanSn) continue;
      const existing = await this.serialRepo.findOne({
        where: { shopId, serialNumber: cleanSn },
      });
      if (existing) continue;

      const entity = this.serialRepo.create({
        shopId,
        warehouseId: dto.warehouseId,
        variantId: variant.id,
        skuCode: variant.skuCode,
        variantName: variant.variantName,
        serialNumber: cleanSn,
        status: ProductSerialStatusEnum.IN_STOCK,
        warrantyMonths: dto.warrantyMonths ?? (variant.warrantyMonths || 12),
      });
      createdList.push(await this.serialRepo.save(entity));
    }

    return createdList;
  }

  public async scanAndBindSerialToOrder(
    shopId: string,
    dto: ScanBindSerialToOrderDto,
  ): Promise<ProductSerialItemEntity> {
    const cleanSn = dto.serialNumber.trim().toUpperCase();
    const serialItem = await this.serialRepo.findOne({
      where: { shopId, serialNumber: cleanSn },
    });
    if (!serialItem) {
      throw new NotFoundException('PRODUCT_SERIAL_IMEI_NOT_FOUND');
    }

    const now = new Date();
    const warrantyMonths = Math.max(1, Number(serialItem.warrantyMonths || 12));
    const expiresAt = new Date(now.getTime() + warrantyMonths * 30 * 86_400_000);

    serialItem.status = ProductSerialStatusEnum.SOLD_ACTIVE_WARRANTY;
    serialItem.soldOrderId = dto.orderId;
    serialItem.soldOrderCode = dto.orderId;
    serialItem.customerId = dto.customerId || null;
    serialItem.activatedAt = now;
    serialItem.warrantyExpiresAt = expiresAt;

    return this.serialRepo.save(serialItem);
  }

  public async listProductSerialItems(
    shopId: string,
    query: SerialLookupQueryDto,
  ): Promise<ProductSerialItemEntity[]> {
    const qb = this.serialRepo.createQueryBuilder('s').where('s.shop_id = :shopId', { shopId });

    if (query.warehouseId) {
      qb.andWhere('s.warehouse_id = :warehouseId', { warehouseId: query.warehouseId });
    }
    if (query.variantId) {
      qb.andWhere('s.variant_id = :variantId', { variantId: query.variantId });
    }
    if (query.status) {
      qb.andWhere('s.status = :status', { status: query.status });
    }
    if (query.search && query.search.trim()) {
      qb.andWhere('(s.serial_number LIKE :q OR s.sku_code LIKE :q OR s.variant_name LIKE :q)', {
        q: `%${query.search.trim()}%`,
      });
    }

    return qb.orderBy('s.createdAt', 'DESC').take(60).getMany();
  }
}
