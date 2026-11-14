import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import {
  ChannelTypeEnum,
  CustomerTierEnum,
  CustomerWalletLedgerTypeEnum,
  CustomerWalletTransactionTypeEnum,
  RfmSegmentCodeEnum,
  SecurityAuditActionCodeEnum,
} from 'src/common/enum';
import {
  AdjustCustomerWalletOrPointsDto,
  RecordOrderDeliveredLoyaltyDto,
} from 'src/dto/crm/crm.dto';
import {
  CustomerProfileEntity,
  CustomerRecentOrderSnapshotItem,
} from 'src/entity/customer-profile.entity';
import { CustomerWalletLedgerEntity } from 'src/entity/customer-wallet-ledger.entity';
import { Repository } from 'typeorm';

import { PiiVaultAndAuditService } from './pii-vault-and-audit.service';

export interface RfmSegmentSummaryItem {
  segmentCode: RfmSegmentCodeEnum;
  customerCount: number;
  totalLifetimeValue: number;
  avgTrustScore: number;
}

@Injectable()
export class CustomerRfmAndLoyaltyService {
  private readonly logger = new Logger(CustomerRfmAndLoyaltyService.name);

  constructor(
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(CustomerWalletLedgerEntity)
    private readonly walletLedgerRepo: Repository<CustomerWalletLedgerEntity>,
    private readonly piiVaultService: PiiVaultAndAuditService,
  ) {}

  /**
   * Cronjob tự động chạy vào 02:00 sáng hàng đêm để chấm điểm lại ma trận R - F - M
   * và cập nhật phân khúc khách hàng cho toàn bộ cửa hàng (F11.3).
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async handleNightlyRfmRecalculationCron(): Promise<void> {
    try {
      const distinctShops = await this.customerRepo
        .createQueryBuilder('c')
        .select('DISTINCT c.shop_id', 'shopId')
        .getRawMany<{ shopId: string }>();

      for (const row of distinctShops) {
        if (row.shopId) {
          await this.recalculateShopRfmSegments(row.shopId);
        }
      }
      this.logger.log(
        `[RFM Nightly Cron] Evaluated RFM segments across ${distinctShops.length} shop(s).`,
      );
    } catch (err) {
      this.logger.warn(`[RFM Nightly Cron] Warning: ${String(err)}`);
    }
  }

  /**
   * Tính điểm R - F - M (1..5) và ánh xạ vào 8 phân khúc chuẩn (F11.3)
   */
  public evaluateCustomerRfmScore(params: {
    lastOrderAt: Date | null;
    successfulDeliveriesCount: number;
    lifetimeValueAmount: number;
  }): {
    scoreR: number;
    scoreF: number;
    scoreM: number;
    segmentCode: RfmSegmentCodeEnum;
    tier: CustomerTierEnum;
  } {
    const nowMs = Date.now();
    const daysSinceLastOrder = params.lastOrderAt
      ? Math.max(0, Math.floor((nowMs - new Date(params.lastOrderAt).getTime()) / 86_400_000))
      : 999;

    const scoreR =
      daysSinceLastOrder <= 7
        ? 5
        : daysSinceLastOrder <= 21
          ? 4
          : daysSinceLastOrder <= 45
            ? 3
            : daysSinceLastOrder <= 90
              ? 2
              : 1;

    const freq = Math.max(0, Number(params.successfulDeliveriesCount || 0));
    const scoreF = freq >= 10 ? 5 : freq >= 5 ? 4 : freq >= 3 ? 3 : freq >= 1 ? 2 : 1;

    const ltv = Math.max(0, Number(params.lifetimeValueAmount || 0));
    const scoreM =
      ltv >= 15_000_000 ? 5 : ltv >= 5_000_000 ? 4 : ltv >= 1_500_000 ? 3 : ltv >= 300_000 ? 2 : 1;

    let segmentCode = RfmSegmentCodeEnum.NEW_CUSTOMERS;
    if (freq === 0) {
      segmentCode = RfmSegmentCodeEnum.NEW_CUSTOMERS;
    } else if (scoreR >= 4 && scoreF >= 4 && scoreM >= 4) {
      segmentCode = RfmSegmentCodeEnum.CHAMPIONS;
    } else if (scoreF >= 4 && scoreM >= 3) {
      segmentCode = RfmSegmentCodeEnum.LOYAL;
    } else if (scoreR >= 4 && scoreF >= 2) {
      segmentCode = RfmSegmentCodeEnum.POTENTIAL_LOYALIST;
    } else if (scoreR >= 4 && scoreF === 1) {
      segmentCode = RfmSegmentCodeEnum.PROMISING;
    } else if (scoreR === 3 && scoreF >= 2) {
      segmentCode = RfmSegmentCodeEnum.NEED_ATTENTION;
    } else if (scoreR <= 2 && scoreF >= 3) {
      segmentCode = RfmSegmentCodeEnum.AT_RISK;
    } else {
      segmentCode = RfmSegmentCodeEnum.HIBERNATING;
    }

    const tier =
      ltv >= 10_000_000 || freq >= 8
        ? CustomerTierEnum.VIP
        : ltv >= 3_000_000 || freq >= 4
          ? CustomerTierEnum.GOLD
          : ltv >= 500_000 || freq >= 1
            ? CustomerTierEnum.SILVER
            : CustomerTierEnum.NEW;

    return {
      scoreR,
      scoreF,
      scoreM,
      segmentCode,
      tier,
    };
  }

  /**
   * Tính toán lại toàn bộ Ma trận Phân khúc RFM cho tất cả khách hàng của cửa hàng (F11.3)
   */
  public async recalculateShopRfmSegments(shopId: string): Promise<{
    shopId: string;
    totalCustomersEvaluated: number;
    segments: RfmSegmentSummaryItem[];
    calculatedAt: string;
  }> {
    const customers = await this.customerRepo.find({ where: { shopId } });

    for (const cust of customers) {
      const evaluated = this.evaluateCustomerRfmScore({
        lastOrderAt: cust.lastOrderAt,
        successfulDeliveriesCount: cust.successfulDeliveriesCount,
        lifetimeValueAmount: Number(cust.lifetimeValueAmount || 0),
      });

      cust.rfmScoreR = evaluated.scoreR;
      cust.rfmScoreF = evaluated.scoreF;
      cust.rfmScoreM = evaluated.scoreM;
      cust.rfmSegmentCode = evaluated.segmentCode;
      if (!cust.isBlacklisted) {
        cust.tier = evaluated.tier;
      }
    }

    if (customers.length > 0) {
      await this.customerRepo.save(customers);
    }

    return this.getRfmSegmentsOverview(shopId);
  }

  public async getRfmSegmentsOverview(shopId: string): Promise<{
    shopId: string;
    totalCustomersEvaluated: number;
    segments: RfmSegmentSummaryItem[];
    calculatedAt: string;
  }> {
    const customers = await this.customerRepo.find({ where: { shopId } });
    const allSegments = Object.values(RfmSegmentCodeEnum);

    const map = new Map<
      RfmSegmentCodeEnum,
      { count: number; totalLtv: number; totalTrust: number }
    >();
    for (const seg of allSegments) {
      map.set(seg, { count: 0, totalLtv: 0, totalTrust: 0 });
    }

    for (const c of customers) {
      const bucket = map.get(c.rfmSegmentCode) || { count: 0, totalLtv: 0, totalTrust: 0 };
      bucket.count += 1;
      bucket.totalLtv += Number(c.lifetimeValueAmount || 0);
      bucket.totalTrust += Number(c.deliveryTrustScore || 80);
      map.set(c.rfmSegmentCode, bucket);
    }

    const segments: RfmSegmentSummaryItem[] = allSegments.map((seg) => {
      const b = map.get(seg)!;
      return {
        segmentCode: seg,
        customerCount: b.count,
        totalLifetimeValue: b.totalLtv,
        avgTrustScore: b.count > 0 ? Math.round(b.totalTrust / b.count) : 80,
      };
    });

    return {
      shopId,
      totalCustomersEvaluated: customers.length,
      segments,
      calculatedAt: new Date().toISOString(),
    };
  }

  /**
   * F11.4: Khi đơn hàng chuyển sang trạng thái `DELIVERED_RECONCILED` (đã giao & đối soát tiền thành công):
   * - Tự động cộng điểm thưởng (`loyaltyPointsBalance`) theo tỷ lệ `100.000đ = 10 điểm` (10.000đ = 1 điểm).
   * - Nếu có tiền thừa chuyển khoản hoặc hoàn tiền RMA (`overpaymentOrRmaCreditAmount`), tự động cộng vào `walletCreditBalance`.
   * - Tự động nâng hạng thẻ (`NEW` -> `SILVER` -> `GOLD` -> `VIP`) và cập nhật phân khúc `RFM`.
   */
  public async recordOrderDeliveredAndAwardLoyaltyPoints(params: {
    shopId: string;
    customerId: string;
    actorUserId: string;
    dto: RecordOrderDeliveredLoyaltyDto;
  }): Promise<{
    customer: CustomerProfileEntity;
    awardedPoints: number;
    ledgerEntries: CustomerWalletLedgerEntity[];
  }> {
    const customer = await this.customerRepo.findOne({
      where: { id: params.customerId, shopId: params.shopId },
    });
    if (!customer) {
      throw new NotFoundException('CUSTOMER_PROFILE_NOT_FOUND');
    }

    const orderAmount = Math.max(0, Number(params.dto.orderTotalAmount || 0));
    const awardedPoints = Math.max(1, Math.floor(orderAmount / 10_000));
    const now = new Date();

    customer.totalOrdersCount = Number(customer.totalOrdersCount || 0) + 1;
    customer.successfulDeliveriesCount = Number(customer.successfulDeliveriesCount || 0) + 1;
    customer.lifetimeValueAmount = Number(customer.lifetimeValueAmount || 0) + orderAmount;
    customer.loyaltyPointsBalance = Number(customer.loyaltyPointsBalance || 0) + awardedPoints;
    customer.lastOrderAt = now;

    const newOrderSnapshot: CustomerRecentOrderSnapshotItem = {
      orderId: `ord_${Date.now()}`,
      orderCode: params.dto.orderCode.trim(),
      channelType: params.dto.channelType || ChannelTypeEnum.FACEBOOK_PAGE,
      pageShortCode: params.dto.pageShortCode || 'POS',
      totalAmount: orderAmount,
      status: 'DELIVERED_RECONCILED',
      carrierCode: params.dto.carrierCode || 'GHN',
      trackingNumber: params.dto.trackingNumber || `GHN${String(Date.now()).slice(-7)}`,
      createdAt: now.toISOString(),
    };
    const existingOrders = Array.isArray(customer.recentOrdersSnapshotJson)
      ? customer.recentOrdersSnapshotJson
      : [];
    customer.recentOrdersSnapshotJson = [
      newOrderSnapshot,
      ...existingOrders.filter((o) => o.orderCode !== newOrderSnapshot.orderCode),
    ].slice(0, 15);

    const evaluatedRfm = this.evaluateCustomerRfmScore({
      lastOrderAt: customer.lastOrderAt,
      successfulDeliveriesCount: customer.successfulDeliveriesCount,
      lifetimeValueAmount: customer.lifetimeValueAmount,
    });
    customer.rfmScoreR = evaluatedRfm.scoreR;
    customer.rfmScoreF = evaluatedRfm.scoreF;
    customer.rfmScoreM = evaluatedRfm.scoreM;
    customer.rfmSegmentCode = evaluatedRfm.segmentCode;
    if (!customer.isBlacklisted) {
      customer.tier = evaluatedRfm.tier;
    }

    const ledgerEntries: CustomerWalletLedgerEntity[] = [];

    const pointsLedger = this.walletLedgerRepo.create({
      shopId: params.shopId,
      customerId: customer.id,
      ledgerType: CustomerWalletLedgerTypeEnum.LOYALTY_POINT,
      transactionType: CustomerWalletTransactionTypeEnum.EARN_FROM_ORDER,
      deltaAmount: awardedPoints,
      balanceAfter: customer.loyaltyPointsBalance,
      referenceOrderId: params.dto.orderCode.trim(),
      note: `Tích điểm tự động (+${awardedPoints} điểm) từ đơn giao thành công ${params.dto.orderCode.trim()}`,
      actorUserId: params.actorUserId,
    });
    ledgerEntries.push(await this.walletLedgerRepo.save(pointsLedger));

    const extraCredit = Math.max(0, Number(params.dto.overpaymentOrRmaCreditAmount || 0));
    if (extraCredit > 0) {
      customer.walletCreditBalance = Number(customer.walletCreditBalance || 0) + extraCredit;
      const creditLedger = this.walletLedgerRepo.create({
        shopId: params.shopId,
        customerId: customer.id,
        ledgerType: CustomerWalletLedgerTypeEnum.WALLET_CREDIT,
        transactionType: CustomerWalletTransactionTypeEnum.OVERPAYMENT_CREDIT,
        deltaAmount: extraCredit,
        balanceAfter: customer.walletCreditBalance,
        referenceOrderId: params.dto.orderCode.trim(),
        note: `Cộng tiền dư vào Ví khách hàng từ đơn ${params.dto.orderCode.trim()}`,
        actorUserId: params.actorUserId,
      });
      ledgerEntries.push(await this.walletLedgerRepo.save(creditLedger));
    }

    const savedCustomer = await this.customerRepo.save(customer);

    return {
      customer: savedCustomer,
      awardedPoints,
      ledgerEntries,
    };
  }

  /**
   * F11.4: Điều chỉnh Điểm thưởng thành viên (`loyaltyPointsBalance`) hoặc Ví tiền thừa (`walletCreditBalance`)
   * kèm lưu sổ cái `CustomerWalletLedgerEntity` và kiểm toán bảo mật.
   */
  public async adjustCustomerWalletOrPoints(params: {
    shopId: string;
    customerId: string;
    actorUserId: string;
    dto: AdjustCustomerWalletOrPointsDto;
  }): Promise<{
    customer: CustomerProfileEntity;
    ledgerEntry: CustomerWalletLedgerEntity;
  }> {
    const customer = await this.customerRepo.findOne({
      where: { id: params.customerId, shopId: params.shopId },
    });
    if (!customer) {
      throw new NotFoundException('CUSTOMER_PROFILE_NOT_FOUND');
    }

    const delta = Number(params.dto.deltaAmount || 0);
    let balanceAfter = 0;

    if (params.dto.ledgerType === CustomerWalletLedgerTypeEnum.LOYALTY_POINT) {
      const nextPoints = Math.max(
        0,
        Math.round(Number(customer.loyaltyPointsBalance || 0) + delta),
      );
      customer.loyaltyPointsBalance = nextPoints;
      balanceAfter = nextPoints;
    } else {
      const nextCredit = Math.max(0, Number(customer.walletCreditBalance || 0) + delta);
      customer.walletCreditBalance = nextCredit;
      balanceAfter = nextCredit;
    }

    const savedCustomer = await this.customerRepo.save(customer);

    const ledgerEntry = this.walletLedgerRepo.create({
      shopId: params.shopId,
      customerId: customer.id,
      ledgerType: params.dto.ledgerType,
      transactionType: params.dto.transactionType,
      deltaAmount: delta,
      balanceAfter,
      referenceOrderId: params.dto.referenceOrderId || null,
      note: params.dto.note.trim(),
      actorUserId: params.actorUserId,
    });
    const savedLedger = await this.walletLedgerRepo.save(ledgerEntry);

    await this.piiVaultService.recordSecurityAuditLog({
      shopId: params.shopId,
      actorUserId: params.actorUserId,
      actionCode: SecurityAuditActionCodeEnum.WALLET_MANUAL_ADJUST,
      targetResourceType: 'CUSTOMER_WALLET',
      targetResourceId: customer.id,
      afterSnapshotJson: {
        customerCode: customer.code,
        customerName: customer.fullName,
        ledgerType: params.dto.ledgerType,
        transactionType: params.dto.transactionType,
        deltaAmount: delta,
        balanceAfter,
        note: params.dto.note,
      },
    });

    return {
      customer: savedCustomer,
      ledgerEntry: savedLedger,
    };
  }

  public async listCustomerWalletLedgers(
    shopId: string,
    customerId: string,
  ): Promise<CustomerWalletLedgerEntity[]> {
    return this.walletLedgerRepo.find({
      where: { shopId, customerId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }
}
