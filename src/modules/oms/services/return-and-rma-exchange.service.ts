import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  CustomerWalletLedgerTypeEnum,
  CustomerWalletTransactionTypeEnum,
  InventoryMovementTypeEnum,
  OmsReturnConditionEnum,
  OmsRmaStatusEnum,
  OmsRmaTypeEnum,
  PosOrderPaymentMethodEnum,
  PosOrderPaymentStatusEnum,
  PosOrderStatusEnum,
  PosOrderTypeEnum,
  ProductSerialStatusEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { CreateRmaExchangeDto, VerifyReturnedOrderDto } from 'src/dto/oms/oms-fulfillment.dto';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { CustomerWalletLedgerEntity } from 'src/entity/customer-wallet-ledger.entity';
import {
  OrderRmaExchangeEntity,
  RmaOutboundLineItem,
  RmaReturnLineItem,
} from 'src/entity/order-rma-exchange.entity';
import { PosOrderEntity, PosOrderLineItem } from 'src/entity/pos-order.entity';
import { ProductSerialItemEntity } from 'src/entity/product-serial-item.entity';
import { ProductVariantEntity } from 'src/entity/product-variant.entity';
import { WarehouseStockItemEntity } from 'src/entity/warehouse-stock-item.entity';
import { AtomicInventoryAndTransferService } from 'src/modules/catalog-pos/services/atomic-inventory-and-transfer.service';
import { Brackets, In, Repository } from 'typeorm';

import { OmsStateMachineService } from './oms-state-machine.service';

@Injectable()
export class ReturnAndRmaExchangeService {
  constructor(
    @InjectRepository(PosOrderEntity)
    private readonly orderRepo: Repository<PosOrderEntity>,
    @InjectRepository(OrderRmaExchangeEntity)
    private readonly rmaRepo: Repository<OrderRmaExchangeEntity>,
    @InjectRepository(WarehouseStockItemEntity)
    private readonly stockRepo: Repository<WarehouseStockItemEntity>,
    @InjectRepository(ProductVariantEntity)
    private readonly variantRepo: Repository<ProductVariantEntity>,
    @InjectRepository(ProductSerialItemEntity)
    private readonly serialRepo: Repository<ProductSerialItemEntity>,
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(CustomerWalletLedgerEntity)
    private readonly walletLedgerRepo: Repository<CustomerWalletLedgerEntity>,
    @InjectRedis()
    private readonly redis: Redis,
    private readonly inventoryService: AtomicInventoryAndTransferService,
    private readonly stateMachineService: OmsStateMachineService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  public async lookupReturningOrderByBarcode(shopId: string, code: string) {
    const trimmed = code.trim();
    const order = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.shopId = :shopId', { shopId })
      .andWhere(
        new Brackets((b) => {
          b.where('o.trackingNumber = :code', { code: trimmed }).orWhere('o.orderCode = :code', {
            code: trimmed,
          });
        }),
      )
      .getOne();

    if (!order) {
      throw new NotFoundException(`Không tìm thấy vận đơn hoàn với mã "${trimmed}"`);
    }

    if (
      order.status !== PosOrderStatusEnum.RETURNING &&
      order.status !== PosOrderStatusEnum.DELIVERY_FAILED_RESCUE
    ) {
      throw new BadRequestException(
        `Đơn ${order.orderCode} hiện ở trạng thái ${order.status}, không thuộc danh sách chờ nhận hàng hoàn.`,
      );
    }

    return order;
  }

  public async verifyAndRestockReturnedOrder(params: {
    shopId: string;
    orderId: string;
    actorUserId: string;
    actorName: string;
    dto: VerifyReturnedOrderDto;
  }) {
    const order = await this.orderRepo.findOne({
      where: { id: params.orderId, shopId: params.shopId },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng hoàn');
    }

    if (
      order.status !== PosOrderStatusEnum.RETURNING &&
      order.status !== PosOrderStatusEnum.DELIVERY_FAILED_RESCUE
    ) {
      throw new BadRequestException(
        `Đơn ${order.orderCode} đang ở trạng thái ${order.status}, không thể đồng kiểm hoàn.`,
      );
    }

    const orderItemMap = new Map((order.itemsJson || []).map((i) => [i.variantId, i]));
    const inspectedItems: RmaReturnLineItem[] = [];
    let hasDamagedOrMissing = false;
    let totalRestockedUnits = 0;
    let totalDefectiveUnits = 0;

    for (const checkItem of params.dto.items) {
      const originalLine = orderItemMap.get(checkItem.variantId);
      if (!originalLine) {
        throw new BadRequestException(
          `Biến thể ${checkItem.variantId} không thuộc đơn ${order.orderCode}`,
        );
      }

      if (checkItem.verifiedQty < 0 || checkItem.verifiedQty > originalLine.quantity) {
        throw new BadRequestException(
          `Số lượng kiểm hoàn (${checkItem.verifiedQty}) của SKU ${originalLine.skuCode} vượt quá số lượng đã xuất (${originalLine.quantity}).`,
        );
      }

      const warehouseId = originalLine.warehouseId || order.warehouseId;
      const stock = await this.stockRepo.findOne({
        where: { shopId: params.shopId, warehouseId, variantId: checkItem.variantId },
      });

      if (
        checkItem.condition === OmsReturnConditionEnum.GOOD_RESTOCK &&
        checkItem.verifiedQty > 0
      ) {
        totalRestockedUnits += checkItem.verifiedQty;
        if (stock) {
          const beforeOnHandQty = Number(stock.onHandQty || 0);
          const beforeReservedQty = Number(stock.reservedQty || 0);
          const beforeAvailableQty = Number(stock.availableQty || 0);

          stock.onHandQty = beforeOnHandQty + checkItem.verifiedQty;
          stock.availableQty = Math.max(0, stock.onHandQty - beforeReservedQty);
          await this.stockRepo.save(stock);

          // Đồng bộ lại Redis stock để In-Chat POS Lua nhận diện ngay tồn vừa nhập hoàn
          await this.redis
            .hset(`inv:stock:${params.shopId}:${warehouseId}:${checkItem.variantId}`, {
              onHandQty: String(stock.onHandQty),
              reservedQty: String(stock.reservedQty),
              availableQty: String(stock.availableQty),
            })
            .catch(() => null);

          await this.inventoryService.appendInventoryLedger({
            shopId: params.shopId,
            warehouseId,
            variantId: checkItem.variantId,
            skuCode: originalLine.skuCode,
            movementType: InventoryMovementTypeEnum.RETURN_RESTOCK,
            deltaQty: checkItem.verifiedQty,
            beforeOnHandQty,
            afterOnHandQty: stock.onHandQty,
            beforeReservedQty,
            afterReservedQty: stock.reservedQty,
            beforeAvailableQty,
            afterAvailableQty: stock.availableQty,
            costPrice: Number(originalLine.costPrice || 0),
            referenceType: 'POS_ORDER_RETURN',
            referenceId: order.id,
            note: `Đồng kiểm hoàn nguyên vẹn đơn ${order.orderCode}`,
            actorUserId: params.actorUserId,
          });
        }

        if (checkItem.serialNumbers?.length) {
          await this.serialRepo.update(
            { shopId: params.shopId, serialNumber: In(checkItem.serialNumbers) },
            {
              status: ProductSerialStatusEnum.IN_STOCK,
              soldOrderId: null,
              soldOrderCode: null,
              customerId: null,
            },
          );
        }
      } else {
        hasDamagedOrMissing = true;
        if (
          checkItem.condition === OmsReturnConditionEnum.DAMAGED_OR_SWAPPED &&
          checkItem.verifiedQty > 0
        ) {
          totalDefectiveUnits += checkItem.verifiedQty;
          if (stock) {
            const beforeOnHandQty = Number(stock.onHandQty || 0);
            const beforeReservedQty = Number(stock.reservedQty || 0);
            const beforeAvailableQty = Number(stock.availableQty || 0);
            const beforeDefectiveQty = Number(stock.defectiveHoldQty || 0);

            stock.defectiveHoldQty = beforeDefectiveQty + checkItem.verifiedQty;
            await this.stockRepo.save(stock);

            await this.inventoryService.appendInventoryLedger({
              shopId: params.shopId,
              warehouseId,
              variantId: checkItem.variantId,
              skuCode: originalLine.skuCode,
              movementType: InventoryMovementTypeEnum.DEFECTIVE_HOLD,
              deltaQty: checkItem.verifiedQty,
              beforeOnHandQty,
              afterOnHandQty: beforeOnHandQty,
              beforeReservedQty,
              afterReservedQty: beforeReservedQty,
              beforeAvailableQty,
              afterAvailableQty: beforeAvailableQty,
              costPrice: Number(originalLine.costPrice || 0),
              referenceType: 'POS_ORDER_RETURN_DEFECTIVE',
              referenceId: order.id,
              note: `Hàng hoàn hỏng/bị tráo đơn ${order.orderCode}: ${checkItem.inspectionNote || ''}`,
              actorUserId: params.actorUserId,
            });
          }

          if (checkItem.serialNumbers?.length) {
            await this.serialRepo.update(
              { shopId: params.shopId, serialNumber: In(checkItem.serialNumbers) },
              { status: ProductSerialStatusEnum.DEFECTIVE },
            );
          }
        }
      }

      inspectedItems.push({
        variantId: originalLine.variantId,
        skuCode: originalLine.skuCode,
        barcode: originalLine.barcode,
        variantName: originalLine.variantName,
        expectedQty: originalLine.quantity,
        verifiedQty: checkItem.verifiedQty,
        unitPrice: originalLine.finalUnitPrice,
        condition: checkItem.condition,
        serialNumbers: checkItem.serialNumbers || [],
        evidenceImageUrls: checkItem.evidenceImageUrls || [],
        inspectionNote: checkItem.inspectionNote || null,
      });
    }

    const carrierClaimCode =
      hasDamagedOrMissing && params.dto.createCarrierCompensationClaim
        ? `CLM-${order.carrierCode}-${Date.now().toString().slice(-6)}`
        : null;

    if (order.status === PosOrderStatusEnum.DELIVERY_FAILED_RESCUE) {
      order.status = PosOrderStatusEnum.RETURNING;
      await this.orderRepo.save(order);
    }

    const updatedOrder = await this.stateMachineService.transitionOrderStatus({
      shopId: params.shopId,
      orderId: order.id,
      actorUserId: params.actorUserId,
      actorName: params.actorName,
      dto: {
        targetStatus: PosOrderStatusEnum.RETURNED_RESTOCKED,
        reasonNote: `Đã quét Barcode đồng kiểm hoàn: Nhập lại ${totalRestockedUnits} SP tốt, ${totalDefectiveUnits} SP lỗi/tráo. ${carrierClaimCode ? `Hồ sơ khiếu nại: ${carrierClaimCode}` : ''}`,
      },
      bypassReturnVerificationGuard: true,
    });

    if (updatedOrder.customerId) {
      const customer = await this.customerRepo.findOne({
        where: { id: updatedOrder.customerId, shopId: params.shopId },
      });
      if (customer) {
        customer.returnedOrdersCount = Number(customer.returnedOrdersCount || 0) + 1;
        const okOrders = Number(customer.successfulDeliveriesCount || 0);
        const retOrders = Number(customer.returnedOrdersCount || 0);
        const penalty = customer.isBlacklisted ? 45 : 0;
        customer.deliveryTrustScore = Math.max(
          0,
          Math.min(
            100,
            Math.round(((okOrders + 1) / (okOrders + retOrders * 2.5 + 1)) * 100) - penalty,
          ),
        );
        await this.customerRepo.save(customer);
      }
    }

    const rmaAuditRecord = await this.rmaRepo.save(
      this.rmaRepo.create({
        shopId: params.shopId,
        rmaCode: `RET-${Date.now().toString().slice(-7)}`,
        rmaType: OmsRmaTypeEnum.PARTIAL_RETURN,
        status: hasDamagedOrMissing ? OmsRmaStatusEnum.CLAIM_DISPUTED : OmsRmaStatusEnum.COMPLETED,
        originalOrderId: updatedOrder.id,
        originalOrderCode: updatedOrder.orderCode,
        customerId: updatedOrder.customerId,
        customerName: updatedOrder.customerName,
        warehouseId: updatedOrder.warehouseId,
        returnItemsJson: inspectedItems,
        outboundItemsJson: [],
        returnItemsTotalAmount: inspectedItems.reduce(
          (sum, i) => sum + i.unitPrice * i.verifiedQty,
          0,
        ),
        outboundItemsTotalAmount: 0,
        rmaShippingFeeCustomerCharged: 0,
        codDeltaAmount: 0,
        refundToWalletCredit: false,
        reasonNote: params.dto.overallNote || null,
        carrierClaimCode,
        verifiedByUserId: params.actorUserId,
        verifiedAt: new Date(),
      }),
    );

    return {
      order: updatedOrder,
      verificationRecord: rmaAuditRecord,
      summary: {
        totalRestockedUnits,
        totalDefectiveUnits,
        carrierClaimCode,
      },
    };
  }

  public async createTwoWayRmaExchange(params: {
    shopId: string;
    actorUserId: string;
    actorName: string;
    dto: CreateRmaExchangeDto;
  }) {
    const originalOrder = await this.orderRepo.findOne({
      where: { id: params.dto.originalOrderId, shopId: params.shopId },
    });
    if (!originalOrder) {
      throw new NotFoundException('Không tìm thấy đơn hàng gốc để tạo phiếu đổi trả RMA');
    }

    const originalLineMap = new Map((originalOrder.itemsJson || []).map((i) => [i.variantId, i]));
    const returnItems: RmaReturnLineItem[] = [];
    let returnItemsTotalAmount = 0;

    for (const rItem of params.dto.returnItems) {
      const origLine = originalLineMap.get(rItem.variantId);
      if (!origLine) {
        throw new BadRequestException(`Biến thể ${rItem.variantId} không có trong đơn gốc`);
      }
      if (rItem.quantity > origLine.quantity) {
        throw new BadRequestException(
          `Số lượng thu hồi (${rItem.quantity}) vượt quá số lượng đã mua (${origLine.quantity}) của SKU ${origLine.skuCode}`,
        );
      }

      returnItemsTotalAmount += Number(origLine.finalUnitPrice) * rItem.quantity;
      returnItems.push({
        variantId: origLine.variantId,
        skuCode: origLine.skuCode,
        barcode: origLine.barcode,
        variantName: origLine.variantName,
        expectedQty: rItem.quantity,
        verifiedQty: 0,
        unitPrice: Number(origLine.finalUnitPrice),
        condition: rItem.expectedCondition || OmsReturnConditionEnum.GOOD_RESTOCK,
      });
    }

    const outboundItems: RmaOutboundLineItem[] = [];
    const exchangeOrderLineItems: PosOrderLineItem[] = [];
    let outboundItemsTotalAmount = 0;
    let outboundTotalWeightGrams = 0;
    let outboundCogsTotal = 0;

    const outboundInputs = params.dto.outboundItems || [];
    const rmaCartId = `rma_cart_${Date.now()}`;

    if (outboundInputs.length > 0) {
      const variantIds = outboundInputs.map((i) => i.variantId);
      const variants = await this.variantRepo.find({
        where: { shopId: params.shopId, id: In(variantIds) },
      });
      const variantMap = new Map(variants.map((v) => [v.id, v]));

      for (const outInput of outboundInputs) {
        const variant = variantMap.get(outInput.variantId);
        if (!variant) {
          throw new BadRequestException(`Biến thể đổi mới ${outInput.variantId} không tồn tại`);
        }

        const warehouseId = outInput.warehouseId || originalOrder.warehouseId;

        await this.inventoryService.reserveStockAtomicWithRedisLua({
          shopId: params.shopId,
          actorUserId: params.actorUserId,
          dto: {
            draftCartId: rmaCartId,
            warehouseId,
            variantId: variant.id,
            quantity: outInput.quantity,
          },
        });

        const unitPrice = Number(variant.retailPrice || 0);
        const lineTotal = unitPrice * outInput.quantity;
        outboundItemsTotalAmount += lineTotal;
        outboundTotalWeightGrams += Number(variant.weightGrams || 250) * outInput.quantity;
        outboundCogsTotal += Number(variant.costPrice || 0) * outInput.quantity;

        outboundItems.push({
          variantId: variant.id,
          skuCode: variant.skuCode,
          barcode: variant.barcode || variant.skuCode,
          variantName: variant.variantName,
          quantity: outInput.quantity,
          unitPrice,
          weightGrams: Number(variant.weightGrams || 250),
          warehouseId,
        });

        exchangeOrderLineItems.push({
          variantId: variant.id,
          productId: variant.productId,
          skuCode: variant.skuCode,
          barcode: variant.barcode || variant.skuCode,
          variantName: variant.variantName,
          imageUrl: variant.imageUrl || null,
          quantity: outInput.quantity,
          retailPrice: unitPrice,
          discountPercent: 0,
          discountAmount: 0,
          finalUnitPrice: unitPrice,
          lineTotalAmount: lineTotal,
          costPrice: Number(variant.costPrice || 0),
          weightGrams: Number(variant.weightGrams || 250),
          isBundleBom: Boolean(variant.isBundleBom),
          isFreeGift: false,
          warehouseId,
          warehouseName: originalOrder.warehouseName,
          packedScannedQty: 0,
          requiresSerialImei: Boolean(variant.requiresSerialImei),
        });
      }
    }

    const rmaShipFee = Number(params.dto.rmaShippingFeeCustomerCharged || 0);
    const codDeltaAmount = outboundItemsTotalAmount - returnItemsTotalAmount + rmaShipFee;

    let createdExchangeOrder: PosOrderEntity | null = null;
    if (exchangeOrderLineItems.length > 0) {
      const exchangeOrderCode = `${originalOrder.orderCode}-RMA${Date.now().toString().slice(-3)}`;
      createdExchangeOrder = await this.orderRepo.save(
        this.orderRepo.create({
          shopId: params.shopId,
          orderCode: exchangeOrderCode,
          orderType:
            params.dto.rmaType === OmsRmaTypeEnum.WARRANTY_REPAIR
              ? PosOrderTypeEnum.WARRANTY_REPLACEMENT
              : PosOrderTypeEnum.RMA_EXCHANGE,
          parentOrderId: originalOrder.id,
          conversationId: originalOrder.conversationId,
          customerId: originalOrder.customerId,
          customerName: originalOrder.customerName,
          customerPhoneMasked: originalOrder.customerPhoneMasked,
          customerPhoneEncrypted: originalOrder.customerPhoneEncrypted,
          channelType: originalOrder.channelType,
          pageShortCode: originalOrder.pageShortCode,
          warehouseId: originalOrder.warehouseId,
          warehouseName: originalOrder.warehouseName,
          status: PosOrderStatusEnum.CONFIRMED,
          addressTierMode: originalOrder.addressTierMode,
          receiverProvinceCode: originalOrder.receiverProvinceCode,
          receiverProvinceName: originalOrder.receiverProvinceName,
          receiverDistrictCode: originalOrder.receiverDistrictCode,
          receiverDistrictName: originalOrder.receiverDistrictName,
          receiverWardCode: originalOrder.receiverWardCode,
          receiverWardName: originalOrder.receiverWardName,
          receiverHamletCode: originalOrder.receiverHamletCode,
          receiverHamletName: originalOrder.receiverHamletName,
          receiverAddressLine: originalOrder.receiverAddressLine,
          fullThreeTierAddress: originalOrder.fullThreeTierAddress,
          fullFourTierAddress: originalOrder.fullFourTierAddress,
          itemsJson: exchangeOrderLineItems,
          totalWeightGrams: Math.max(100, outboundTotalWeightGrams),
          carrierCode: originalOrder.carrierCode,
          carrierServiceName: 'Đổi hàng 2 chiều (Giao mới - Thu cũ)',
          shippingFeeAmount: rmaShipFee,
          shippingFeeCarrierEstimated: Math.max(25000, rmaShipFee),
          isFreeShippingForCustomer: rmaShipFee === 0,
          isTwoWayExchange: params.dto.rmaType === OmsRmaTypeEnum.EXCHANGE_2_WAY,
          subtotalAmount: outboundItemsTotalAmount,
          totalPayableAmount: Math.max(0, codDeltaAmount),
          codCollectAmount: Math.max(0, codDeltaAmount),
          cogsSnapshotAmount: outboundCogsTotal,
          estimatedNetProfitAmount: Math.max(0, codDeltaAmount) - outboundCogsTotal,
          paymentMethod: PosOrderPaymentMethodEnum.COD,
          paymentStatus:
            codDeltaAmount <= 0
              ? PosOrderPaymentStatusEnum.PAID_IN_FULL
              : PosOrderPaymentStatusEnum.UNPAID,
          reservationCartId: rmaCartId,
          note: `[RMA 2 CHIỀU từ ${originalOrder.orderCode}] Thu hồi: ${returnItems
            .map((i) => `${i.skuCode} x${i.expectedQty}`)
            .join(', ')}. ${params.dto.reasonNote || ''}`,
          createdByUserId: params.actorUserId,
        }),
      );
    }

    if (codDeltaAmount < 0 && params.dto.refundNegativeDeltaToWallet && originalOrder.customerId) {
      const refundCredit = Math.abs(codDeltaAmount);
      const customer = await this.customerRepo.findOne({
        where: { id: originalOrder.customerId, shopId: params.shopId },
      });
      if (customer) {
        const balanceBefore = Number(customer.walletCreditBalance || 0);
        customer.walletCreditBalance = balanceBefore + refundCredit;
        await this.customerRepo.save(customer);

        const walletEntry = this.walletLedgerRepo.create({
          shopId: params.shopId,
          customerId: customer.id,
          ledgerType: CustomerWalletLedgerTypeEnum.WALLET_CREDIT,
          transactionType: CustomerWalletTransactionTypeEnum.RMA_REFUND_CREDIT,
          deltaAmount: refundCredit,
          balanceAfter: customer.walletCreditBalance,
          referenceOrderId: originalOrder.id,
          note: `Hoàn tiền chênh lệch đổi trả RMA từ đơn ${originalOrder.orderCode}`,
          actorUserId: params.actorUserId,
        });
        await this.walletLedgerRepo.save(walletEntry);
      }
    }

    const rmaRecord = await this.rmaRepo.save(
      this.rmaRepo.create({
        shopId: params.shopId,
        rmaCode: `RMA-${Date.now().toString().slice(-7)}`,
        rmaType: params.dto.rmaType,
        status: createdExchangeOrder
          ? OmsRmaStatusEnum.PENDING_DISPATCH
          : OmsRmaStatusEnum.RETURN_AWAITING_INSPECTION,
        originalOrderId: originalOrder.id,
        originalOrderCode: originalOrder.orderCode,
        exchangeOrderId: createdExchangeOrder?.id || null,
        exchangeOrderCode: createdExchangeOrder?.orderCode || null,
        customerId: originalOrder.customerId,
        customerName: originalOrder.customerName,
        warehouseId: originalOrder.warehouseId,
        returnItemsJson: returnItems,
        outboundItemsJson: outboundItems,
        returnItemsTotalAmount,
        outboundItemsTotalAmount,
        rmaShippingFeeCustomerCharged: rmaShipFee,
        codDeltaAmount,
        refundToWalletCredit: Boolean(params.dto.refundNegativeDeltaToWallet),
        reasonNote: params.dto.reasonNote || null,
      }),
    );

    this.realtimeEmitter.emitToRoom(
      SOCKET_CONFIG.namespaces.CHAT,
      `shop:${params.shopId}`,
      'oms:rma_exchange_created',
      {
        shopId: params.shopId,
        rmaId: rmaRecord.id,
        rmaCode: rmaRecord.rmaCode,
        originalOrderCode: originalOrder.orderCode,
        exchangeOrderCode: createdExchangeOrder?.orderCode || null,
        codDeltaAmount,
      },
    );

    return {
      rma: rmaRecord,
      exchangeOrder: createdExchangeOrder,
    };
  }

  public async listRmaExchanges(shopId: string) {
    return this.rmaRepo.find({
      where: { shopId },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }
}
