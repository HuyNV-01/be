import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { SecurityAuditActionCodeEnum } from 'src/common/enum';
import {
  PhoneTrustAbuseReasonCodeEnum,
  PhoneTrustAbuseSeverityEnum,
  PhoneTrustEventOutcomeEnum,
  PhoneTrustReportStatusEnum,
  PhoneTrustVerificationLevelEnum,
} from 'src/common/enum/phone-trust.enum';
import { CustomerAbuseReportItem, CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { PhoneTrustAbuseReportEntity } from 'src/entity/phone-trust-abuse-report.entity';
import { PhoneTrustDeliveryEventEntity } from 'src/entity/phone-trust-delivery-event.entity';
import {
  CarrierBreakdownCounterMap,
  PhoneTrustGlobalAggregateEntity,
} from 'src/entity/phone-trust-global-aggregate.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { UserEntity } from 'src/entity/user.entity';
import { MessageCryptoService } from 'src/modules/chat/services/message-crypto.service';
import { DataSource, Repository } from 'typeorm';

import { PhoneTrustBlindIndexService } from './phone-trust-blind-index.service';
import { PhoneTrustProviderAdaptersService } from './phone-trust-provider-adapters.service';
import { PiiVaultAndAuditService } from './pii-vault-and-audit.service';

export interface RecordDeliveryEventParams {
  rawPhone: string;
  sourceShopId: string | null;
  sourceProvider: string;
  externalEventKey: string;
  carrierCode?: string | null;
  trackingNumber?: string | null;
  orderCode?: string | null;
  eventOutcome: PhoneTrustEventOutcomeEnum;
  verificationLevel: PhoneTrustVerificationLevelEnum;
  shareWithConsortium?: boolean;
  codAmount?: number;
  carrierRawStatus?: string | null;
  carrierReasonNote?: string | null;
  occurredAt?: Date;
}

export interface SubmitAbuseReportParams {
  shopId: string;
  actorUserId: string;
  rawPhone: string;
  customerId?: string | null;
  reasonCode: PhoneTrustAbuseReasonCodeEnum;
  reasonNote: string;
  carrierCode?: string | null;
  orderCode?: string | null;
  trackingNumber?: string | null;
  evidenceUrl?: string | null;
  markBlacklisted?: boolean;
}

export interface LedgerQuerySnapshot {
  shopDeliveredCount: number;
  shopReturnedCount: number;
  shopFailedCount: number;
  consortiumOtherShopsDeliveredCount: number;
  consortiumOtherShopsReturnedCount: number;
  consortiumOtherShopsFailedCount: number;
  activeReports: CustomerAbuseReportItem[];
  verifiedReportedCount: number;
  distinctReportingShopsCount: number;
  carrierBreakdown: CarrierBreakdownCounterMap;
  lastEventAt: string | null;
}

/**
 * Manages the multi-tenant source of truth for real delivery outcomes and abuse reports.
 * All writes are idempotent, transactionally update the global aggregate table,
 * and invalidate Redis lookup caches for the affected phone hash.
 */
@Injectable()
export class PhoneTrustLedgerService {
  private readonly logger = new Logger(PhoneTrustLedgerService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(PhoneTrustDeliveryEventEntity)
    private readonly deliveryEventRepo: Repository<PhoneTrustDeliveryEventEntity>,
    @InjectRepository(PhoneTrustAbuseReportEntity)
    private readonly abuseReportRepo: Repository<PhoneTrustAbuseReportEntity>,
    @InjectRepository(PhoneTrustGlobalAggregateEntity)
    private readonly globalAggregateRepo: Repository<PhoneTrustGlobalAggregateEntity>,
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRedis() private readonly redis: Redis,
    private readonly blindIndexService: PhoneTrustBlindIndexService,
    private readonly providerAdapters: PhoneTrustProviderAdaptersService,
    private readonly piiVaultService: PiiVaultAndAuditService,
    private readonly messageCryptoService: MessageCryptoService,
  ) {}

  private async invalidateLookupCacheByGlobalHash(globalPhoneHash: string): Promise<void> {
    try {
      const pattern = `trust:lookup:v2:*:${globalPhoneHash}`;
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } while (cursor !== '0');
    } catch (err) {
      this.logger.warn(`Failed to invalidate Redis trust cache: ${String(err)}`);
    }
  }

  /**
   * Idempotently records a verified delivery/return outcome (from 3PL webhook, OMS, or import)
   * and recalculates the global materialized aggregate for that phone hash.
   */
  public async recordDeliveryEvent(params: RecordDeliveryEventParams): Promise<{
    eventId: string;
    globalPhoneHash: string;
    inserted: boolean;
  }> {
    const normalizedPhone = this.blindIndexService.normalizeVietnamesePhone(params.rawPhone);
    if (!this.blindIndexService.isValidVietnamesePhone(normalizedPhone)) {
      throw new BadRequestException('INVALID_VIETNAMESE_PHONE_NUMBER');
    }

    const globalPhoneHash = this.blindIndexService.computeGlobalPhoneHash(normalizedPhone);
    const phoneMasked = this.blindIndexService.maskPhone(normalizedPhone);

    const existing = await this.deliveryEventRepo.findOne({
      where: {
        sourceProvider: params.sourceProvider,
        externalEventKey: params.externalEventKey,
      },
    });

    if (existing) {
      return {
        eventId: existing.id,
        globalPhoneHash,
        inserted: false,
      };
    }

    let shareWithConsortium = params.shareWithConsortium ?? true;
    if (params.sourceShopId && params.shareWithConsortium === undefined) {
      const shop = await this.shopRepo.findOne({
        where: { id: params.sourceShopId },
        select: ['id', 'crmTrustAndIndustryConfigJson'],
      });
      shareWithConsortium = shop?.crmTrustAndIndustryConfigJson?.consortiumSharingEnabled !== false;
    }

    const saved = await this.deliveryEventRepo.save(
      this.deliveryEventRepo.create({
        globalPhoneHash,
        phoneMasked,
        sourceShopId: params.sourceShopId,
        sourceProvider: params.sourceProvider,
        externalEventKey: params.externalEventKey,
        carrierCode: params.carrierCode ? params.carrierCode.toUpperCase() : null,
        trackingNumber: params.trackingNumber?.trim() || null,
        orderCode: params.orderCode?.trim() || null,
        eventOutcome: params.eventOutcome,
        verificationLevel: params.verificationLevel,
        shareWithConsortium,
        codAmount: Number(params.codAmount || 0),
        carrierRawStatus: params.carrierRawStatus || null,
        carrierReasonNote: params.carrierReasonNote || null,
        occurredAt: params.occurredAt || new Date(),
      }),
    );

    await this.recomputeGlobalAggregate(globalPhoneHash, phoneMasked);
    await this.invalidateLookupCacheByGlobalHash(globalPhoneHash);

    return {
      eventId: saved.id,
      globalPhoneHash,
      inserted: true,
    };
  }

  /**
   * Recomputes the materialized cross-shop aggregate row from immutable events and active reports
   * so counters stay strictly accurate after webhooks, imports, or report retractions.
   */
  public async recomputeGlobalAggregate(
    globalPhoneHash: string,
    phoneMasked?: string,
  ): Promise<PhoneTrustGlobalAggregateEntity> {
    return this.dataSource.transaction(async (manager) => {
      const eventRepo = manager.getRepository(PhoneTrustDeliveryEventEntity);
      const reportRepo = manager.getRepository(PhoneTrustAbuseReportEntity);
      const aggRepo = manager.getRepository(PhoneTrustGlobalAggregateEntity);

      const [consortiumEvents, activeConsortiumReports] = await Promise.all([
        eventRepo.find({
          where: { globalPhoneHash, shareWithConsortium: true },
          order: { occurredAt: 'DESC' },
        }),
        reportRepo.find({
          where: {
            globalPhoneHash,
            shareWithConsortium: true,
            status: PhoneTrustReportStatusEnum.ACTIVE,
          },
          order: { createdAt: 'DESC' },
        }),
      ]);

      let delivered = 0;
      let returned = 0;
      let failed = 0;
      let lastEventAt: Date | null = null;
      const carrierBreakdown: CarrierBreakdownCounterMap = {};

      for (const ev of consortiumEvents) {
        if (!lastEventAt || ev.occurredAt > lastEventAt) {
          lastEventAt = ev.occurredAt;
        }
        const carrierKey = (ev.carrierCode || 'INTERNAL').toUpperCase();
        if (!carrierBreakdown[carrierKey]) {
          carrierBreakdown[carrierKey] = {
            deliveredCount: 0,
            returnedCount: 0,
            failedCount: 0,
            lastEventAt: null,
          };
        }

        if (ev.eventOutcome === PhoneTrustEventOutcomeEnum.DELIVERED) {
          delivered += 1;
          carrierBreakdown[carrierKey].deliveredCount += 1;
        } else if (
          ev.eventOutcome === PhoneTrustEventOutcomeEnum.RETURNED ||
          ev.eventOutcome === PhoneTrustEventOutcomeEnum.PARTIAL_RETURN
        ) {
          returned += 1;
          carrierBreakdown[carrierKey].returnedCount += 1;
        } else if (ev.eventOutcome === PhoneTrustEventOutcomeEnum.DELIVERY_FAILED) {
          failed += 1;
          carrierBreakdown[carrierKey].failedCount += 1;
        }

        const evIso = ev.occurredAt.toISOString();
        if (
          !carrierBreakdown[carrierKey].lastEventAt ||
          evIso > carrierBreakdown[carrierKey].lastEventAt!
        ) {
          carrierBreakdown[carrierKey].lastEventAt = evIso;
        }
      }

      const reportingShopSet = new Set<string>();
      let verifiedReports = 0;
      for (const rep of activeConsortiumReports) {
        reportingShopSet.add(rep.sourceShopId);
        if (
          rep.isCarrierVerified ||
          rep.verificationLevel === PhoneTrustVerificationLevelEnum.CARRIER_VERIFIED
        ) {
          verifiedReports += 1;
        }
        if (!lastEventAt || rep.createdAt > lastEventAt) {
          lastEventAt = rep.createdAt;
        }
      }

      let existingAgg = await aggRepo.findOne({ where: { globalPhoneHash } });
      const resolvedMasked =
        phoneMasked ||
        existingAgg?.phoneMasked ||
        consortiumEvents[0]?.phoneMasked ||
        activeConsortiumReports[0]?.phoneMasked ||
        '***';

      if (!existingAgg) {
        existingAgg = aggRepo.create({
          globalPhoneHash,
          phoneMasked: resolvedMasked,
        });
      }

      existingAgg.phoneMasked = resolvedMasked;
      existingAgg.consortiumDeliveredCount = delivered;
      existingAgg.consortiumReturnedCount = returned;
      existingAgg.consortiumFailedCount = failed;
      existingAgg.consortiumActiveReportCount = activeConsortiumReports.length;
      existingAgg.consortiumVerifiedReportCount = verifiedReports;
      existingAgg.distinctReportingShopsCount = reportingShopSet.size;
      existingAgg.carrierBreakdownJson = carrierBreakdown;
      existingAgg.lastEventAt = lastEventAt;

      return aggRepo.save(existingAgg);
    });
  }

  /**
   * Queries both shop-scoped and cross-shop consortium ledgers for a normalized phone number.
   * Properly separates current shop counts from other shops in the consortium to prevent double counting.
   */
  public async getLedgerSnapshotForPhone(params: {
    shopId: string;
    normalizedPhone: string;
    includeConsortium: boolean;
  }): Promise<LedgerQuerySnapshot> {
    const globalPhoneHash = this.blindIndexService.computeGlobalPhoneHash(params.normalizedPhone);

    const [shopEvents, globalAggregate, allActiveReports] = await Promise.all([
      this.deliveryEventRepo.find({
        where: { sourceShopId: params.shopId, globalPhoneHash },
        order: { occurredAt: 'DESC' },
      }),
      params.includeConsortium
        ? this.globalAggregateRepo.findOne({ where: { globalPhoneHash } })
        : Promise.resolve(null),
      this.abuseReportRepo.find({
        where: {
          globalPhoneHash,
          status: PhoneTrustReportStatusEnum.ACTIVE,
        },
        order: { createdAt: 'DESC' },
        take: 30,
      }),
    ]);

    let shopDeliveredCount = 0;
    let shopReturnedCount = 0;
    let shopFailedCount = 0;
    let shopSharedDelivered = 0;
    let shopSharedReturned = 0;
    let shopSharedFailed = 0;

    for (const ev of shopEvents) {
      if (ev.eventOutcome === PhoneTrustEventOutcomeEnum.DELIVERED) {
        shopDeliveredCount += 1;
        if (ev.shareWithConsortium) shopSharedDelivered += 1;
      } else if (
        ev.eventOutcome === PhoneTrustEventOutcomeEnum.RETURNED ||
        ev.eventOutcome === PhoneTrustEventOutcomeEnum.PARTIAL_RETURN
      ) {
        shopReturnedCount += 1;
        if (ev.shareWithConsortium) shopSharedReturned += 1;
      } else if (ev.eventOutcome === PhoneTrustEventOutcomeEnum.DELIVERY_FAILED) {
        shopFailedCount += 1;
        if (ev.shareWithConsortium) shopSharedFailed += 1;
      }
    }

    const consortiumOtherShopsDeliveredCount = params.includeConsortium
      ? Math.max(0, Number(globalAggregate?.consortiumDeliveredCount || 0) - shopSharedDelivered)
      : 0;
    const consortiumOtherShopsReturnedCount = params.includeConsortium
      ? Math.max(0, Number(globalAggregate?.consortiumReturnedCount || 0) - shopSharedReturned)
      : 0;
    const consortiumOtherShopsFailedCount = params.includeConsortium
      ? Math.max(0, Number(globalAggregate?.consortiumFailedCount || 0) - shopSharedFailed)
      : 0;

    const visibleReports = allActiveReports.filter(
      (rep) =>
        rep.sourceShopId === params.shopId || (params.includeConsortium && rep.shareWithConsortium),
    );

    const reportingShops = new Set<string>();
    let verifiedReportedCount = 0;

    const activeReports: CustomerAbuseReportItem[] = visibleReports.map((rep) => {
      reportingShops.add(rep.sourceShopId);
      if (
        rep.isCarrierVerified ||
        rep.verificationLevel === PhoneTrustVerificationLevelEnum.CARRIER_VERIFIED
      ) {
        verifiedReportedCount += 1;
      }
      const isOwnShop = rep.sourceShopId === params.shopId;
      return {
        reportId: rep.id,
        reason: rep.reasonNote,
        reasonCode: rep.reasonCode,
        reasonNote: rep.reasonNote,
        carrierCode: rep.carrierCode,
        orderCode: rep.orderCode,
        source: isOwnShop ? 'SHOP_INTERNAL' : 'PANCAKE_COMMUNITY',
        reportedByName: isOwnShop ? rep.reportedByName : 'Cộng đồng Nhà bán hàng (Đã ẩn danh shop)',
        reportedAt: rep.createdAt.toISOString(),
        trackingNumber: rep.trackingNumber,
        severity: rep.severity,
        isCarrierVerified: rep.isCarrierVerified,
        verificationLevel: rep.verificationLevel,
        canRetract: isOwnShop,
        evidenceUrl: rep.evidenceUrl,
      } as CustomerAbuseReportItem;
    });

    return {
      shopDeliveredCount,
      shopReturnedCount,
      shopFailedCount,
      consortiumOtherShopsDeliveredCount,
      consortiumOtherShopsReturnedCount,
      consortiumOtherShopsFailedCount,
      activeReports,
      verifiedReportedCount,
      distinctReportingShopsCount: reportingShops.size,
      carrierBreakdown: globalAggregate?.carrierBreakdownJson || {},
      lastEventAt: globalAggregate?.lastEventAt ? globalAggregate.lastEventAt.toISOString() : null,
    };
  }

  /**
   * Submits a deduplicated buyer abuse report, optionally verifying the tracking number live
   * with GHN/GHTK to grant CARRIER_VERIFIED weight, and records an immutable audit log entry.
   */
  public async submitAbuseReport(params: SubmitAbuseReportParams): Promise<{
    report: PhoneTrustAbuseReportEntity;
    phoneMasked: string;
    globalPhoneHash: string;
  }> {
    const normalizedPhone = this.blindIndexService.normalizeVietnamesePhone(params.rawPhone);
    if (!this.blindIndexService.isValidVietnamesePhone(normalizedPhone)) {
      throw new BadRequestException('INVALID_VIETNAMESE_PHONE_NUMBER');
    }

    const [shop, actor] = await Promise.all([
      this.shopRepo.findOne({ where: { id: params.shopId } }),
      this.userRepo.findOne({ where: { id: params.actorUserId }, select: ['id', 'name'] }),
    ]);

    if (!shop) {
      throw new NotFoundException('SHOP_WORKSPACE_NOT_FOUND');
    }

    const globalPhoneHash = this.blindIndexService.computeGlobalPhoneHash(normalizedPhone);
    const phoneMasked = this.blindIndexService.maskPhone(normalizedPhone);
    const shareWithConsortium =
      shop.crmTrustAndIndustryConfigJson?.consortiumSharingEnabled !== false;

    const dedupSeed = params.trackingNumber?.trim()
      ? `TRACK:${params.trackingNumber.trim().toUpperCase()}`
      : params.orderCode?.trim()
        ? `ORDER:${params.orderCode.trim().toUpperCase()}`
        : `REASON:${params.reasonCode}`;
    const dedupFingerprint = crypto.createHash('sha256').update(dedupSeed).digest('hex');

    let isCarrierVerified = false;
    let verificationLevel = params.orderCode?.trim()
      ? PhoneTrustVerificationLevelEnum.ORDER_LINKED
      : PhoneTrustVerificationLevelEnum.SHOP_DECLARED;

    if (params.carrierCode && params.trackingNumber?.trim()) {
      const cfg = shop.crmTrustAndIndustryConfigJson;
      const ghnToken = cfg?.ghnTokenEncrypted
        ? this.messageCryptoService.decryptForConversation(
            cfg.ghnTokenEncrypted,
            `pii_vault:${params.shopId}`,
          )
        : null;
      const ghtkToken = cfg?.ghtkTokenEncrypted
        ? this.messageCryptoService.decryptForConversation(
            cfg.ghtkTokenEncrypted,
            `pii_vault:${params.shopId}`,
          )
        : null;

      const verifyRes = await this.providerAdapters.verifyTrackingNumberWithCarrier({
        carrierCode: params.carrierCode,
        trackingNumber: params.trackingNumber.trim(),
        decryptedGhnToken: ghnToken,
        decryptedGhtkToken: ghtkToken,
      });

      verificationLevel = this.providerAdapters.resolveVerificationLevelFromTracking(
        verifyRes,
        Boolean(params.orderCode?.trim()),
      );
      isCarrierVerified = verificationLevel === PhoneTrustVerificationLevelEnum.CARRIER_VERIFIED;
    }

    let report = await this.abuseReportRepo.findOne({
      where: {
        sourceShopId: params.shopId,
        globalPhoneHash,
        dedupFingerprint,
      },
    });

    const severity =
      params.reasonCode === PhoneTrustAbuseReasonCodeEnum.BOM_HANG || isCarrierVerified
        ? PhoneTrustAbuseSeverityEnum.CRITICAL
        : PhoneTrustAbuseSeverityEnum.HIGH;

    if (report) {
      report.reasonNote = params.reasonNote.trim();
      report.status = PhoneTrustReportStatusEnum.ACTIVE;
      report.retractedAt = null;
      report.retractedByUserId = null;
      report.retractReason = null;
      report.isCarrierVerified = report.isCarrierVerified || isCarrierVerified;
      report.verificationLevel = isCarrierVerified
        ? PhoneTrustVerificationLevelEnum.CARRIER_VERIFIED
        : report.verificationLevel;
      report.severity = severity;
      report.shareWithConsortium = shareWithConsortium;
      if (params.evidenceUrl) {
        report.evidenceUrl = params.evidenceUrl.trim();
      }
      report = await this.abuseReportRepo.save(report);
    } else {
      report = await this.abuseReportRepo.save(
        this.abuseReportRepo.create({
          globalPhoneHash,
          phoneMasked,
          sourceShopId: params.shopId,
          sourceCustomerId: params.customerId || null,
          reportedByUserId: params.actorUserId,
          reportedByName: actor?.name || 'Nhân sự cửa hàng',
          dedupFingerprint,
          reasonCode: params.reasonCode,
          reasonNote: params.reasonNote.trim(),
          carrierCode: params.carrierCode ? params.carrierCode.toUpperCase() : null,
          orderCode: params.orderCode?.trim() || null,
          trackingNumber: params.trackingNumber?.trim() || null,
          severity,
          verificationLevel,
          isCarrierVerified,
          evidenceUrl: params.evidenceUrl?.trim() || null,
          shareWithConsortium,
          status: PhoneTrustReportStatusEnum.ACTIVE,
        }),
      );
    }

    if (params.markBlacklisted) {
      const shopBlindHash = this.piiVaultService.computePhoneBlindSearchHash(
        params.shopId,
        normalizedPhone,
      );
      await this.customerRepo.update(
        { shopId: params.shopId, phoneSearchHash: shopBlindHash },
        {
          isBlacklisted: true,
          blacklistReason: params.reasonNote.trim(),
        },
      );
    }

    await this.recomputeGlobalAggregate(globalPhoneHash, phoneMasked);
    await this.invalidateLookupCacheByGlobalHash(globalPhoneHash);

    await this.piiVaultService.recordSecurityAuditLog({
      shopId: params.shopId,
      actorUserId: params.actorUserId,
      actionCode: SecurityAuditActionCodeEnum.PHONE_ABUSE_REPORT,
      targetResourceType: 'PHONE_TRUST_ABUSE_REPORT',
      targetResourceId: report.id,
      afterSnapshotJson: {
        phoneMasked,
        reasonCode: report.reasonCode,
        carrierCode: report.carrierCode,
        trackingNumber: report.trackingNumber,
        verificationLevel: report.verificationLevel,
        isCarrierVerified: report.isCarrierVerified,
      },
    });

    return {
      report,
      phoneMasked,
      globalPhoneHash,
    };
  }

  /**
   * Retracts an abuse report owned by the current shop and immediately recomputes the global score.
   */
  public async retractAbuseReport(params: {
    shopId: string;
    reportId: string;
    actorUserId: string;
    reason: string;
  }): Promise<PhoneTrustAbuseReportEntity> {
    const report = await this.abuseReportRepo.findOne({
      where: { id: params.reportId, sourceShopId: params.shopId },
    });
    if (!report) {
      throw new NotFoundException('PHONE_TRUST_ABUSE_REPORT_NOT_FOUND');
    }

    report.status = PhoneTrustReportStatusEnum.RETRACTED;
    report.retractedAt = new Date();
    report.retractedByUserId = params.actorUserId;
    report.retractReason = params.reason.trim();
    const saved = await this.abuseReportRepo.save(report);

    await this.recomputeGlobalAggregate(saved.globalPhoneHash, saved.phoneMasked);
    await this.invalidateLookupCacheByGlobalHash(saved.globalPhoneHash);

    await this.piiVaultService.recordSecurityAuditLog({
      shopId: params.shopId,
      actorUserId: params.actorUserId,
      actionCode: SecurityAuditActionCodeEnum.PHONE_ABUSE_REPORT,
      targetResourceType: 'PHONE_TRUST_ABUSE_REPORT_RETRACT',
      targetResourceId: saved.id,
      afterSnapshotJson: {
        phoneMasked: saved.phoneMasked,
        retractReason: saved.retractReason,
      },
    });

    return saved;
  }

  /**
   * Backfills existing shop customer delivery/return counts from customer_profiles
   * into the immutable phone_trust_delivery_events ledger so new deployments immediately
   * contribute real historical data to the multi-shop consortium.
   */
  public async backfillShopCustomerProfilesToLedger(shopId: string): Promise<{
    scannedCustomers: number;
    insertedEvents: number;
  }> {
    const shop = await this.shopRepo.findOne({ where: { id: shopId } });
    if (!shop) {
      throw new NotFoundException('SHOP_WORKSPACE_NOT_FOUND');
    }
    const shareWithConsortium =
      shop.crmTrustAndIndustryConfigJson?.consortiumSharingEnabled !== false;

    const customers = await this.customerRepo.find({
      where: { shopId },
      select: [
        'id',
        'phoneEncrypted',
        'successfulDeliveriesCount',
        'returnedOrdersCount',
        'lastOrderAt',
        'updatedAt',
      ],
    });

    let insertedEvents = 0;

    for (const customer of customers) {
      if (!customer.phoneEncrypted) continue;
      const rawPhone = this.piiVaultService.decryptPhoneInRam(shopId, customer.phoneEncrypted);
      if (!rawPhone) continue;

      const normalized = this.blindIndexService.normalizeVietnamesePhone(rawPhone);
      if (!this.blindIndexService.isValidVietnamesePhone(normalized)) continue;

      const occurredAt = customer.lastOrderAt || customer.updatedAt || new Date();
      const deliveredCount = Math.min(
        50,
        Math.max(0, Number(customer.successfulDeliveriesCount || 0)),
      );
      const returnedCount = Math.min(50, Math.max(0, Number(customer.returnedOrdersCount || 0)));

      for (let i = 1; i <= deliveredCount; i += 1) {
        const res = await this.recordDeliveryEvent({
          rawPhone: normalized,
          sourceShopId: shopId,
          sourceProvider: 'SHOP_BACKFILL_POS',
          externalEventKey: `bf:${shopId}:${customer.id}:del:${i}`,
          carrierCode: 'INTERNAL',
          eventOutcome: PhoneTrustEventOutcomeEnum.DELIVERED,
          verificationLevel: PhoneTrustVerificationLevelEnum.ORDER_LINKED,
          shareWithConsortium,
          occurredAt,
        });
        if (res.inserted) insertedEvents += 1;
      }

      for (let i = 1; i <= returnedCount; i += 1) {
        const res = await this.recordDeliveryEvent({
          rawPhone: normalized,
          sourceShopId: shopId,
          sourceProvider: 'SHOP_BACKFILL_POS',
          externalEventKey: `bf:${shopId}:${customer.id}:ret:${i}`,
          carrierCode: 'INTERNAL',
          eventOutcome: PhoneTrustEventOutcomeEnum.RETURNED,
          verificationLevel: PhoneTrustVerificationLevelEnum.ORDER_LINKED,
          shareWithConsortium,
          occurredAt,
        });
        if (res.inserted) insertedEvents += 1;
      }
    }

    return {
      scannedCustomers: customers.length,
      insertedEvents,
    };
  }

  /**
   * Bulk imports historical order delivery/return/abuse rows from CSV/ERP exports.
   */
  public async importHistoricalRows(params: {
    shopId: string;
    actorUserId: string;
    rows: Array<{
      rawPhone: string;
      deliveredCount?: number;
      returnedCount?: number;
      carrierCode?: string;
      orderCode?: string;
      trackingNumber?: string;
      abuseReasonNote?: string;
      abuseReasonCode?: PhoneTrustAbuseReasonCodeEnum;
    }>;
  }): Promise<{
    processedRows: number;
    insertedEvents: number;
    submittedReports: number;
    skippedInvalidRows: number;
  }> {
    let insertedEvents = 0;
    let submittedReports = 0;
    let skippedInvalidRows = 0;

    for (let idx = 0; idx < params.rows.length; idx += 1) {
      const row = params.rows[idx];
      const normalized = this.blindIndexService.normalizeVietnamesePhone(row.rawPhone);
      if (!this.blindIndexService.isValidVietnamesePhone(normalized)) {
        skippedInvalidRows += 1;
        continue;
      }

      const delivered = Math.min(50, Math.max(0, Number(row.deliveredCount || 0)));
      const returned = Math.min(50, Math.max(0, Number(row.returnedCount || 0)));
      const rowKeyBase =
        row.trackingNumber?.trim() || row.orderCode?.trim() || `${normalized}:${idx}`;

      for (let i = 1; i <= delivered; i += 1) {
        const res = await this.recordDeliveryEvent({
          rawPhone: normalized,
          sourceShopId: params.shopId,
          sourceProvider: 'SHOP_BULK_IMPORT',
          externalEventKey: `imp:${params.shopId}:${rowKeyBase}:del:${i}`,
          carrierCode: row.carrierCode || 'INTERNAL',
          trackingNumber: row.trackingNumber || null,
          orderCode: row.orderCode || null,
          eventOutcome: PhoneTrustEventOutcomeEnum.DELIVERED,
          verificationLevel: row.trackingNumber
            ? PhoneTrustVerificationLevelEnum.ORDER_LINKED
            : PhoneTrustVerificationLevelEnum.SHOP_DECLARED,
        });
        if (res.inserted) insertedEvents += 1;
      }

      for (let i = 1; i <= returned; i += 1) {
        const res = await this.recordDeliveryEvent({
          rawPhone: normalized,
          sourceShopId: params.shopId,
          sourceProvider: 'SHOP_BULK_IMPORT',
          externalEventKey: `imp:${params.shopId}:${rowKeyBase}:ret:${i}`,
          carrierCode: row.carrierCode || 'INTERNAL',
          trackingNumber: row.trackingNumber || null,
          orderCode: row.orderCode || null,
          eventOutcome: PhoneTrustEventOutcomeEnum.RETURNED,
          verificationLevel: row.trackingNumber
            ? PhoneTrustVerificationLevelEnum.ORDER_LINKED
            : PhoneTrustVerificationLevelEnum.SHOP_DECLARED,
        });
        if (res.inserted) insertedEvents += 1;
      }

      if (row.abuseReasonNote && row.abuseReasonNote.trim()) {
        await this.submitAbuseReport({
          shopId: params.shopId,
          actorUserId: params.actorUserId,
          rawPhone: normalized,
          reasonCode: row.abuseReasonCode || PhoneTrustAbuseReasonCodeEnum.BOM_HANG,
          reasonNote: row.abuseReasonNote.trim(),
          carrierCode: row.carrierCode || null,
          orderCode: row.orderCode || null,
          trackingNumber: row.trackingNumber || null,
        });
        submittedReports += 1;
      }
    }

    return {
      processedRows: params.rows.length,
      insertedEvents,
      submittedReports,
      skippedInvalidRows,
    };
  }
}
