import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  InventoryMovementTypeEnum,
  PosOrderStatusEnum,
  SecurityAuditActionCodeEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  CreateHandoverManifestDto,
  GenerateWavePicklistDto,
  ScanOrderIntoHandoverDto,
  ScheduleOrderCallLaterDto,
  SealHandoverManifestDto,
  SettlePartialDeliveryDto,
  UpdateOrderTagsAndSubStatusDto,
} from 'src/dto/oms/pos-fulfillment-ops.dto';
import {
  CarrierHandoverManifestEntity,
  CarrierHandoverManifestStatusEnum,
  HandoverManifestScannedOrderItem,
} from 'src/entity/carrier-handover-manifest.entity';
import {
  PosOrderEntity,
  PosOrderPartialDeliveryInfo,
  PosOrderPartialDeliveryLineItem,
} from 'src/entity/pos-order.entity';
import { WarehouseStockItemEntity } from 'src/entity/warehouse-stock-item.entity';
import { WarehouseEntity } from 'src/entity/warehouse.entity';
import { AtomicInventoryAndTransferService } from 'src/modules/catalog-pos/services/atomic-inventory-and-transfer.service';
import { PiiVaultAndAuditService } from 'src/modules/crm/services/pii-vault-and-audit.service';
import { In, IsNull, Not, Repository } from 'typeorm';

import { OmsStateMachineService } from './oms-state-machine.service';

export interface WavePicklistSkuLine {
  variantId: string;
  skuCode: string;
  barcode: string;
  variantName: string;
  imageUrl: string | null;
  warehouseId: string;
  warehouseName: string;
  binLocationCode: string;
  totalPickQty: number;
  currentOnHandQty: number;
  currentAvailableQty: number;
  isShortageRisk: boolean;
  orderCodes: string[];
}

export interface WavePicklistResult {
  picklistCode: string;
  generatedAtIso: string;
  totalOrdersCount: number;
  totalUniqueSkusCount: number;
  totalUnitsToPick: number;
  shortageSkuCount: number;
  orderIds: string[];
  items: WavePicklistSkuLine[];
  printableHtmlTemplate: string;
}

@Injectable()
export class PosFulfillmentOpsService {
  constructor(
    @InjectRepository(PosOrderEntity)
    private readonly orderRepo: Repository<PosOrderEntity>,
    @InjectRepository(CarrierHandoverManifestEntity)
    private readonly manifestRepo: Repository<CarrierHandoverManifestEntity>,
    @InjectRepository(WarehouseEntity)
    private readonly warehouseRepo: Repository<WarehouseEntity>,
    @InjectRepository(WarehouseStockItemEntity)
    private readonly stockRepo: Repository<WarehouseStockItemEntity>,
    private readonly omsStateMachine: OmsStateMachineService,
    private readonly inventoryService: AtomicInventoryAndTransferService,
    private readonly piiAuditService: PiiVaultAndAuditService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  public async generateConsolidatedWavePicklist(params: {
    shopId: string;
    dto: GenerateWavePicklistDto;
  }): Promise<WavePicklistResult> {
    const orders = await this.orderRepo.find({
      where: {
        shopId: params.shopId,
        id: In(params.dto.orderIds),
      },
      order: { createdAt: 'ASC' },
    });

    if (orders.length === 0) {
      throw new NotFoundException('Không tìm thấy đơn hàng nào để gom phiếu nhặt hàng');
    }

    const eligibleOrders = orders.filter((order) => {
      if (params.dto.warehouseId && order.warehouseId !== params.dto.warehouseId) {
        return false;
      }
      return [
        PosOrderStatusEnum.CONFIRMED,
        PosOrderStatusEnum.WAITING_PACKING,
        PosOrderStatusEnum.PACKED_READY_TO_SHIP,
      ].includes(order.status);
    });

    if (eligibleOrders.length === 0) {
      throw new BadRequestException(
        'Các đơn đã chọn không nằm ở trạng thái chờ nhặt hàng / đóng gói',
      );
    }

    const skuBuckets = new Map<
      string,
      {
        variantId: string;
        skuCode: string;
        barcode: string;
        variantName: string;
        imageUrl: string | null;
        warehouseId: string;
        warehouseName: string;
        totalPickQty: number;
        orderCodes: Set<string>;
      }
    >();

    const variantIds = new Set<string>();
    const warehouseIds = new Set<string>();

    for (const order of eligibleOrders) {
      warehouseIds.add(order.warehouseId);
      for (const item of order.itemsJson || []) {
        const key = `${item.warehouseId || order.warehouseId}::${item.variantId}`;
        variantIds.add(item.variantId);
        warehouseIds.add(item.warehouseId || order.warehouseId);

        const existing = skuBuckets.get(key);
        if (existing) {
          existing.totalPickQty += Number(item.quantity || 0);
          existing.orderCodes.add(order.orderCode);
        } else {
          skuBuckets.set(key, {
            variantId: item.variantId,
            skuCode: item.skuCode,
            barcode: item.barcode,
            variantName: item.variantName,
            imageUrl: item.imageUrl || null,
            warehouseId: item.warehouseId || order.warehouseId,
            warehouseName: item.warehouseName || order.warehouseName,
            totalPickQty: Number(item.quantity || 0),
            orderCodes: new Set([order.orderCode]),
          });
        }
      }
    }

    const stockRows = await this.stockRepo.find({
      where: {
        shopId: params.shopId,
        warehouseId: In(Array.from(warehouseIds)),
        variantId: In(Array.from(variantIds)),
      },
    });
    const stockMap = new Map<string, WarehouseStockItemEntity>();
    for (const row of stockRows) {
      stockMap.set(`${row.warehouseId}::${row.variantId}`, row);
    }

    const items: WavePicklistSkuLine[] = Array.from(skuBuckets.entries())
      .map(([key, bucket]) => {
        const stock = stockMap.get(key);
        const onHand = Number(stock?.onHandQty || 0);
        const available = Number(stock?.availableQty || 0);
        return {
          variantId: bucket.variantId,
          skuCode: bucket.skuCode,
          barcode: bucket.barcode,
          variantName: bucket.variantName,
          imageUrl: bucket.imageUrl,
          warehouseId: bucket.warehouseId,
          warehouseName: bucket.warehouseName,
          binLocationCode: stock?.binLocationCode || 'CHUA-GAN-KE',
          totalPickQty: bucket.totalPickQty,
          currentOnHandQty: onHand,
          currentAvailableQty: available,
          isShortageRisk: onHand < bucket.totalPickQty,
          orderCodes: Array.from(bucket.orderCodes),
        };
      })
      .sort((a, b) => {
        // Sắp xếp theo mã kệ kho để tối ưu tuyến đường đi nhặt hàng thực tế
        const binCompare = a.binLocationCode.localeCompare(b.binLocationCode);
        return binCompare !== 0 ? binCompare : a.skuCode.localeCompare(b.skuCode);
      });

    const picklistCode = `PICK-${Date.now().toString(36).toUpperCase()}`;
    const generatedAtIso = new Date().toISOString();
    const totalUnitsToPick = items.reduce((sum, i) => sum + i.totalPickQty, 0);
    const shortageSkuCount = items.filter((i) => i.isShortageRisk).length;

    return {
      picklistCode,
      generatedAtIso,
      totalOrdersCount: eligibleOrders.length,
      totalUniqueSkusCount: items.length,
      totalUnitsToPick,
      shortageSkuCount,
      orderIds: eligibleOrders.map((o) => o.id),
      items,
      printableHtmlTemplate: this.renderWavePicklistHtml({
        picklistCode,
        generatedAtIso,
        totalOrdersCount: eligibleOrders.length,
        totalUnitsToPick,
        items,
      }),
    };
  }

  /**
   * F07.9B: Tạo Biên Bản Bàn Giao Vận Chuyển (Carrier Handover Manifest).
   */
  public async createHandoverManifest(params: {
    shopId: string;
    actorUserId: string;
    dto: CreateHandoverManifestDto;
  }): Promise<CarrierHandoverManifestEntity> {
    const warehouse = await this.warehouseRepo.findOne({
      where: { id: params.dto.warehouseId, shopId: params.shopId },
    });
    if (!warehouse) {
      throw new NotFoundException('Không tìm thấy kho xuất hàng');
    }

    const normalizedCarrier = params.dto.carrierCode.trim().toUpperCase();
    const manifestCode = `BBBG-${normalizedCarrier}-${Date.now().toString(36).toUpperCase()}`;

    const entity = this.manifestRepo.create({
      shopId: params.shopId,
      manifestCode,
      warehouseId: warehouse.id,
      warehouseName: warehouse.name,
      carrierCode: normalizedCarrier,
      status: CarrierHandoverManifestStatusEnum.DRAFT_SCANNING,
      courierDriverName: params.dto.courierDriverName?.trim() || null,
      courierDriverPhone: params.dto.courierDriverPhone?.trim() || null,
      courierVehiclePlate: params.dto.courierVehiclePlate?.trim() || null,
      scannedOrdersJson: [],
      totalParcelsCount: 0,
      totalWeightGrams: 0,
      totalCodAmount: 0,
      note: params.dto.note?.trim() || null,
      createdBy: params.actorUserId,
    });

    return this.manifestRepo.save(entity);
  }

  /**
   * F07.9B: Quét súng Barcode từng kiện hàng đưa vào Biên Bản Bàn Giao.
   * Chặn tuyệt đối quét nhầm hãng vận chuyển, quét trùng kiện, hoặc kiện chưa hoàn tất đóng gói.
   */
  public async scanOrderIntoHandoverManifest(params: {
    shopId: string;
    manifestId: string;
    actorUserId: string;
    dto: ScanOrderIntoHandoverDto;
  }): Promise<{
    manifest: CarrierHandoverManifestEntity;
    scannedItem: HandoverManifestScannedOrderItem;
  }> {
    const manifest = await this.manifestRepo.findOne({
      where: { id: params.manifestId, shopId: params.shopId },
    });
    if (!manifest) {
      throw new NotFoundException('Không tìm thấy biên bản bàn giao');
    }
    if (manifest.status !== CarrierHandoverManifestStatusEnum.DRAFT_SCANNING) {
      throw new BadRequestException(
        'Biên bản bàn giao đã chốt hoặc đã hủy, không thể quét thêm kiện',
      );
    }

    const rawCode = params.dto.scannedCode.trim();
    if (!rawCode) {
      throw new BadRequestException('Mã vận đơn quét vào không hợp lệ');
    }

    const order = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.shop_id = :shopId', { shopId: params.shopId })
      .andWhere('(o.tracking_number = :code OR o.order_code = :code)', {
        code: rawCode,
      })
      .getOne();

    if (!order) {
      throw new NotFoundException(`Không tìm thấy vận đơn hoặc mã đơn "${rawCode}" trong cửa hàng`);
    }

    if (order.carrierCode.toUpperCase() !== manifest.carrierCode.toUpperCase()) {
      throw new BadRequestException(
        `Sai hãng vận chuyển: Đơn ${order.orderCode} thuộc ${order.carrierCode}, không thuộc biên bản ${manifest.carrierCode}`,
      );
    }

    if (
      ![PosOrderStatusEnum.PACKED_READY_TO_SHIP, PosOrderStatusEnum.WAITING_PACKING].includes(
        order.status,
      )
    ) {
      throw new BadRequestException(
        `Đơn ${order.orderCode} đang ở trạng thái ${order.status}, không đủ điều kiện bàn giao bưu tá`,
      );
    }

    if (order.handoverManifestId && order.handoverManifestId !== manifest.id) {
      throw new ConflictException(`Đơn ${order.orderCode} đã thuộc một biên bản bàn giao khác`);
    }

    const currentList = manifest.scannedOrdersJson || [];
    if (currentList.some((item) => item.orderId === order.id)) {
      throw new ConflictException(
        `Kiện hàng ${order.orderCode} (${order.trackingNumber || 'N/A'}) đã được quét trong biên bản này`,
      );
    }

    const scannedItem: HandoverManifestScannedOrderItem = {
      orderId: order.id,
      orderCode: order.orderCode,
      trackingNumber: order.trackingNumber || order.orderCode,
      customerName: order.customerName,
      codCollectAmount: Number(order.codCollectAmount || 0),
      actualPackedWeightGrams: Number(
        order.actualPackedWeightGrams || order.totalWeightGrams || 500,
      ),
      scannedAtIso: new Date().toISOString(),
      scannedByUserId: params.actorUserId,
    };

    const nextList = [scannedItem, ...currentList];
    manifest.scannedOrdersJson = nextList;
    manifest.totalParcelsCount = nextList.length;
    manifest.totalWeightGrams = nextList.reduce(
      (sum, item) => sum + item.actualPackedWeightGrams,
      0,
    );
    manifest.totalCodAmount = nextList.reduce((sum, item) => sum + item.codCollectAmount, 0);
    manifest.updatedBy = params.actorUserId;

    const saved = await this.manifestRepo.save(manifest);

    return {
      manifest: saved,
      scannedItem,
    };
  }

  public async sealAndCompleteHandoverManifest(params: {
    shopId: string;
    manifestId: string;
    actorUserId: string;
    actorName: string;
    dto: SealHandoverManifestDto;
  }): Promise<{
    manifest: CarrierHandoverManifestEntity;
    handedOverCount: number;
    failedOrderCodes: string[];
    printableHtmlTemplate: string;
  }> {
    const manifest = await this.manifestRepo.findOne({
      where: { id: params.manifestId, shopId: params.shopId },
    });
    if (!manifest) {
      throw new NotFoundException('Không tìm thấy biên bản bàn giao');
    }
    if (manifest.status !== CarrierHandoverManifestStatusEnum.DRAFT_SCANNING) {
      throw new BadRequestException('Biên bản bàn giao đã được chốt trước đó');
    }

    const scannedItems = manifest.scannedOrdersJson || [];
    if (scannedItems.length === 0) {
      throw new BadRequestException('Chưa có kiện hàng nào được quét vào biên bản bàn giao');
    }

    if (params.dto.courierDriverName !== undefined) {
      manifest.courierDriverName = params.dto.courierDriverName.trim() || null;
    }
    if (params.dto.courierDriverPhone !== undefined) {
      manifest.courierDriverPhone = params.dto.courierDriverPhone.trim() || null;
    }
    if (params.dto.note !== undefined) {
      manifest.note = params.dto.note.trim() || null;
    }

    let handedOverCount = 0;
    const failedOrderCodes: string[] = [];

    for (const item of scannedItems) {
      try {
        await this.omsStateMachine.transitionOrderStatus({
          shopId: params.shopId,
          orderId: item.orderId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          dto: {
            targetStatus: PosOrderStatusEnum.HANDED_TO_CARRIER,
            reasonNote: `Chốt biên bản bàn giao ${manifest.manifestCode} (${manifest.carrierCode})`,
          },
        });
        await this.orderRepo.update(
          { id: item.orderId, shopId: params.shopId },
          { handoverManifestId: manifest.id },
        );
        handedOverCount += 1;
      } catch {
        failedOrderCodes.push(item.orderCode);
      }
    }

    manifest.status = CarrierHandoverManifestStatusEnum.SEALED_HANDED_OVER;
    manifest.sealedByUserId = params.actorUserId;
    manifest.sealedAt = new Date();
    manifest.updatedBy = params.actorUserId;

    const saved = await this.manifestRepo.save(manifest);

    this.realtimeEmitter.emitToRoom(
      SOCKET_CONFIG.namespaces.CHAT,
      `shop:${params.shopId}`,
      'oms:handover_manifest_sealed',
      {
        manifestId: saved.id,
        manifestCode: saved.manifestCode,
        carrierCode: saved.carrierCode,
        totalParcelsCount: saved.totalParcelsCount,
        handedOverCount,
      },
    );

    return {
      manifest: saved,
      handedOverCount,
      failedOrderCodes,
      printableHtmlTemplate: this.renderHandoverManifestHtml(saved),
    };
  }

  public async listHandoverManifests(shopId: string) {
    return this.manifestRepo.find({
      where: { shopId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  public async getHandoverManifestDetail(shopId: string, manifestId: string) {
    const manifest = await this.manifestRepo.findOne({
      where: { id: manifestId, shopId },
    });
    if (!manifest) {
      throw new NotFoundException('Không tìm thấy biên bản bàn giao');
    }
    return {
      manifest,
      printableHtmlTemplate: this.renderHandoverManifestHtml(manifest),
    };
  }

  public async scheduleOrderCallLater(params: {
    shopId: string;
    orderId: string;
    actorUserId: string;
    actorName: string;
    dto: ScheduleOrderCallLaterDto;
  }): Promise<PosOrderEntity> {
    const order = await this.orderRepo.findOne({
      where: { id: params.orderId, shopId: params.shopId },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    const beforeSnapshot = {
      callLaterAt: order.callLaterAt,
      callAttemptCount: order.callAttemptCount,
      subStatus: order.subStatus,
      orderTagsJson: order.orderTagsJson || [],
    };

    const existingTags = new Set(order.orderTagsJson || []);
    for (const tag of params.dto.appendOrderTags || []) {
      const clean = tag.trim();
      if (clean) existingTags.add(clean);
    }

    order.callLaterAt = new Date(params.dto.callLaterAt);
    order.callAttemptCount = Number(order.callAttemptCount || 0) + 1;
    order.subStatus = params.dto.subStatus?.trim() || 'CALL_LATER_PENDING';
    order.lastCallNote = params.dto.note?.trim() || order.lastCallNote;
    order.orderTagsJson = Array.from(existingTags);
    order.updatedBy = params.actorUserId;

    const saved = await this.orderRepo.save(order);

    await this.omsStateMachine.appendOrderRevision({
      shopId: params.shopId,
      order: saved,
      actorUserId: params.actorUserId,
      actorName: params.actorName,
      actionType: 'CALL_LATER_SCHEDULED',
      reasonNote: params.dto.note || `Hẹn gọi lại lần ${saved.callAttemptCount}`,
      beforeSnapshot,
      afterSnapshot: {
        callLaterAt: saved.callLaterAt,
        callAttemptCount: saved.callAttemptCount,
        subStatus: saved.subStatus,
        orderTagsJson: saved.orderTagsJson,
      },
    });

    this.realtimeEmitter.emitToRoom(
      SOCKET_CONFIG.namespaces.CHAT,
      `shop:${params.shopId}`,
      'oms:call_later_updated',
      {
        orderId: saved.id,
        orderCode: saved.orderCode,
        callLaterAt: saved.callLaterAt,
        callAttemptCount: saved.callAttemptCount,
        orderTags: saved.orderTagsJson,
      },
    );

    return saved;
  }

  public async updateOrderTagsAndSubStatus(params: {
    shopId: string;
    orderId: string;
    actorUserId: string;
    actorName: string;
    dto: UpdateOrderTagsAndSubStatusDto;
  }): Promise<PosOrderEntity> {
    const order = await this.orderRepo.findOne({
      where: { id: params.orderId, shopId: params.shopId },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    const beforeSnapshot = {
      orderTagsJson: order.orderTagsJson || [],
      subStatus: order.subStatus,
      callLaterAt: order.callLaterAt,
    };

    const normalizedTags = Array.from(
      new Set(params.dto.orderTags.map((tag) => tag.trim()).filter(Boolean)),
    );
    order.orderTagsJson = normalizedTags;
    if (params.dto.subStatus !== undefined) {
      order.subStatus = params.dto.subStatus?.trim() || null;
    }
    if (params.dto.clearCallLater) {
      order.callLaterAt = null;
    }
    order.updatedBy = params.actorUserId;

    const saved = await this.orderRepo.save(order);

    await this.omsStateMachine.appendOrderRevision({
      shopId: params.shopId,
      order: saved,
      actorUserId: params.actorUserId,
      actorName: params.actorName,
      actionType: 'ORDER_TAGS_UPDATED',
      reasonNote: `Cập nhật thẻ đơn hàng (${normalizedTags.length} thẻ)`,
      beforeSnapshot,
      afterSnapshot: {
        orderTagsJson: saved.orderTagsJson,
        subStatus: saved.subStatus,
        callLaterAt: saved.callLaterAt,
      },
    });

    return saved;
  }

  public async listConfirmationCallLaterQueue(shopId: string) {
    const orders = await this.orderRepo.find({
      where: {
        shopId,
        callLaterAt: Not(IsNull()),
        status: In([
          PosOrderStatusEnum.DRAFT,
          PosOrderStatusEnum.WAITING_DEPOSIT,
          PosOrderStatusEnum.CONFIRMED,
          PosOrderStatusEnum.WAITING_PACKING,
          PosOrderStatusEnum.DELIVERY_FAILED_RESCUE,
        ]),
      },
      order: { callLaterAt: 'ASC' },
      take: 100,
    });

    const nowMs = Date.now();
    const overdueCount = orders.filter(
      (o) => o.callLaterAt && o.callLaterAt.getTime() < nowMs,
    ).length;

    return {
      totalCount: orders.length,
      overdueCount,
      upcomingCount: orders.length - overdueCount,
      orders,
    };
  }

  public async settlePartialDelivery(params: {
    shopId: string;
    orderId: string;
    actorUserId: string;
    actorName: string;
    dto: SettlePartialDeliveryDto;
  }): Promise<PosOrderEntity> {
    const order = await this.orderRepo.findOne({
      where: { id: params.orderId, shopId: params.shopId },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    if (
      ![
        PosOrderStatusEnum.IN_TRANSIT,
        PosOrderStatusEnum.DELIVERY_FAILED_RESCUE,
        PosOrderStatusEnum.DELIVERED,
      ].includes(order.status)
    ) {
      throw new BadRequestException(
        `Chỉ được quyết toán giao hàng một phần cho đơn đang giao hoặc vừa giao (trạng thái hiện tại: ${order.status})`,
      );
    }

    const inputMap = new Map(params.dto.items.map((item) => [item.variantId, item]));

    const beforeSnapshot = {
      status: order.status,
      codCollectAmount: Number(order.codCollectAmount || 0),
      totalPayableAmount: Number(order.totalPayableAmount || 0),
      itemsJson: order.itemsJson,
    };

    const settledItems: PosOrderPartialDeliveryLineItem[] = [];
    let deliveredGoodsValue = 0;

    for (const line of order.itemsJson || []) {
      const patch = inputMap.get(line.variantId);
      const orderedQty = Number(line.quantity || 0);
      const deliveredQty = patch
        ? Math.min(orderedQty, Math.max(0, patch.deliveredQty))
        : orderedQty;
      const returnedQty = Math.max(0, orderedQty - deliveredQty);
      const unitPrice = Number(line.finalUnitPrice || line.retailPrice || 0);

      deliveredGoodsValue += deliveredQty * unitPrice;

      let restocked = false;
      if (returnedQty > 0 && patch?.restockReturnedImmediately) {
        const targetWarehouseId = line.warehouseId || order.warehouseId;
        let stockItem = await this.stockRepo.findOne({
          where: {
            shopId: params.shopId,
            warehouseId: targetWarehouseId,
            variantId: line.variantId,
          },
        });
        if (!stockItem) {
          stockItem = this.stockRepo.create({
            shopId: params.shopId,
            warehouseId: targetWarehouseId,
            variantId: line.variantId,
            skuCode: line.skuCode,
            onHandQty: 0,
            reservedQty: 0,
            availableQty: 0,
            inTransitQty: 0,
            defectiveHoldQty: 0,
          });
        }
        const beforeOnHandQty = Number(stockItem.onHandQty || 0);
        const beforeReservedQty = Number(stockItem.reservedQty || 0);
        const beforeAvailableQty = Number(stockItem.availableQty || 0);

        stockItem.onHandQty = beforeOnHandQty + returnedQty;
        stockItem.availableQty = Math.max(0, stockItem.onHandQty - beforeReservedQty);
        await this.stockRepo.save(stockItem);

        await this.inventoryService.appendInventoryLedger({
          shopId: params.shopId,
          warehouseId: targetWarehouseId,
          variantId: line.variantId,
          skuCode: line.skuCode,
          movementType: InventoryMovementTypeEnum.RETURN_RESTOCK,
          deltaQty: returnedQty,
          beforeOnHandQty,
          afterOnHandQty: stockItem.onHandQty,
          beforeReservedQty,
          afterReservedQty: stockItem.reservedQty,
          beforeAvailableQty,
          afterAvailableQty: stockItem.availableQty,
          costPrice: Number(line.costPrice || 0),
          referenceType: 'PARTIAL_DELIVERY_RETURN',
          referenceId: order.id,
          note: `Nhập lại kho ${returnedQty} SP hoàn một phần từ đơn ${order.orderCode}`,
          actorUserId: params.actorUserId,
        });
        restocked = true;
      }

      settledItems.push({
        variantId: line.variantId,
        skuCode: line.skuCode,
        variantName: line.variantName,
        orderedQty,
        deliveredQty,
        returnedQty,
        unitPrice,
        restockedToWarehouse: restocked,
      });
    }

    const partialReturnFee = Number(params.dto.partialReturnShippingFee || 0);
    const shippingCharged = order.isFreeShippingForCustomer
      ? 0
      : Number(order.shippingFeeAmount || 0);
    const revisedTotalPayable = Math.max(
      0,
      deliveredGoodsValue +
        shippingCharged +
        partialReturnFee -
        Number(order.walletCreditAppliedAmount || 0),
    );
    const revisedCodAmount = Math.max(
      0,
      revisedTotalPayable - Number(order.paidTransferAmount || 0),
    );

    const partialInfo: PosOrderPartialDeliveryInfo = {
      settledAtIso: new Date().toISOString(),
      settledByUserId: params.actorUserId,
      originalCodAmount: Number(order.codCollectAmount || 0),
      revisedCodAmount,
      partialReturnShippingFee: partialReturnFee,
      items: settledItems,
      note: params.dto.note?.trim() || null,
    };

    order.partialDeliveryInfoJson = partialInfo;
    order.totalPayableAmount = revisedTotalPayable;
    order.codCollectAmount = revisedCodAmount;
    order.status = PosOrderStatusEnum.DELIVERED;
    order.deliveredAt = order.deliveredAt || new Date();
    order.subStatus = 'PARTIAL_DELIVERED';
    order.updatedBy = params.actorUserId;

    const saved = await this.orderRepo.save(order);

    await this.omsStateMachine.appendOrderRevision({
      shopId: params.shopId,
      order: saved,
      actorUserId: params.actorUserId,
      actorName: params.actorName,
      actionType: 'PARTIAL_DELIVERY_SETTLED',
      reasonNote:
        params.dto.note ||
        `Quyết toán giao 1 phần: COD ${partialInfo.originalCodAmount}đ → ${revisedCodAmount}đ`,
      beforeSnapshot,
      afterSnapshot: {
        status: saved.status,
        codCollectAmount: saved.codCollectAmount,
        totalPayableAmount: saved.totalPayableAmount,
        partialDeliveryInfoJson: partialInfo,
      },
    });

    await this.piiAuditService.recordSecurityAuditLog({
      shopId: params.shopId,
      actorUserId: params.actorUserId,
      actorName: params.actorName,
      actionCode: SecurityAuditActionCodeEnum.MODIFY_CONFIRMED_ORDER,
      targetResourceType: 'POS_ORDER',
      targetResourceId: saved.id,
      beforeSnapshotJson: beforeSnapshot,
      afterSnapshotJson: {
        revisedCodAmount,
        partialInfo,
      },
    });

    return saved;
  }

  private renderWavePicklistHtml(params: {
    picklistCode: string;
    generatedAtIso: string;
    totalOrdersCount: number;
    totalUnitsToPick: number;
    items: WavePicklistSkuLine[];
  }): string {
    const rowsHtml = params.items
      .map(
        (item, idx) => `
          <tr>
            <td style="border:1px solid #333;padding:6px;text-align:center;">${idx + 1}</td>
            <td style="border:1px solid #333;padding:6px;font-weight:bold;">${item.binLocationCode}</td>
            <td style="border:1px solid #333;padding:6px;font-family:monospace;">${item.skuCode}</td>
            <td style="border:1px solid #333;padding:6px;">${item.variantName}</td>
            <td style="border:1px solid #333;padding:6px;text-align:center;font-weight:bold;font-size:14px;">${item.totalPickQty}</td>
            <td style="border:1px solid #333;padding:6px;text-align:center;">${item.currentOnHandQty}</td>
            <td style="border:1px solid #333;padding:6px;font-size:11px;">${item.orderCodes.join(', ')}</td>
          </tr>
        `,
      )
      .join('');

    return `<!DOCTYPE html>
<html lang="vi">
<head><meta charset="utf-8" /><title>Phiếu Nhặt Hàng ${params.picklistCode}</title></head>
<body style="font-family:Arial,sans-serif;padding:16px;color:#111;">
  <h2 style="margin:0 0 6px;">PHIẾU NHẶT HÀNG TỔNG HỢP (WAVE PICKLIST)</h2>
  <p style="margin:0 0 12px;font-size:12px;">Mã phiếu: <strong>${params.picklistCode}</strong> | Số đơn: <strong>${params.totalOrdersCount}</strong> | Tổng SP cần nhặt: <strong>${params.totalUnitsToPick}</strong> | Thời gian: ${params.generatedAtIso}</p>
  <table style="width:100%;border-collapse:collapse;font-size:12px;">
    <thead>
      <tr style="background:#f3f4f6;">
        <th style="border:1px solid #333;padding:6px;">#</th>
        <th style="border:1px solid #333;padding:6px;">Vị trí kệ</th>
        <th style="border:1px solid #333;padding:6px;">Mã SKU</th>
        <th style="border:1px solid #333;padding:6px;">Tên phân loại</th>
        <th style="border:1px solid #333;padding:6px;">SL cần nhặt</th>
        <th style="border:1px solid #333;padding:6px;">Tồn kho</th>
        <th style="border:1px solid #333;padding:6px;">Thuộc các đơn</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`;
  }

  private renderHandoverManifestHtml(manifest: CarrierHandoverManifestEntity): string {
    const rowsHtml = (manifest.scannedOrdersJson || [])
      .map(
        (item, idx) => `
          <tr>
            <td style="border:1px solid #333;padding:6px;text-align:center;">${idx + 1}</td>
            <td style="border:1px solid #333;padding:6px;font-family:monospace;font-weight:bold;">${item.trackingNumber}</td>
            <td style="border:1px solid #333;padding:6px;">${item.orderCode}</td>
            <td style="border:1px solid #333;padding:6px;">${item.customerName}</td>
            <td style="border:1px solid #333;padding:6px;text-align:right;">${item.actualPackedWeightGrams}g</td>
            <td style="border:1px solid #333;padding:6px;text-align:right;font-weight:bold;">${item.codCollectAmount.toLocaleString('vi-VN')}đ</td>
          </tr>
        `,
      )
      .join('');

    return `<!DOCTYPE html>
<html lang="vi">
<head><meta charset="utf-8" /><title>Biên Bản Bàn Giao ${manifest.manifestCode}</title></head>
<body style="font-family:Arial,sans-serif;padding:18px;color:#111;">
  <h2 style="margin:0 0 6px;text-align:center;">BIÊN BẢN BÀN GIAO VẬN CHUYỂN (${manifest.carrierCode})</h2>
  <p style="margin:0 0 12px;font-size:12px;text-align:center;">
    Mã biên bản: <strong>${manifest.manifestCode}</strong> | Kho xuất: <strong>${manifest.warehouseName}</strong> | Tổng kiện: <strong>${manifest.totalParcelsCount}</strong> | Tổng KL: <strong>${manifest.totalWeightGrams}g</strong> | Tổng COD: <strong>${Number(manifest.totalCodAmount || 0).toLocaleString('vi-VN')}đ</strong>
  </p>
  <p style="margin:0 0 12px;font-size:12px;">
    Bưu tá nhận hàng: <strong>${manifest.courierDriverName || '____________________'}</strong> | SĐT: <strong>${manifest.courierDriverPhone || '______________'}</strong> | Biển số xe: <strong>${manifest.courierVehiclePlate || '___________'}</strong>
  </p>
  <table style="width:100%;border-collapse:collapse;font-size:12px;">
    <thead>
      <tr style="background:#f3f4f6;">
        <th style="border:1px solid #333;padding:6px;">STT</th>
        <th style="border:1px solid #333;padding:6px;">Mã vận đơn</th>
        <th style="border:1px solid #333;padding:6px;">Mã đơn shop</th>
        <th style="border:1px solid #333;padding:6px;">Người nhận</th>
        <th style="border:1px solid #333;padding:6px;">KL đóng gói</th>
        <th style="border:1px solid #333;padding:6px;">Thu hộ COD</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div style="display:flex;justify-content:space-between;margin-top:32px;font-size:12px;text-align:center;">
    <div style="width:45%;"><strong>ĐẠI DIỆN KHO XUẤT HÀNG</strong><br/><em>(Ký, ghi rõ họ tên)</em></div>
    <div style="width:45%;"><strong>BƯU TÁ NHẬN BÀN GIAO (${manifest.carrierCode})</strong><br/><em>(Ký, ghi rõ họ tên)</em></div>
  </div>
</body>
</html>`;
  }
}
