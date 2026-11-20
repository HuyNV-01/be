import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  InventoryMovementTypeEnum,
  OmsCarrierSlaBreachTypeEnum,
  PosOrderStatusEnum,
  SecurityAuditActionCodeEnum,
} from 'src/common/enum';
import { PermissionCodeEnum } from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import {
  DispatchCarrierBatchDto,
  ModifyConfirmedOrderDto,
  OmsOrderListQueryDto,
  TransitionOrderStatusDto,
} from 'src/dto/oms/oms-fulfillment.dto';
import { OrderCarrierEventEntity } from 'src/entity/order-carrier-event.entity';
import {
  OrderFieldDiffEntry,
  OrderRevisionHistoryEntity,
} from 'src/entity/order-revision-history.entity';
import { PosOrderEntity, PosOrderLineItem } from 'src/entity/pos-order.entity';
import { ProductVariantEntity } from 'src/entity/product-variant.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { WarehouseStockItemEntity } from 'src/entity/warehouse-stock-item.entity';
import { AtomicInventoryAndTransferService } from 'src/modules/catalog-pos/services/atomic-inventory-and-transfer.service';
import { PiiVaultAndAuditService } from 'src/modules/crm/services/pii-vault-and-audit.service';
import { EffectiveMemberContext } from 'src/modules/iam/iam.service';
import { Brackets, In, Repository } from 'typeorm';

export const OMS_ALLOWED_STATUS_TRANSITIONS: Record<PosOrderStatusEnum, PosOrderStatusEnum[]> = {
  [PosOrderStatusEnum.DRAFT]: [
    PosOrderStatusEnum.PENDING_PRICE_APPROVAL,
    PosOrderStatusEnum.WAITING_DEPOSIT,
    PosOrderStatusEnum.CONFIRMED,
    PosOrderStatusEnum.CANCELLED,
  ],
  [PosOrderStatusEnum.PENDING_PRICE_APPROVAL]: [
    PosOrderStatusEnum.WAITING_DEPOSIT,
    PosOrderStatusEnum.CONFIRMED,
    PosOrderStatusEnum.CANCELLED,
  ],
  [PosOrderStatusEnum.WAITING_DEPOSIT]: [
    PosOrderStatusEnum.CONFIRMED,
    PosOrderStatusEnum.CANCELLED,
  ],
  [PosOrderStatusEnum.CONFIRMED]: [
    PosOrderStatusEnum.WAITING_PACKING,
    PosOrderStatusEnum.PACKED_READY_TO_SHIP,
    PosOrderStatusEnum.CANCELLED,
  ],
  [PosOrderStatusEnum.WAITING_PACKING]: [
    PosOrderStatusEnum.PACKED_READY_TO_SHIP,
    PosOrderStatusEnum.CANCELLED,
  ],
  [PosOrderStatusEnum.PACKED_READY_TO_SHIP]: [
    PosOrderStatusEnum.HANDED_TO_CARRIER,
    PosOrderStatusEnum.WAITING_PACKING,
    PosOrderStatusEnum.CANCELLED,
  ],
  [PosOrderStatusEnum.HANDED_TO_CARRIER]: [
    PosOrderStatusEnum.IN_TRANSIT,
    PosOrderStatusEnum.DELIVERY_FAILED_RESCUE,
    PosOrderStatusEnum.DELIVERED,
    PosOrderStatusEnum.RETURNING,
  ],
  [PosOrderStatusEnum.IN_TRANSIT]: [
    PosOrderStatusEnum.DELIVERY_FAILED_RESCUE,
    PosOrderStatusEnum.DELIVERED,
    PosOrderStatusEnum.RETURNING,
  ],
  [PosOrderStatusEnum.DELIVERY_FAILED_RESCUE]: [
    PosOrderStatusEnum.IN_TRANSIT,
    PosOrderStatusEnum.DELIVERED,
    PosOrderStatusEnum.RETURNING,
  ],
  [PosOrderStatusEnum.DELIVERED]: [
    PosOrderStatusEnum.DELIVERED_RECONCILED,
    PosOrderStatusEnum.RETURNING,
  ],
  [PosOrderStatusEnum.DELIVERED_RECONCILED]: [],
  [PosOrderStatusEnum.RETURNING]: [
    PosOrderStatusEnum.RETURNED_RESTOCKED,
    PosOrderStatusEnum.DELIVERED,
  ],
  [PosOrderStatusEnum.RETURNED_RESTOCKED]: [],
  [PosOrderStatusEnum.CANCELLED]: [],
};

const LOCKED_AFTER_PACK_OR_SHIP_STATUSES = new Set<PosOrderStatusEnum>([
  PosOrderStatusEnum.PACKED_READY_TO_SHIP,
  PosOrderStatusEnum.HANDED_TO_CARRIER,
  PosOrderStatusEnum.IN_TRANSIT,
  PosOrderStatusEnum.DELIVERY_FAILED_RESCUE,
  PosOrderStatusEnum.DELIVERED,
  PosOrderStatusEnum.DELIVERED_RECONCILED,
  PosOrderStatusEnum.RETURNING,
  PosOrderStatusEnum.RETURNED_RESTOCKED,
]);

@Injectable()
export class OmsStateMachineService {
  constructor(
    @InjectRepository(PosOrderEntity)
    private readonly orderRepo: Repository<PosOrderEntity>,
    @InjectRepository(OrderRevisionHistoryEntity)
    private readonly revisionRepo: Repository<OrderRevisionHistoryEntity>,
    @InjectRepository(OrderCarrierEventEntity)
    private readonly carrierEventRepo: Repository<OrderCarrierEventEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    @InjectRepository(ProductVariantEntity)
    private readonly variantRepo: Repository<ProductVariantEntity>,
    @InjectRepository(WarehouseStockItemEntity)
    private readonly stockRepo: Repository<WarehouseStockItemEntity>,
    private readonly inventoryService: AtomicInventoryAndTransferService,
    private readonly piiAuditService: PiiVaultAndAuditService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  public async listOmsOrders(shopId: string, query: OmsOrderListQueryDto) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(200, Math.max(1, query.limit || 30));

    const qb = this.orderRepo
      .createQueryBuilder('o')
      .where('o.shopId = :shopId', { shopId })
      .orderBy('o.createdAt', 'DESC');

    if (query.status) {
      qb.andWhere('o.status = :status', { status: query.status });
    }
    if (query.carrierCode) {
      qb.andWhere('o.carrierCode = :carrierCode', { carrierCode: query.carrierCode });
    }
    if (query.warehouseId) {
      qb.andWhere('o.warehouseId = :warehouseId', { warehouseId: query.warehouseId });
    }
    if (query.slaBreachType && query.slaBreachType !== OmsCarrierSlaBreachTypeEnum.NONE) {
      qb.andWhere('o.slaBreachType = :slaBreachType', { slaBreachType: query.slaBreachType });
    }
    if (query.search?.trim()) {
      const kw = `%${query.search.trim()}%`;
      qb.andWhere(
        new Brackets((b) => {
          b.where('o.orderCode LIKE :kw', { kw })
            .orWhere('o.trackingNumber LIKE :kw', { kw })
            .orWhere('o.customerName LIKE :kw', { kw })
            .orWhere('o.customerPhoneMasked LIKE :kw', { kw });
        }),
      );
    }

    const [items, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const statusCountsRaw = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.status', 'status')
      .addSelect('COUNT(o.id)', 'cnt')
      .where('o.shopId = :shopId', { shopId })
      .groupBy('o.status')
      .getRawMany<{ status: PosOrderStatusEnum; cnt: string }>();

    const statusCounts: Record<string, number> = {};
    for (const row of statusCountsRaw) {
      statusCounts[row.status] = Number(row.cnt || 0);
    }

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      statusCounts,
    };
  }

  public async getOmsOrderDetail(shopId: string, orderId: string) {
    const order = await this.orderRepo.findOne({ where: { id: orderId, shopId } });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng trong cửa hàng này');
    }

    const [revisions, carrierEvents, childOrders] = await Promise.all([
      this.revisionRepo.find({
        where: { shopId, orderId: order.id },
        order: { revisionNumber: 'DESC' },
      }),
      this.carrierEventRepo.find({
        where: { shopId, orderId: order.id },
        order: { eventOccurredAt: 'DESC' },
      }),
      this.orderRepo.find({
        where: { shopId, parentOrderId: order.id },
        order: { createdAt: 'DESC' },
      }),
    ]);

    const shop = await this.shopRepo.findOne({ where: { id: shopId } });
    const isLockedForStandardSale = Boolean(
      shop?.lockOrderAfterPrint &&
        (order.printedCount >= 1 || LOCKED_AFTER_PACK_OR_SHIP_STATUSES.has(order.status)),
    );

    return {
      order,
      revisions,
      carrierEvents,
      childOrders,
      isLockedForStandardSale,
      allowedNextStatuses: OMS_ALLOWED_STATUS_TRANSITIONS[order.status] || [],
    };
  }

  public async transitionOrderStatus(params: {
    shopId: string;
    orderId: string;
    actorUserId: string;
    actorName: string;
    dto: TransitionOrderStatusDto;
    bypassReturnVerificationGuard?: boolean;
  }): Promise<PosOrderEntity> {
    const order = await this.orderRepo.findOne({
      where: { id: params.orderId, shopId: params.shopId },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    if (order.status === params.dto.targetStatus) {
      return order;
    }

    const allowedTargets = OMS_ALLOWED_STATUS_TRANSITIONS[order.status] || [];
    if (!allowedTargets.includes(params.dto.targetStatus)) {
      throw new BadRequestException(
        `Không thể chuyển trạng thái đơn ${order.orderCode} từ ${order.status} sang ${params.dto.targetStatus}`,
      );
    }

    if (
      params.dto.targetStatus === PosOrderStatusEnum.RETURNED_RESTOCKED &&
      !params.bypassReturnVerificationGuard
    ) {
      throw new BadRequestException(
        'Đơn hàng hoàn bắt buộc phải quét Barcode đồng kiểm thực tế tại màn hình Kiểm hoàn trước khi nhập lại tồn kho.',
      );
    }

    const beforeSnapshot = this.buildRevisionSnapshot(order);
    const previousStatus = order.status;
    order.status = params.dto.targetStatus;

    if (
      params.dto.targetStatus === PosOrderStatusEnum.HANDED_TO_CARRIER &&
      !order.handedToCarrierAt
    ) {
      order.handedToCarrierAt = new Date();
      order.slaBreachType = OmsCarrierSlaBreachTypeEnum.NONE;
      await this.deductOnHandStockUponCarrierPickup(order, params.actorUserId);
    }

    if (params.dto.targetStatus === PosOrderStatusEnum.DELIVERED && !order.deliveredAt) {
      order.deliveredAt = new Date();
      order.slaBreachType = OmsCarrierSlaBreachTypeEnum.NONE;
    }

    if (params.dto.targetStatus === PosOrderStatusEnum.CANCELLED) {
      await this.releaseReservedStockOnCancel(order, params.actorUserId);
    }

    const saved = await this.orderRepo.save(order);

    await this.appendOrderRevision({
      shopId: params.shopId,
      order: saved,
      actorUserId: params.actorUserId,
      actorName: params.actorName,
      actionType: 'STATUS_TRANSITION',
      reasonNote: params.dto.reasonNote || `Chuyển trạng thái ${previousStatus} → ${saved.status}`,
      beforeSnapshot,
      afterSnapshot: this.buildRevisionSnapshot(saved),
    });

    this.realtimeEmitter.emitToRoom(
      'chat',
      `shop:${params.shopId}`,
      'oms:carrier_webhook_status_changed',
      {
        shopId: params.shopId,
        orderId: saved.id,
        orderCode: saved.orderCode,
        previousStatus,
        status: saved.status,
        trackingNumber: saved.trackingNumber,
        updatedAt: new Date().toISOString(),
      },
    );

    return saved;
  }

  public async modifyConfirmedOrder(params: {
    shopId: string;
    orderId: string;
    actorUserId: string;
    actorName: string;
    memberContext?: EffectiveMemberContext;
    dto: ModifyConfirmedOrderDto;
  }): Promise<{ order: PosOrderEntity; revision: OrderRevisionHistoryEntity }> {
    const order = await this.orderRepo.findOne({
      where: { id: params.orderId, shopId: params.shopId },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    if (
      order.status === PosOrderStatusEnum.DELIVERED_RECONCILED ||
      order.status === PosOrderStatusEnum.CANCELLED
    ) {
      throw new BadRequestException(
        'Đơn hàng đã tất toán đối soát COD hoặc đã hủy, không thể chỉnh sửa.',
      );
    }

    const shop = await this.shopRepo.findOne({ where: { id: params.shopId } });
    const isOrderLocked = Boolean(
      shop?.lockOrderAfterPrint &&
        (order.printedCount >= 1 || LOCKED_AFTER_PACK_OR_SHIP_STATUSES.has(order.status)),
    );

    const hasModifyPermission = Boolean(
      params.memberContext?.permissions.includes(PermissionCodeEnum.OMS_CONFIRMED_ORDER_MODIFY),
    );
    if (isOrderLocked && !hasModifyPermission) {
      throw new ForbiddenException(
        'Đơn hàng đã in phiếu giao hàng và bị khóa chỉnh sửa. Yêu cầu quyền OMS_CONFIRMED_ORDER_MODIFY.',
      );
    }

    const beforeSnapshot = this.buildRevisionSnapshot(order);

    if (params.dto.customerName !== undefined) {
      order.customerName = params.dto.customerName.trim();
    }
    if (params.dto.receiverAddressLine !== undefined) {
      order.receiverAddressLine = params.dto.receiverAddressLine.trim();
    }
    if (params.dto.note !== undefined) {
      order.note = params.dto.note.trim();
    }
    if (params.dto.shippingFeeAmount !== undefined) {
      order.shippingFeeAmount = Number(params.dto.shippingFeeAmount);
    }

    if (params.dto.items && params.dto.items.length > 0) {
      const variantIds = params.dto.items.map((item) => item.variantId);
      const variants = await this.variantRepo.find({
        where: { shopId: params.shopId, id: In(variantIds) },
      });
      const variantMap = new Map(variants.map((v) => [v.id, v]));

      const rebuiltItems: PosOrderLineItem[] = [];
      let subtotal = 0;
      let totalWeightGrams = 0;
      let totalCogs = 0;

      for (const reqItem of params.dto.items) {
        const variant = variantMap.get(reqItem.variantId);
        if (!variant) {
          throw new BadRequestException(`Biến thể ${reqItem.variantId} không tồn tại`);
        }
        const discountPct = Number(reqItem.discountPercent ?? 0);
        const retailPrice = Number(variant.retailPrice || 0);
        const discountAmt = Math.round((retailPrice * discountPct) / 100);
        const finalUnitPrice = Math.max(0, retailPrice - discountAmt);
        const lineTotal = finalUnitPrice * reqItem.quantity;

        subtotal += lineTotal;
        totalWeightGrams += Number(variant.weightGrams || 200) * reqItem.quantity;
        totalCogs += Number(variant.costPrice || 0) * reqItem.quantity;

        const existingLine = (order.itemsJson || []).find((i) => i.variantId === variant.id);
        rebuiltItems.push({
          variantId: variant.id,
          productId: variant.productId,
          skuCode: variant.skuCode,
          barcode: variant.barcode || variant.skuCode,
          variantName: variant.variantName,
          imageUrl: variant.imageUrl || null,
          quantity: reqItem.quantity,
          retailPrice,
          discountPercent: discountPct,
          discountAmount: discountAmt * reqItem.quantity,
          finalUnitPrice,
          lineTotalAmount: lineTotal,
          costPrice: Number(variant.costPrice || 0),
          weightGrams: Number(variant.weightGrams || 200),
          isBundleBom: Boolean(variant.isBundleBom),
          isFreeGift: false,
          warehouseId: existingLine?.warehouseId || order.warehouseId,
          warehouseName: existingLine?.warehouseName || order.warehouseName,
          assignedSerialNumbers: existingLine?.assignedSerialNumbers || [],
          packedScannedQty: Math.min(existingLine?.packedScannedQty || 0, reqItem.quantity),
          requiresSerialImei: Boolean(variant.requiresSerialImei),
        });
      }

      order.itemsJson = rebuiltItems;
      order.subtotalAmount = subtotal;
      order.totalWeightGrams = Math.max(50, totalWeightGrams);
      order.cogsSnapshotAmount = totalCogs;
      const shippingCharge = order.isFreeShippingForCustomer ? 0 : Number(order.shippingFeeAmount);
      order.totalPayableAmount = Math.max(
        0,
        subtotal -
          Number(order.discountAmount || 0) -
          Number(order.walletCreditAppliedAmount || 0) +
          shippingCharge,
      );
      order.codCollectAmount = Math.max(
        0,
        order.totalPayableAmount - Number(order.paidTransferAmount || 0),
      );
      order.estimatedNetProfitAmount =
        order.totalPayableAmount - totalCogs - Number(order.shippingFeeCarrierEstimated || 0);
    }

    if (params.dto.codCollectAmount !== undefined) {
      order.codCollectAmount = Number(params.dto.codCollectAmount);
    }

    const saved = await this.orderRepo.save(order);
    const afterSnapshot = this.buildRevisionSnapshot(saved);

    const revision = await this.appendOrderRevision({
      shopId: params.shopId,
      order: saved,
      actorUserId: params.actorUserId,
      actorName: params.actorName,
      actionType: 'MODIFY_CONFIRMED_ORDER',
      reasonNote: params.dto.reasonNote,
      beforeSnapshot,
      afterSnapshot,
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
        ...afterSnapshot,
        reasonNote: params.dto.reasonNote,
      },
    });

    return { order: saved, revision };
  }

  public async dispatchOrdersToCarrierBatch(params: {
    shopId: string;
    actorUserId: string;
    actorName: string;
    dto: DispatchCarrierBatchDto;
  }) {
    const orders = await this.orderRepo.find({
      where: { shopId: params.shopId, id: In(params.dto.orderIds) },
    });

    const succeeded: Array<{ orderId: string; orderCode: string; trackingNumber: string }> = [];
    const failed: Array<{ orderId: string; reason: string }> = [];

    for (const order of orders) {
      if (
        order.status !== PosOrderStatusEnum.CONFIRMED &&
        order.status !== PosOrderStatusEnum.WAITING_PACKING
      ) {
        failed.push({
          orderId: order.id,
          reason: `Trạng thái ${order.status} không đủ điều kiện đẩy vận đơn 3PL`,
        });
        continue;
      }

      const carrier = params.dto.overrideCarrierCode || order.carrierCode;
      if (carrier === 'COUNTER_PICKUP') {
        failed.push({
          orderId: order.id,
          reason: 'Đơn mua tại quầy không cần đẩy hãng vận chuyển',
        });
        continue;
      }

      const beforeSnapshot = this.buildRevisionSnapshot(order);
      order.carrierCode = carrier;
      if (!order.trackingNumber) {
        const suffix = `${Date.now().toString().slice(-6)}${Math.floor(100 + Math.random() * 899)}`;
        order.trackingNumber = `${carrier}${suffix}`;
      }
      if (!Number(order.shippingFeeCarrierEstimated)) {
        order.shippingFeeCarrierEstimated = Number(order.shippingFeeAmount || 25000);
      }
      order.status = PosOrderStatusEnum.WAITING_PACKING;
      order.lastCarrierEventAt = new Date();

      const saved = await this.orderRepo.save(order);

      await this.carrierEventRepo.save(
        this.carrierEventRepo.create({
          shopId: params.shopId,
          orderId: saved.id,
          orderCode: saved.orderCode,
          carrierCode: saved.carrierCode,
          trackingNumber: saved.trackingNumber!,
          carrierRawStatus: 'ready_to_pick',
          mappedOmsStatus: PosOrderStatusEnum.WAITING_PACKING,
          description: `Đã sinh mã vận đơn ${saved.trackingNumber} trên ${saved.carrierCode}, chờ kho quét Barcode đóng gói.`,
          eventSource: 'SYSTEM',
          eventOccurredAt: new Date(),
        }),
      );

      await this.appendOrderRevision({
        shopId: params.shopId,
        order: saved,
        actorUserId: params.actorUserId,
        actorName: params.actorName,
        actionType: 'DISPATCH_3PL_CARRIER',
        reasonNote: `Đẩy vận đơn sang ${saved.carrierCode} (${saved.trackingNumber})`,
        beforeSnapshot,
        afterSnapshot: this.buildRevisionSnapshot(saved),
      });

      succeeded.push({
        orderId: saved.id,
        orderCode: saved.orderCode,
        trackingNumber: saved.trackingNumber!,
      });
    }

    return { succeeded, failed };
  }

  public async appendOrderRevision(params: {
    shopId: string;
    order: PosOrderEntity;
    actorUserId: string;
    actorName: string;
    actionType: string;
    reasonNote?: string | null;
    beforeSnapshot: Record<string, unknown>;
    afterSnapshot: Record<string, unknown>;
  }): Promise<OrderRevisionHistoryEntity> {
    const latest = await this.revisionRepo.findOne({
      where: { shopId: params.shopId, orderId: params.order.id },
      order: { revisionNumber: 'DESC' },
    });
    const nextRevisionNumber = (latest?.revisionNumber || 0) + 1;
    const diffSummary = this.computeDiffSummary(params.beforeSnapshot, params.afterSnapshot);

    return this.revisionRepo.save(
      this.revisionRepo.create({
        shopId: params.shopId,
        orderId: params.order.id,
        orderCode: params.order.orderCode,
        revisionNumber: nextRevisionNumber,
        changedByUserId: params.actorUserId,
        changedByName: params.actorName,
        actionType: params.actionType,
        reasonNote: params.reasonNote || null,
        beforeSnapshotJson: params.beforeSnapshot,
        afterSnapshotJson: params.afterSnapshot,
        diffSummaryJson: diffSummary,
      }),
    );
  }

  public buildRevisionSnapshot(order: PosOrderEntity): Record<string, unknown> {
    return {
      status: order.status,
      customerName: order.customerName,
      receiverAddressLine: order.receiverAddressLine,
      carrierCode: order.carrierCode,
      trackingNumber: order.trackingNumber,
      subtotalAmount: Number(order.subtotalAmount || 0),
      shippingFeeAmount: Number(order.shippingFeeAmount || 0),
      totalPayableAmount: Number(order.totalPayableAmount || 0),
      codCollectAmount: Number(order.codCollectAmount || 0),
      totalWeightGrams: Number(order.totalWeightGrams || 0),
      actualPackedWeightGrams: order.actualPackedWeightGrams,
      printedCount: order.printedCount,
      note: order.note,
      itemsSummary: (order.itemsJson || []).map((i) => ({
        skuCode: i.skuCode,
        quantity: i.quantity,
        finalUnitPrice: i.finalUnitPrice,
      })),
    };
  }

  private computeDiffSummary(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): OrderFieldDiffEntry[] {
    const labelMap: Record<string, string> = {
      status: 'Trạng thái đơn hàng',
      customerName: 'Tên người nhận',
      receiverAddressLine: 'Địa chỉ giao hàng',
      carrierCode: 'Hãng vận chuyển',
      trackingNumber: 'Mã vận đơn',
      subtotalAmount: 'Tạm tính hàng hóa',
      shippingFeeAmount: 'Phí vận chuyển khách trả',
      totalPayableAmount: 'Tổng tiền đơn hàng',
      codCollectAmount: 'Tiền thu hộ COD',
      totalWeightGrams: 'Khối lượng khai báo (g)',
      actualPackedWeightGrams: 'Khối lượng cân thực tế (g)',
      printedCount: 'Số lần in phiếu',
      note: 'Ghi chú đơn hàng',
      itemsSummary: 'Danh sách sản phẩm',
    };

    const diffs: OrderFieldDiffEntry[] = [];
    for (const key of Object.keys(after)) {
      const bVal = before[key];
      const aVal = after[key];
      if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
        diffs.push({
          field: key,
          label: labelMap[key] || key,
          beforeValue: bVal,
          afterValue: aVal,
        });
      }
    }
    return diffs;
  }

  private async deductOnHandStockUponCarrierPickup(
    order: PosOrderEntity,
    actorUserId: string,
  ): Promise<void> {
    for (const item of order.itemsJson || []) {
      const stock = await this.stockRepo.findOne({
        where: {
          shopId: order.shopId,
          warehouseId: item.warehouseId || order.warehouseId,
          variantId: item.variantId,
        },
      });
      if (!stock) continue;

      const beforeOnHandQty = Number(stock.onHandQty || 0);
      const beforeReservedQty = Number(stock.reservedQty || 0);
      const beforeAvailableQty = Number(stock.availableQty || 0);

      stock.onHandQty = Math.max(0, beforeOnHandQty - item.quantity);
      stock.reservedQty = Math.max(0, beforeReservedQty - item.quantity);
      stock.availableQty = Math.max(0, stock.onHandQty - stock.reservedQty);
      await this.stockRepo.save(stock);

      await this.inventoryService.appendInventoryLedger({
        shopId: order.shopId,
        warehouseId: stock.warehouseId,
        variantId: stock.variantId,
        skuCode: item.skuCode,
        movementType: InventoryMovementTypeEnum.ORDER_SHIP,
        deltaQty: -item.quantity,
        beforeOnHandQty,
        afterOnHandQty: stock.onHandQty,
        beforeReservedQty,
        afterReservedQty: stock.reservedQty,
        beforeAvailableQty,
        afterAvailableQty: stock.availableQty,
        costPrice: Number(item.costPrice || 0),
        referenceType: 'POS_ORDER',
        referenceId: order.id,
        note: `Bưu tá đã lấy hàng đơn ${order.orderCode} (${order.trackingNumber || order.carrierCode})`,
        actorUserId,
      });
    }
  }

  private async releaseReservedStockOnCancel(
    order: PosOrderEntity,
    actorUserId: string,
  ): Promise<void> {
    for (const item of order.itemsJson || []) {
      const warehouseId = item.warehouseId || order.warehouseId;

      if (order.reservationCartId) {
        try {
          await this.inventoryService.releaseStockReservationAtomic({
            shopId: order.shopId,
            actorUserId,
            dto: {
              draftCartId: order.reservationCartId,
              warehouseId,
              variantId: item.variantId,
              quantity: item.quantity,
            },
          });
          continue;
        } catch {
          // Fallback cập nhật trực tiếp DB nếu key giữ chỗ Redis đã hết TTL
        }
      }

      const stock = await this.stockRepo.findOne({
        where: {
          shopId: order.shopId,
          warehouseId,
          variantId: item.variantId,
        },
      });
      if (!stock) continue;

      const beforeOnHandQty = Number(stock.onHandQty || 0);
      const beforeReservedQty = Number(stock.reservedQty || 0);
      const beforeAvailableQty = Number(stock.availableQty || 0);

      if (beforeReservedQty > 0) {
        const releasedQty = Math.min(beforeReservedQty, item.quantity);
        stock.reservedQty = Math.max(0, beforeReservedQty - releasedQty);
        stock.availableQty = Math.max(0, beforeOnHandQty - stock.reservedQty);
        await this.stockRepo.save(stock);

        await this.inventoryService.appendInventoryLedger({
          shopId: order.shopId,
          warehouseId: stock.warehouseId,
          variantId: stock.variantId,
          skuCode: item.skuCode,
          movementType: InventoryMovementTypeEnum.POS_RELEASE,
          deltaQty: releasedQty,
          beforeOnHandQty,
          afterOnHandQty: beforeOnHandQty,
          beforeReservedQty,
          afterReservedQty: stock.reservedQty,
          beforeAvailableQty,
          afterAvailableQty: stock.availableQty,
          costPrice: Number(item.costPrice || 0),
          referenceType: 'POS_ORDER',
          referenceId: order.id,
          note: `Giải phóng giữ chỗ do hủy đơn ${order.orderCode}`,
          actorUserId,
        });
      }
    }
  }
}
