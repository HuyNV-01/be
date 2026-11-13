import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  CustomerTierEnum,
  CustomerWalletLedgerTypeEnum,
  CustomerWalletTransactionTypeEnum,
  RfmSegmentCodeEnum,
  SecurityAuditActionCodeEnum,
} from 'src/common/enum';
import { AdjustCustomerWalletOrPointsDto } from 'src/dto/crm/crm.dto';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
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
  constructor(
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(CustomerWalletLedgerEntity)
    private readonly walletLedgerRepo: Repository<CustomerWalletLedgerEntity>,
    private readonly piiVaultService: PiiVaultAndAuditService,
  ) {}

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
