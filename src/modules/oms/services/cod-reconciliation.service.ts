import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  CodReconciliationBatchStatusEnum,
  CodReconciliationDiscrepancyTypeEnum,
  CustomerTierEnum,
  CustomerWalletLedgerTypeEnum,
  CustomerWalletTransactionTypeEnum,
  PosOrderStatusEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  ConfirmCodReconciliationBatchDto,
  CreateCodReconciliationBatchDto,
  ListCodReconciliationItemsQueryDto,
} from 'src/dto/oms/oms-fulfillment.dto';
import { CodReconciliationBatchEntity } from 'src/entity/cod-reconciliation-batch.entity';
import { CodReconciliationItemEntity } from 'src/entity/cod-reconciliation-item.entity';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { CustomerWalletLedgerEntity } from 'src/entity/customer-wallet-ledger.entity';
import { PosOrderEntity } from 'src/entity/pos-order.entity';
import { FindOptionsWhere, In, Repository } from 'typeorm';

@Injectable()
export class CodReconciliationService {
  constructor(
    @InjectRepository(CodReconciliationBatchEntity)
    private readonly batchRepo: Repository<CodReconciliationBatchEntity>,
    @InjectRepository(CodReconciliationItemEntity)
    private readonly itemRepo: Repository<CodReconciliationItemEntity>,
    @InjectRepository(PosOrderEntity)
    private readonly orderRepo: Repository<PosOrderEntity>,
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(CustomerWalletLedgerEntity)
    private readonly walletLedgerRepo: Repository<CustomerWalletLedgerEntity>,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  public async createAndAnalyzeReconciliationBatch(params: {
    shopId: string;
    actorUserId: string;
    dto: CreateCodReconciliationBatchDto;
  }) {
    const weightTolerance = params.dto.weightToleranceGrams ?? 100;
    const feeTolerance = params.dto.feeToleranceVnd ?? 1000;

    const trackingNumbers = Array.from(
      new Set(params.dto.rows.map((r) => r.trackingNumber.trim()).filter(Boolean)),
    );
    const orderCodes = Array.from(
      new Set(params.dto.rows.map((r) => r.orderCode?.trim()).filter(Boolean) as string[]),
    );

    const matchedOrders = await this.orderRepo.find({
      where: [
        ...(trackingNumbers.length
          ? [{ shopId: params.shopId, trackingNumber: In(trackingNumbers) }]
          : []),
        ...(orderCodes.length ? [{ shopId: params.shopId, orderCode: In(orderCodes) }] : []),
      ],
    });

    const orderByTracking = new Map<string, PosOrderEntity>();
    const orderByCode = new Map<string, PosOrderEntity>();
    for (const order of matchedOrders) {
      if (order.trackingNumber) orderByTracking.set(order.trackingNumber.trim(), order);
      orderByCode.set(order.orderCode.trim(), order);
    }

    const batchCode = `REC-${params.dto.carrierCode}-${Date.now().toString().slice(-7)}`;
    const batch = await this.batchRepo.save(
      this.batchRepo.create({
        shopId: params.shopId,
        batchCode,
        carrierCode: params.dto.carrierCode,
        sourceFileName: params.dto.sourceFileName,
        status: CodReconciliationBatchStatusEnum.DRAFT_PARSED,
        note: params.dto.note || null,
      }),
    );

    const itemsToSave: CodReconciliationItemEntity[] = [];
    let matchedCount = 0;
    let discrepancyCount = 0;
    let expectedCodTotal = 0;
    let actualCodTotal = 0;
    let expectedShipTotal = 0;
    let actualShipTotal = 0;

    for (const row of params.dto.rows) {
      const tracking = row.trackingNumber.trim();
      const order =
        orderByTracking.get(tracking) ||
        (row.orderCode ? orderByCode.get(row.orderCode.trim()) : undefined);

      if (!order) {
        discrepancyCount += 1;
        actualCodTotal += Number(row.actualCodAmount || 0);
        actualShipTotal += Number(row.actualShippingFee || 0);
        itemsToSave.push(
          this.itemRepo.create({
            shopId: params.shopId,
            batchId: batch.id,
            orderId: null,
            orderCode: row.orderCode || null,
            trackingNumber: tracking,
            discrepancyType: CodReconciliationDiscrepancyTypeEnum.UNIDENTIFIED_TRACKING,
            expectedCodAmount: 0,
            actualCodAmount: Number(row.actualCodAmount || 0),
            codVarianceAmount: Number(row.actualCodAmount || 0),
            expectedShippingFee: 0,
            actualShippingFee: Number(row.actualShippingFee || 0),
            shippingFeeVarianceAmount: Number(row.actualShippingFee || 0),
            carrierChargedWeightGrams: row.carrierChargedWeightGrams ?? null,
            returnFeeCharged: Number(row.returnFeeCharged || 0),
            disputeNote: 'Mã vận đơn lạ không tồn tại trong hệ thống cửa hàng',
          }),
        );
        continue;
      }

      const expectedCod = Number(order.codCollectAmount || 0);
      const actualCod = Number(row.actualCodAmount || 0);
      const codVariance = actualCod - expectedCod;

      const expectedShip = Number(
        order.shippingFeeCarrierEstimated || order.shippingFeeAmount || 0,
      );
      const actualShip = Number(row.actualShippingFee || 0);
      const shipVariance = actualShip - expectedShip;

      const packedWeight = order.actualPackedWeightGrams ?? order.totalWeightGrams;
      const carrierWeight = row.carrierChargedWeightGrams ?? null;
      const returnFee = Number(row.returnFeeCharged || 0);

      let discrepancyType = CodReconciliationDiscrepancyTypeEnum.MATCHED;
      let disputeNote: string | null = null;

      if (codVariance < -1) {
        discrepancyType = CodReconciliationDiscrepancyTypeEnum.COD_SHORTFALL;
        disputeNote = `Thiếu tiền COD ${Math.abs(codVariance).toLocaleString('vi-VN')}đ (Hệ thống: ${expectedCod.toLocaleString('vi-VN')}đ vs ĐVVC trả: ${actualCod.toLocaleString('vi-VN')}đ)`;
      } else if (
        carrierWeight !== null &&
        packedWeight !== null &&
        carrierWeight - packedWeight > weightTolerance &&
        shipVariance > feeTolerance
      ) {
        discrepancyType = CodReconciliationDiscrepancyTypeEnum.WEIGHT_OVERCHARGE;
        disputeNote = `Đội cước cân nặng: Kho cân ${packedWeight}g nhưng ${params.dto.carrierCode} tính ${carrierWeight}g (+${carrierWeight - packedWeight}g), lệch cước +${shipVariance.toLocaleString('vi-VN')}đ`;
      } else if (
        returnFee > 0 &&
        (order.status === PosOrderStatusEnum.DELIVERED ||
          order.status === PosOrderStatusEnum.DELIVERED_RECONCILED)
      ) {
        discrepancyType = CodReconciliationDiscrepancyTypeEnum.RETURN_FEE_ERROR;
        disputeNote = `Đơn đã giao thành công nhưng ĐVVC vẫn trừ phí hoàn ${returnFee.toLocaleString('vi-VN')}đ`;
      } else if (shipVariance > feeTolerance) {
        discrepancyType = CodReconciliationDiscrepancyTypeEnum.WEIGHT_OVERCHARGE;
        disputeNote = `Phí ship thực trừ cao hơn dự kiến +${shipVariance.toLocaleString('vi-VN')}đ`;
      }

      if (discrepancyType === CodReconciliationDiscrepancyTypeEnum.MATCHED) {
        matchedCount += 1;
      } else {
        discrepancyCount += 1;
      }

      expectedCodTotal += expectedCod;
      actualCodTotal += actualCod;
      expectedShipTotal += expectedShip;
      actualShipTotal += actualShip + returnFee;

      itemsToSave.push(
        this.itemRepo.create({
          shopId: params.shopId,
          batchId: batch.id,
          orderId: order.id,
          orderCode: order.orderCode,
          trackingNumber: tracking,
          discrepancyType,
          expectedCodAmount: expectedCod,
          actualCodAmount: actualCod,
          codVarianceAmount: codVariance,
          expectedShippingFee: expectedShip,
          actualShippingFee: actualShip,
          shippingFeeVarianceAmount: shipVariance,
          actualPackedWeightGrams: packedWeight,
          carrierChargedWeightGrams: carrierWeight,
          returnFeeCharged: returnFee,
          disputeNote,
        }),
      );
    }

    await this.itemRepo.save(itemsToSave, { chunk: 200 });

    batch.totalOrdersCount = itemsToSave.length;
    batch.matchedOrdersCount = matchedCount;
    batch.discrepancyOrdersCount = discrepancyCount;
    batch.expectedCodTotal = expectedCodTotal;
    batch.actualCodTotal = actualCodTotal;
    batch.expectedShippingFeeTotal = expectedShipTotal;
    batch.actualShippingFeeTotal = actualShipTotal;
    batch.netSettlementAmount = actualCodTotal - actualShipTotal;

    const savedBatch = await this.batchRepo.save(batch);

    return {
      batch: savedBatch,
      breakdown: {
        matched: itemsToSave.filter(
          (i) => i.discrepancyType === CodReconciliationDiscrepancyTypeEnum.MATCHED,
        ).length,
        codShortfall: itemsToSave.filter(
          (i) => i.discrepancyType === CodReconciliationDiscrepancyTypeEnum.COD_SHORTFALL,
        ).length,
        weightOvercharge: itemsToSave.filter(
          (i) => i.discrepancyType === CodReconciliationDiscrepancyTypeEnum.WEIGHT_OVERCHARGE,
        ).length,
        returnFeeError: itemsToSave.filter(
          (i) => i.discrepancyType === CodReconciliationDiscrepancyTypeEnum.RETURN_FEE_ERROR,
        ).length,
        unidentified: itemsToSave.filter(
          (i) => i.discrepancyType === CodReconciliationDiscrepancyTypeEnum.UNIDENTIFIED_TRACKING,
        ).length,
      },
    };
  }

  public async listBatches(shopId: string) {
    return this.batchRepo.find({
      where: { shopId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  public async getBatchDetail(
    shopId: string,
    batchId: string,
    query: ListCodReconciliationItemsQueryDto,
  ) {
    const batch = await this.batchRepo.findOne({ where: { id: batchId, shopId } });
    if (!batch) {
      throw new NotFoundException('Không tìm thấy phiên đối soát COD');
    }

    const where: FindOptionsWhere<CodReconciliationItemEntity> = { shopId, batchId };
    if (query.discrepancyType) {
      where.discrepancyType = query.discrepancyType;
    }

    const items = await this.itemRepo.find({
      where,
      order: { discrepancyType: 'ASC', createdAt: 'ASC' },
    });

    return { batch, items };
  }

  public async confirmMatchedReconciliationItems(params: {
    shopId: string;
    batchId: string;
    actorUserId: string;
    dto: ConfirmCodReconciliationBatchDto;
  }) {
    const batch = await this.batchRepo.findOne({
      where: { id: params.batchId, shopId: params.shopId },
    });
    if (!batch) {
      throw new NotFoundException('Không tìm thấy phiên đối soát COD');
    }

    const targetItems = params.dto.itemIds?.length
      ? await this.itemRepo.find({
          where: {
            shopId: params.shopId,
            batchId: batch.id,
            id: In(params.dto.itemIds),
            isReconciled: false,
          },
        })
      : await this.itemRepo.find({
          where: {
            shopId: params.shopId,
            batchId: batch.id,
            discrepancyType: CodReconciliationDiscrepancyTypeEnum.MATCHED,
            isReconciled: false,
          },
        });

    if (targetItems.length === 0) {
      throw new BadRequestException('Không có vận đơn khớp nào chưa đối soát để xác nhận.');
    }

    const now = new Date();
    let settledOrdersCount = 0;
    let settledNetAmount = 0;

    for (const item of targetItems) {
      if (!item.orderId || item.isReconciled) continue;

      const order = await this.orderRepo.findOne({
        where: { id: item.orderId, shopId: params.shopId },
      });
      if (!order) continue;

      // Chống cộng trùng điểm thưởng / LTV nếu đơn đã tất toán trước đó ở phiên khác
      if (order.status === PosOrderStatusEnum.DELIVERED_RECONCILED) {
        item.isReconciled = true;
        await this.itemRepo.save(item);
        continue;
      }

      order.status = PosOrderStatusEnum.DELIVERED_RECONCILED;
      order.shippingFeeCarrierActual = Number(item.actualShippingFee);
      order.carrierChargedWeightGrams = item.carrierChargedWeightGrams;
      order.reconciledBatchId = batch.id;
      order.reconciledAt = now;
      await this.orderRepo.save(order);

      if (order.customerId) {
        const customer = await this.customerRepo.findOne({
          where: { id: order.customerId, shopId: params.shopId },
        });
        if (customer) {
          const earnedPoints = Math.floor(Number(order.totalPayableAmount || 0) / 10000);
          customer.successfulDeliveriesCount = Number(customer.successfulDeliveriesCount || 0) + 1;
          customer.lifetimeValueAmount =
            Number(customer.lifetimeValueAmount || 0) + Number(order.totalPayableAmount || 0);
          customer.loyaltyPointsBalance = Number(customer.loyaltyPointsBalance || 0) + earnedPoints;

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

          if (!customer.isBlacklisted) {
            const ltv = Number(customer.lifetimeValueAmount || 0);
            if (ltv >= 20_000_000) customer.tier = CustomerTierEnum.VIP;
            else if (ltv >= 8_000_000) customer.tier = CustomerTierEnum.GOLD;
            else if (ltv >= 2_000_000) customer.tier = CustomerTierEnum.SILVER;
          }

          await this.customerRepo.save(customer);

          if (earnedPoints > 0) {
            const pointEntry = this.walletLedgerRepo.create({
              shopId: params.shopId,
              customerId: customer.id,
              ledgerType: CustomerWalletLedgerTypeEnum.LOYALTY_POINT,
              transactionType: CustomerWalletTransactionTypeEnum.EARN_FROM_ORDER,
              deltaAmount: earnedPoints,
              balanceAfter: customer.loyaltyPointsBalance,
              referenceOrderId: order.id,
              note: `Tích điểm sau khi đối soát COD đơn ${order.orderCode}`,
              actorUserId: params.actorUserId,
            });
            await this.walletLedgerRepo.save(pointEntry);
          }
        }
      }

      item.isReconciled = true;
      await this.itemRepo.save(item);
      settledOrdersCount += 1;
      settledNetAmount +=
        Number(item.actualCodAmount || 0) -
        Number(item.actualShippingFee || 0) -
        Number(item.returnFeeCharged || 0);
    }

    const remainingUnreconciled = await this.itemRepo.count({
      where: { shopId: params.shopId, batchId: batch.id, isReconciled: false },
    });

    batch.status =
      remainingUnreconciled === 0
        ? CodReconciliationBatchStatusEnum.COMPLETED
        : CodReconciliationBatchStatusEnum.PARTIALLY_RECONCILED;
    batch.confirmedByUserId = params.actorUserId;
    batch.confirmedAt = now;
    if (params.dto.note) batch.note = params.dto.note;
    await this.batchRepo.save(batch);

    this.realtimeEmitter.emitToRoom(
      SOCKET_CONFIG.namespaces.CHAT,
      `shop:${params.shopId}`,
      'oms:cod_batch_reconciled',
      {
        shopId: params.shopId,
        batchId: batch.id,
        batchCode: batch.batchCode,
        settledOrdersCount,
        settledNetAmount,
      },
    );

    return {
      batch,
      settledOrdersCount,
      settledNetAmount,
      cashbookReceiptReady: {
        receiptType: 'COD_SETTLEMENT_INCOME',
        carrierCode: batch.carrierCode,
        batchCode: batch.batchCode,
        amountVnd: settledNetAmount,
      },
    };
  }

  public async exportDisputeCsv(shopId: string, batchId: string) {
    const batch = await this.batchRepo.findOne({ where: { id: batchId, shopId } });
    if (!batch) {
      throw new NotFoundException('Không tìm thấy phiên đối soát COD');
    }

    const discrepantItems = await this.itemRepo.find({
      where: {
        shopId,
        batchId,
        discrepancyType: In([
          CodReconciliationDiscrepancyTypeEnum.COD_SHORTFALL,
          CodReconciliationDiscrepancyTypeEnum.WEIGHT_OVERCHARGE,
          CodReconciliationDiscrepancyTypeEnum.RETURN_FEE_ERROR,
          CodReconciliationDiscrepancyTypeEnum.UNIDENTIFIED_TRACKING,
        ]),
      },
    });

    const header = [
      'MaVanDon',
      'MaDonHang',
      'LoaiLech',
      'COD_HeThong',
      'COD_DVVC_Tra',
      'ChenhLech_COD',
      'PhiShip_DuKien',
      'PhiShip_ThucTru',
      'ChenhLech_PhiShip',
      'CanKho_Gram',
      'CanDVVC_Gram',
      'GhiChuKhieuNai',
    ].join(',');

    const escapeCsv = (val: unknown) => `"${String(val ?? '').replace(/"/g, '""')}"`;

    const rows = discrepantItems.map((i) =>
      [
        escapeCsv(i.trackingNumber),
        escapeCsv(i.orderCode || ''),
        escapeCsv(i.discrepancyType),
        Number(i.expectedCodAmount),
        Number(i.actualCodAmount),
        Number(i.codVarianceAmount),
        Number(i.expectedShippingFee),
        Number(i.actualShippingFee),
        Number(i.shippingFeeVarianceAmount),
        i.actualPackedWeightGrams ?? '',
        i.carrierChargedWeightGrams ?? '',
        escapeCsv(i.disputeNote || ''),
      ].join(','),
    );

    return {
      fileName: `bien-ban-khieu-nai-${batch.batchCode}.csv`,
      discrepancyCount: discrepantItems.length,
      csvContent: `\uFEFF${header}\n${rows.join('\n')}`,
    };
  }
}
