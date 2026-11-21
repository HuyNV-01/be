import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { SecurityAuditActionCodeEnum } from 'src/common/enum';
import { StandalonePhoneAbuseReportDto } from 'src/dto/crm/phone-trust-reputation.dto';
import { CommunityPhoneAbuseReportEntity } from 'src/entity/community-phone-abuse-report.entity';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { Repository } from 'typeorm';

import {
  DeliveryTrustEvaluationResult,
  DeliveryTrustScoreService,
} from './delivery-trust-score.service';
import { PhoneReputationSyncService } from './phone-reputation-sync.service';
import { PiiVaultAndAuditService } from './pii-vault-and-audit.service';

@Injectable()
export class PhoneTrustStandaloneService {
  constructor(
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(CommunityPhoneAbuseReportEntity)
    private readonly abuseReportRepo: Repository<CommunityPhoneAbuseReportEntity>,
    private readonly piiVaultService: PiiVaultAndAuditService,
    private readonly trustScoreService: DeliveryTrustScoreService,
    private readonly phoneReputationSyncService: PhoneReputationSyncService,
  ) {}

  public async submitStandalonePhoneAbuseReport(params: {
    shopId: string;
    actorUserId: string;
    dto: StandalonePhoneAbuseReportDto;
  }): Promise<{
    reportId: string;
    phoneMasked: string;
    trustEvaluation: DeliveryTrustEvaluationResult;
  }> {
    const shop = await this.shopRepo.findOne({ where: { id: params.shopId } });
    if (!shop) {
      throw new NotFoundException('SHOP_WORKSPACE_NOT_FOUND');
    }

    const normalized = this.piiVaultService.normalizeLocalVietnamesePhone(params.dto.rawPhone);
    if (normalized.length < 9) {
      throw new BadRequestException('Số điện thoại không hợp lệ (cần tối thiểu 9–10 chữ số).');
    }

    const phoneGlobalHash = this.piiVaultService.computeGlobalPhoneConsortiumHash(normalized);
    const phoneSearchHash = this.piiVaultService.computePhoneBlindSearchHash(
      params.shopId,
      normalized,
    );
    const phoneMasked = this.piiVaultService.maskPhoneNumber(normalized) || normalized;
    const shopAlias = shop.name || `Shop #${params.shopId.slice(0, 6)}`;
    const carrierUpper = params.dto.carrierCode?.trim().toUpperCase() || null;
    const trackingTrimmed = params.dto.trackingNumber?.trim() || null;
    const orderCodeTrimmed = params.dto.orderCode?.trim() || null;

    const existingCustomer = await this.customerRepo.findOne({
      where: [
        { shopId: params.shopId, phoneGlobalHash },
        { shopId: params.shopId, phoneSearchHash },
      ],
    });

    const dedupeKey = (
      trackingTrimmed ||
      orderCodeTrimmed ||
      `STANDALONE_${params.dto.reasonCode}_${new Date().toISOString().slice(0, 10)}`
    ).slice(0, 96);

    let reportEntity = await this.abuseReportRepo.findOne({
      where: {
        phoneGlobalHash,
        reporterShopId: params.shopId,
        dedupeKey,
      },
    });

    const verificationLevel = trackingTrimmed
      ? 'CARRIER_VERIFIED'
      : orderCodeTrimmed
        ? 'ORDER_LINKED'
        : 'SHOP_DECLARED';
    const severity =
      trackingTrimmed ||
      params.dto.reasonCode === 'BOM_HANG' ||
      params.dto.reasonCode === 'BOOM_AO_SPAM'
        ? trackingTrimmed
          ? 'CRITICAL'
          : 'HIGH'
        : 'MEDIUM';

    if (reportEntity) {
      reportEntity.reasonCode = params.dto.reasonCode;
      reportEntity.reasonNote = params.dto.reasonNote.trim();
      reportEntity.carrierCode = carrierUpper;
      reportEntity.orderCode = orderCodeTrimmed;
      reportEntity.trackingNumber = trackingTrimmed;
      reportEntity.verificationLevel = verificationLevel;
      reportEntity.severity = severity;
      reportEntity.status = 'ACTIVE';
      reportEntity = await this.abuseReportRepo.save(reportEntity);
    } else {
      reportEntity = await this.abuseReportRepo.save(
        this.abuseReportRepo.create({
          phoneGlobalHash,
          phoneMaskedHint: phoneMasked,
          reporterShopId: params.shopId,
          reporterShopAlias: shopAlias,
          reporterUserId: params.actorUserId,
          customerId: existingCustomer?.id || null,
          dedupeKey,
          reasonCode: params.dto.reasonCode,
          reasonNote: params.dto.reasonNote.trim(),
          sourceCode: carrierUpper ? `CARRIER_3PL_${carrierUpper}` : 'SHOP_INTERNAL',
          carrierCode: carrierUpper,
          orderCode: orderCodeTrimmed,
          trackingNumber: trackingTrimmed,
          verificationLevel,
          severity,
          status: 'ACTIVE',
        }),
      );
    }

    await this.phoneReputationSyncService.recalculateAbuseReportCountersForPhoneHash(
      phoneGlobalHash,
      phoneMasked,
    );

    const cfg = shop.crmTrustAndIndustryConfigJson || null;
    const lookupRes = await this.trustScoreService.lookupPhoneReputationFromSources({
      shopId: params.shopId,
      rawPhone: normalized,
      phoneMasked,
      phoneSearchHash,
      phoneGlobalHash,
      excludeShopId: params.shopId,
      customerId: existingCustomer?.id || null,
      config: cfg,
      enablePublicWebRiskLookup: cfg?.enablePublicWebRiskLookup !== false,
      bypassCache: true,
    });

    const trustEvaluation = this.trustScoreService.evaluateCustomerTrustScore({
      successfulDeliveriesCount: Math.max(
        Number(existingCustomer?.successfulDeliveriesCount || 0),
        lookupRes.shopDeliveredCount,
      ),
      returnedOrdersCount: Math.max(
        Number(existingCustomer?.returnedOrdersCount || 0),
        lookupRes.shopReturnedCount,
      ),
      networkDeliveredCount: lookupRes.networkDeliveredCount,
      networkReturnedCount: lookupRes.networkReturnedCount,
      reportedCount: Math.max(
        Number(existingCustomer?.reportedCount || 0),
        lookupRes.reportedCount,
      ),
      reportedReasons: [
        ...(existingCustomer?.reportedReasonsJson || []),
        ...lookupRes.reportedReasons,
      ],
      sourceBreakdowns: lookupRes.sourceBreakdowns,
      providerDiagnostics: lookupRes.providerDiagnostics,
      isBlacklisted: Boolean(existingCustomer?.isBlacklisted || params.dto.markBlacklisted),
      shopRequireDepositOnHighRisk: shop.requireDepositOnHighRisk ?? true,
      highRiskReturnRateThresholdPercent: cfg?.highRiskReturnRateThresholdPercent ?? 30,
      highRiskReportedCountThreshold: cfg?.highRiskReportedCountThreshold ?? 1,
      lookupSource: lookupRes.lookupSource,
      enabledCarriers: cfg?.enabledCarriers || ['GHN', 'GHTK', 'VTP', 'JT'],
      checkedAt: new Date(),
    });

    if (existingCustomer) {
      existingCustomer.phoneGlobalHash = phoneGlobalHash;
      existingCustomer.reportedReasonsJson = trustEvaluation.reportedReasons;
      existingCustomer.reportedCount = trustEvaluation.reportedCount;
      existingCustomer.deliveryTrustScore = trustEvaluation.score;
      existingCustomer.trustSourceBreakdownsJson = trustEvaluation.sourceBreakdowns;
      existingCustomer.trustProviderDiagnosticsJson = trustEvaluation.providerDiagnostics;
      existingCustomer.lastTrustLookupAt = new Date();
      if (params.dto.markBlacklisted) {
        existingCustomer.isBlacklisted = true;
        existingCustomer.blacklistReason = params.dto.reasonNote.trim();
      }
      await this.customerRepo.save(existingCustomer);
    }

    await this.piiVaultService.recordSecurityAuditLog({
      shopId: params.shopId,
      actorUserId: params.actorUserId,
      actionCode: SecurityAuditActionCodeEnum.PHONE_ABUSE_REPORT,
      targetResourceType: 'COMMUNITY_PHONE_ABUSE_REPORT',
      targetResourceId: reportEntity.id,
      afterSnapshotJson: {
        phoneMasked,
        reasonCode: params.dto.reasonCode,
        carrierCode: carrierUpper,
        trackingNumber: trackingTrimmed,
      },
    });

    return {
      reportId: reportEntity.id,
      phoneMasked,
      trustEvaluation,
    };
  }
}
