import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { PosOrderStatusEnum } from 'src/common/enum';
import { CommunityPhoneAbuseReportEntity } from 'src/entity/community-phone-abuse-report.entity';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import {
  CarrierReputationBreakdownMap,
  PhoneReputationLedgerEntity,
  ProcessedOrderReputationMarker,
} from 'src/entity/phone-reputation-ledger.entity';
import { PosOrderEntity } from 'src/entity/pos-order.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { Repository } from 'typeorm';

import { PiiVaultAndAuditService } from './pii-vault-and-audit.service';

export interface OmsOrderStatusChangedEventPayload {
  shopId: string;
  orderId: string;
  previousStatus?: PosOrderStatusEnum;
  status: PosOrderStatusEnum;
  reasonNote?: string | null;
}

const DELIVERED_OUTCOME_STATUSES = new Set<PosOrderStatusEnum>([
  PosOrderStatusEnum.DELIVERED,
  PosOrderStatusEnum.DELIVERED_RECONCILED,
]);

const RETURNED_OUTCOME_STATUSES = new Set<PosOrderStatusEnum>([
  PosOrderStatusEnum.RETURNING,
  PosOrderStatusEnum.RETURNED_RESTOCKED,
]);

@Injectable()
export class PhoneReputationSyncService {
  private readonly logger = new Logger(PhoneReputationSyncService.name);

  constructor(
    @InjectRepository(PhoneReputationLedgerEntity)
    private readonly ledgerRepo: Repository<PhoneReputationLedgerEntity>,
    @InjectRepository(CommunityPhoneAbuseReportEntity)
    private readonly abuseReportRepo: Repository<CommunityPhoneAbuseReportEntity>,
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(PosOrderEntity)
    private readonly posOrderRepo: Repository<PosOrderEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    private readonly piiVaultService: PiiVaultAndAuditService,
  ) {}

  private normalizeCarrierKey(carrierCode?: string | null): string {
    const raw = (carrierCode || 'INTERNAL').trim().toUpperCase();
    if (raw === 'VIETTELPOST' || raw === 'VIETTEL_POST') return 'VTP';
    if (raw === 'J&T' || raw === 'JT_EXPRESS') return 'JT';
    if (raw === 'SHOPEE') return 'SPX';
    return raw || 'INTERNAL';
  }

  /**
   * Lắng nghe sự kiện chuyển trạng thái đơn hàng từ OMS (State Machine / Carrier Webhook / COD / Return)
   * để tự động đồng bộ chuẩn xác sang `CustomerProfileEntity` và `PhoneReputationLedgerEntity`.
   */
  @OnEvent('oms.order.status_changed', { async: true })
  public async handleOmsOrderStatusChanged(
    payload: OmsOrderStatusChangedEventPayload,
  ): Promise<void> {
    if (!payload?.shopId || !payload?.orderId) return;

    try {
      const order = await this.posOrderRepo.findOne({
        where: { id: payload.orderId, shopId: payload.shopId },
      });
      if (!order) return;

      await this.syncSingleOrderOutcomeToReputationLedger(order);
    } catch (err) {
      this.logger.warn(
        `Failed to sync order ${payload.orderId} to phone reputation ledger: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Đồng bộ idempotent 1 đơn hàng sang Sổ cái Toàn Mạng Lưới (`phone_reputation_ledgers`)
   * và đồng bộ lại counter thực tế của `CustomerProfileEntity` trong chính cửa hàng đó.
   */
  public async syncSingleOrderOutcomeToReputationLedger(order: PosOrderEntity): Promise<{
    synced: boolean;
    phoneGlobalHash: string | null;
    outcome: 'DELIVERED' | 'RETURNED' | 'FAILED_ATTEMPT' | null;
  }> {
    const outcome: 'DELIVERED' | 'RETURNED' | 'FAILED_ATTEMPT' | null =
      DELIVERED_OUTCOME_STATUSES.has(order.status)
        ? 'DELIVERED'
        : RETURNED_OUTCOME_STATUSES.has(order.status)
          ? 'RETURNED'
          : order.status === PosOrderStatusEnum.DELIVERY_FAILED_RESCUE
            ? 'FAILED_ATTEMPT'
            : null;

    if (!outcome) {
      return { synced: false, phoneGlobalHash: null, outcome: null };
    }

    let rawPhone: string | null = null;
    if (order.customerPhoneEncrypted) {
      rawPhone = this.piiVaultService.decryptPhoneInRam(order.shopId, order.customerPhoneEncrypted);
    }

    let customer: CustomerProfileEntity | null = null;
    if (order.customerId) {
      customer = await this.customerRepo.findOne({
        where: { id: order.customerId, shopId: order.shopId },
      });
      if (!rawPhone && customer?.phoneEncrypted) {
        rawPhone = this.piiVaultService.decryptPhoneInRam(order.shopId, customer.phoneEncrypted);
      }
    }

    if (!rawPhone || rawPhone.includes('[')) {
      return { synced: false, phoneGlobalHash: null, outcome };
    }

    const normalizedPhone = this.piiVaultService.normalizeLocalVietnamesePhone(rawPhone);
    if (normalizedPhone.length < 9) {
      return { synced: false, phoneGlobalHash: null, outcome };
    }

    const phoneGlobalHash = this.piiVaultService.computeGlobalPhoneConsortiumHash(normalizedPhone);
    const phoneMasked = this.piiVaultService.maskPhoneNumber(normalizedPhone);
    const carrierKey = this.normalizeCarrierKey(order.carrierCode);
    const now = new Date();
    const nowIso = now.toISOString();

    // 1. Đồng bộ counter chính xác từ PosOrderEntity về CustomerProfileEntity của shop hiện tại
    if (customer) {
      const [shopDeliveredCount, shopReturnedCount, shopTotalCount] = await Promise.all([
        this.posOrderRepo
          .createQueryBuilder('o')
          .where('o.shop_id = :shopId AND o.customer_id = :customerId AND o.status IN (:...st)', {
            shopId: order.shopId,
            customerId: customer.id,
            st: [PosOrderStatusEnum.DELIVERED, PosOrderStatusEnum.DELIVERED_RECONCILED],
          })
          .getCount(),
        this.posOrderRepo
          .createQueryBuilder('o')
          .where('o.shop_id = :shopId AND o.customer_id = :customerId AND o.status IN (:...st)', {
            shopId: order.shopId,
            customerId: customer.id,
            st: [PosOrderStatusEnum.RETURNING, PosOrderStatusEnum.RETURNED_RESTOCKED],
          })
          .getCount(),
        this.posOrderRepo.count({
          where: { shopId: order.shopId, customerId: customer.id },
        }),
      ]);

      customer.phoneGlobalHash = phoneGlobalHash;
      customer.successfulDeliveriesCount = Math.max(
        Number(customer.successfulDeliveriesCount || 0),
        shopDeliveredCount,
      );
      customer.returnedOrdersCount = Math.max(
        Number(customer.returnedOrdersCount || 0),
        shopReturnedCount,
      );
      customer.totalOrdersCount = Math.max(Number(customer.totalOrdersCount || 0), shopTotalCount);
      await this.customerRepo.save(customer);
    }

    // 2. Kiểm tra xem shop có bật chia sẻ Consortium ẩn danh hay không (mặc định bật)
    const shop = await this.shopRepo.findOne({ where: { id: order.shopId } });
    if (shop?.crmTrustAndIndustryConfigJson?.consortiumSharingEnabled === false) {
      return { synced: true, phoneGlobalHash, outcome };
    }

    // 3. Cập nhật idempotent Sổ cái Toàn Mạng Lưới (`phone_reputation_ledgers`)
    let ledger = await this.ledgerRepo.findOne({ where: { phoneGlobalHash } });
    if (!ledger) {
      ledger = this.ledgerRepo.create({
        phoneGlobalHash,
        phoneMaskedHint: phoneMasked,
        totalDeliveredCount: 0,
        totalReturnedCount: 0,
        totalFailedAttemptCount: 0,
        activeAbuseReportsCount: 0,
        verifiedAbuseReportsCount: 0,
        uniqueShopsDeliveredJson: [],
        uniqueShopsReturnedJson: [],
        uniqueShopsReportedJson: [],
        carrierBreakdownJson: {},
        processedOrdersJson: [],
      });
    }

    const processed: ProcessedOrderReputationMarker[] = Array.isArray(ledger.processedOrdersJson)
      ? [...ledger.processedOrdersJson]
      : [];
    const existingIdx = processed.findIndex((m) => m.orderId === order.id);

    if (existingIdx !== -1 && processed[existingIdx].outcome === outcome) {
      return { synced: true, phoneGlobalHash, outcome };
    }

    const breakdown: CarrierReputationBreakdownMap = {
      ...(ledger.carrierBreakdownJson || {}),
    };
    const ensureBucket = (key: string) => {
      if (!breakdown[key]) {
        breakdown[key] = {
          deliveredCount: 0,
          returnedCount: 0,
          failedAttemptCount: 0,
          reportedCount: 0,
          lastEventAt: null,
        };
      }
      return breakdown[key];
    };

    // Nếu đơn trước đó đang là FAILED_ATTEMPT rồi sau đó DELIVERED hoặc RETURNED -> hoàn tác đếm cũ trước khi cộng mới
    if (existingIdx !== -1) {
      const prevMarker = processed[existingIdx];
      const prevBucket = ensureBucket(prevMarker.carrierCode);
      if (prevMarker.outcome === 'DELIVERED') {
        ledger.totalDeliveredCount = Math.max(0, ledger.totalDeliveredCount - 1);
        prevBucket.deliveredCount = Math.max(0, prevBucket.deliveredCount - 1);
      } else if (prevMarker.outcome === 'RETURNED') {
        ledger.totalReturnedCount = Math.max(0, ledger.totalReturnedCount - 1);
        prevBucket.returnedCount = Math.max(0, prevBucket.returnedCount - 1);
      } else if (prevMarker.outcome === 'FAILED_ATTEMPT') {
        ledger.totalFailedAttemptCount = Math.max(0, ledger.totalFailedAttemptCount - 1);
        prevBucket.failedAttemptCount = Math.max(0, prevBucket.failedAttemptCount - 1);
      }
      processed.splice(existingIdx, 1);
    }

    const targetBucket = ensureBucket(carrierKey);
    const shopsDelivered = new Set<string>(ledger.uniqueShopsDeliveredJson || []);
    const shopsReturned = new Set<string>(ledger.uniqueShopsReturnedJson || []);

    if (outcome === 'DELIVERED') {
      ledger.totalDeliveredCount += 1;
      targetBucket.deliveredCount += 1;
      shopsDelivered.add(order.shopId);
    } else if (outcome === 'RETURNED') {
      ledger.totalReturnedCount += 1;
      targetBucket.returnedCount += 1;
      shopsReturned.add(order.shopId);
    } else if (outcome === 'FAILED_ATTEMPT') {
      ledger.totalFailedAttemptCount += 1;
      targetBucket.failedAttemptCount += 1;
    }

    targetBucket.lastEventAt = nowIso;
    processed.unshift({
      orderId: order.id,
      shopId: order.shopId,
      carrierCode: carrierKey,
      outcome,
      recordedAt: nowIso,
    });

    ledger.carrierBreakdownJson = breakdown;
    ledger.uniqueShopsDeliveredJson = Array.from(shopsDelivered);
    ledger.uniqueShopsReturnedJson = Array.from(shopsReturned);
    ledger.processedOrdersJson = processed.slice(0, 500);
    ledger.lastOrderEventAt = now;
    if (!ledger.phoneMaskedHint && phoneMasked) {
      ledger.phoneMaskedHint = phoneMasked;
    }

    await this.ledgerRepo.save(ledger);
    return { synced: true, phoneGlobalHash, outcome };
  }

  /**
   * Đồng bộ lại số lượng báo xấu ACTIVE trong `phone_reputation_ledgers` sau khi thêm hoặc gỡ báo cáo.
   */
  public async recalculateAbuseReportCountersForPhoneHash(
    phoneGlobalHash: string,
    phoneMaskedHint?: string | null,
  ): Promise<PhoneReputationLedgerEntity> {
    const activeReports = await this.abuseReportRepo.find({
      where: { phoneGlobalHash, status: 'ACTIVE' },
      order: { createdAt: 'DESC' },
    });

    let ledger = await this.ledgerRepo.findOne({ where: { phoneGlobalHash } });
    if (!ledger) {
      ledger = this.ledgerRepo.create({
        phoneGlobalHash,
        phoneMaskedHint: phoneMaskedHint || null,
        totalDeliveredCount: 0,
        totalReturnedCount: 0,
        totalFailedAttemptCount: 0,
        activeAbuseReportsCount: 0,
        verifiedAbuseReportsCount: 0,
        uniqueShopsDeliveredJson: [],
        uniqueShopsReturnedJson: [],
        uniqueShopsReportedJson: [],
        carrierBreakdownJson: {},
        processedOrdersJson: [],
      });
    }

    const breakdown: CarrierReputationBreakdownMap = {
      ...(ledger.carrierBreakdownJson || {}),
    };
    for (const key of Object.keys(breakdown)) {
      breakdown[key].reportedCount = 0;
    }

    const shopsReported = new Set<string>();
    let verifiedCount = 0;

    for (const rep of activeReports) {
      shopsReported.add(rep.reporterShopId);
      if (rep.verificationLevel === 'CARRIER_VERIFIED') {
        verifiedCount += 1;
      }
      const cKey = this.normalizeCarrierKey(rep.carrierCode || 'INTERNAL');
      if (!breakdown[cKey]) {
        breakdown[cKey] = {
          deliveredCount: 0,
          returnedCount: 0,
          failedAttemptCount: 0,
          reportedCount: 0,
          lastEventAt: null,
        };
      }
      breakdown[cKey].reportedCount += 1;
      if (!breakdown[cKey].lastEventAt) {
        breakdown[cKey].lastEventAt = new Date(rep.createdAt || Date.now()).toISOString();
      }
    }

    ledger.activeAbuseReportsCount = activeReports.length;
    ledger.verifiedAbuseReportsCount = verifiedCount;
    ledger.uniqueShopsReportedJson = Array.from(shopsReported);
    ledger.carrierBreakdownJson = breakdown;
    ledger.lastReportAt = activeReports[0]?.createdAt ? new Date(activeReports[0].createdAt) : null;

    return this.ledgerRepo.save(ledger);
  }

  /**
   * Công cụ Backfill 1 chạm: Quét toàn bộ khách hàng & đơn hàng hiện có của Shop để:
   * 1) Bổ sung `phoneGlobalHash` cho tất cả `customer_profiles` cũ chưa có cột này.
   * 2) Nạp toàn bộ đơn `DELIVERED`, `DELIVERED_RECONCILED`, `RETURNING`, `RETURNED_RESTOCKED`, `DELIVERY_FAILED_RESCUE`
   *    vào `phone_reputation_ledgers` và đồng bộ lại counter trên `customer_profiles`.
   */
  public async backfillShopPhoneReputationLedger(shopId: string): Promise<{
    customersHashedCount: number;
    ordersSyncedCount: number;
    reportsMigratedCount: number;
  }> {
    let customersHashedCount = 0;
    let ordersSyncedCount = 0;
    let reportsMigratedCount = 0;

    const shop = await this.shopRepo.findOne({ where: { id: shopId } });
    const shopAlias = shop?.name || `Shop #${shopId.slice(0, 6)}`;

    // 1. Backfill phoneGlobalHash + chuyển báo cáo xấu cũ sang community_phone_abuse_reports
    const customers = await this.customerRepo.find({ where: { shopId } });
    for (const cust of customers) {
      if (!cust.phoneEncrypted) continue;
      const decrypted = this.piiVaultService.decryptPhoneInRam(shopId, cust.phoneEncrypted);
      if (!decrypted || decrypted.includes('[')) continue;

      const globalHash = this.piiVaultService.computeGlobalPhoneConsortiumHash(decrypted);
      if (cust.phoneGlobalHash !== globalHash) {
        cust.phoneGlobalHash = globalHash;
        await this.customerRepo.save(cust);
        customersHashedCount += 1;
      }

      if (Array.isArray(cust.reportedReasonsJson) && cust.reportedReasonsJson.length > 0) {
        for (const rep of cust.reportedReasonsJson) {
          const dedupeKey = (rep.orderCode || rep.reportId || 'LEGACY').trim().slice(0, 96);
          const existing = await this.abuseReportRepo.findOne({
            where: {
              phoneGlobalHash: globalHash,
              reporterShopId: shopId,
              dedupeKey,
            },
          });
          if (!existing) {
            await this.abuseReportRepo.save(
              this.abuseReportRepo.create({
                phoneGlobalHash: globalHash,
                phoneMaskedHint: cust.phoneMasked,
                reporterShopId: shopId,
                reporterShopAlias: shopAlias,
                reporterUserId: 'system_backfill',
                customerId: cust.id,
                dedupeKey,
                reasonCode: rep.reasonCode || 'BOM_HANG',
                reasonNote: rep.reasonNote || rep.reason || 'Báo cáo xấu từ hồ sơ CRM',
                sourceCode: rep.source || 'SHOP_INTERNAL',
                carrierCode: rep.carrierCode || null,
                orderCode: rep.orderCode || null,
                trackingNumber: rep.trackingNumber || null,
                verificationLevel: rep.isCarrierVerified ? 'CARRIER_VERIFIED' : 'SHOP_DECLARED',
                severity: rep.severity || 'HIGH',
                status: 'ACTIVE',
              }),
            );
            reportsMigratedCount += 1;
          }
        }
        await this.recalculateAbuseReportCountersForPhoneHash(globalHash, cust.phoneMasked);
      }
    }

    // 2. Backfill toàn bộ đơn hàng OMS có kết quả giao/hoàn
    const orders = await this.posOrderRepo
      .createQueryBuilder('o')
      .where('o.shop_id = :shopId AND o.status IN (:...st)', {
        shopId,
        st: [
          PosOrderStatusEnum.DELIVERED,
          PosOrderStatusEnum.DELIVERED_RECONCILED,
          PosOrderStatusEnum.RETURNING,
          PosOrderStatusEnum.RETURNED_RESTOCKED,
          PosOrderStatusEnum.DELIVERY_FAILED_RESCUE,
        ],
      })
      .orderBy('o.created_at', 'ASC')
      .getMany();

    for (const ord of orders) {
      const res = await this.syncSingleOrderOutcomeToReputationLedger(ord);
      if (res.synced) {
        ordersSyncedCount += 1;
      }
    }

    return {
      customersHashedCount,
      ordersSyncedCount,
      reportsMigratedCount,
    };
  }

  /**
   * Nạp hàng loạt lịch sử Giao thành công / Hoàn đơn / Báo xấu từ file Excel/CSV đối soát 3PL
   * hoặc dữ liệu phần mềm cũ mà KHÔNG cần bất kỳ API Key hay kết nối shop nào khác.
   */
  public async importPhoneTrustHistoryRows(params: {
    shopId: string;
    actorUserId: string;
    rows: Array<{
      rawPhone: string;
      deliveredCount?: number;
      returnedCount?: number;
      carrierCode?: string | null;
      orderCode?: string | null;
      trackingNumber?: string | null;
      abuseReasonNote?: string | null;
      abuseReasonCode?: string | null;
    }>;
  }): Promise<{
    processedPhonesCount: number;
    skippedInvalidCount: number;
    importedDeliveredTotal: number;
    importedReturnedTotal: number;
    importedReportsTotal: number;
  }> {
    let processedPhonesCount = 0;
    let skippedInvalidCount = 0;
    let importedDeliveredTotal = 0;
    let importedReturnedTotal = 0;
    let importedReportsTotal = 0;

    const shop = await this.shopRepo.findOne({ where: { id: params.shopId } });
    const shopAlias = shop?.name || `Shop #${params.shopId.slice(0, 6)}`;
    const now = new Date();
    const nowIso = now.toISOString();

    for (const row of params.rows || []) {
      const normalized = this.piiVaultService.normalizeLocalVietnamesePhone(row.rawPhone || '');
      if (normalized.length < 9) {
        skippedInvalidCount += 1;
        continue;
      }

      const phoneGlobalHash = this.piiVaultService.computeGlobalPhoneConsortiumHash(normalized);
      const phoneMasked = this.piiVaultService.maskPhoneNumber(normalized);
      const carrierKey = this.normalizeCarrierKey(row.carrierCode || 'INTERNAL');
      const addDelivered = Math.max(0, Number(row.deliveredCount || 0));
      const addReturned = Math.max(0, Number(row.returnedCount || 0));

      let ledger = await this.ledgerRepo.findOne({ where: { phoneGlobalHash } });
      if (!ledger) {
        ledger = this.ledgerRepo.create({
          phoneGlobalHash,
          phoneMaskedHint: phoneMasked,
          totalDeliveredCount: 0,
          totalReturnedCount: 0,
          totalFailedAttemptCount: 0,
          activeAbuseReportsCount: 0,
          verifiedAbuseReportsCount: 0,
          uniqueShopsDeliveredJson: [],
          uniqueShopsReturnedJson: [],
          uniqueShopsReportedJson: [],
          carrierBreakdownJson: {},
          processedOrdersJson: [],
        });
      }

      const breakdown: CarrierReputationBreakdownMap = {
        ...(ledger.carrierBreakdownJson || {}),
      };
      if (!breakdown[carrierKey]) {
        breakdown[carrierKey] = {
          deliveredCount: 0,
          returnedCount: 0,
          failedAttemptCount: 0,
          reportedCount: 0,
          lastEventAt: null,
        };
      }

      if (addDelivered > 0) {
        ledger.totalDeliveredCount += addDelivered;
        breakdown[carrierKey].deliveredCount += addDelivered;
        importedDeliveredTotal += addDelivered;
      }
      if (addReturned > 0) {
        ledger.totalReturnedCount += addReturned;
        breakdown[carrierKey].returnedCount += addReturned;
        importedReturnedTotal += addReturned;
      }
      breakdown[carrierKey].lastEventAt = nowIso;
      ledger.carrierBreakdownJson = breakdown;
      ledger.lastOrderEventAt = now;
      await this.ledgerRepo.save(ledger);

      if (row.abuseReasonNote && row.abuseReasonNote.trim()) {
        const dedupeKey = (
          row.orderCode?.trim() ||
          row.trackingNumber?.trim() ||
          `IMPORT_${carrierKey}_${nowIso.slice(0, 10)}`
        ).slice(0, 96);

        const existingRep = await this.abuseReportRepo.findOne({
          where: {
            phoneGlobalHash,
            reporterShopId: params.shopId,
            dedupeKey,
          },
        });

        if (!existingRep) {
          await this.abuseReportRepo.save(
            this.abuseReportRepo.create({
              phoneGlobalHash,
              phoneMaskedHint: phoneMasked,
              reporterShopId: params.shopId,
              reporterShopAlias: shopAlias,
              reporterUserId: params.actorUserId,
              customerId: null,
              dedupeKey,
              reasonCode: row.abuseReasonCode || 'BOM_HANG',
              reasonNote: row.abuseReasonNote.trim(),
              sourceCode: carrierKey === 'INTERNAL' ? 'SHOP_INTERNAL' : `CARRIER_3PL_${carrierKey}`,
              carrierCode: carrierKey === 'INTERNAL' ? null : carrierKey,
              orderCode: row.orderCode?.trim() || null,
              trackingNumber: row.trackingNumber?.trim() || null,
              verificationLevel: row.trackingNumber ? 'CARRIER_VERIFIED' : 'SHOP_DECLARED',
              severity: row.trackingNumber ? 'CRITICAL' : 'HIGH',
              status: 'ACTIVE',
            }),
          );
          importedReportsTotal += 1;
          await this.recalculateAbuseReportCountersForPhoneHash(phoneGlobalHash, phoneMasked);
        }
      }

      // Cập nhật ngay vào CustomerProfile nếu SĐT đã tồn tại trong shop
      const matchedCustomer = await this.customerRepo.findOne({
        where: { shopId: params.shopId, phoneGlobalHash },
      });
      if (matchedCustomer) {
        matchedCustomer.networkDeliveredCount = Math.max(
          Number(matchedCustomer.networkDeliveredCount || 0),
          ledger.totalDeliveredCount,
        );
        matchedCustomer.networkReturnedCount = Math.max(
          Number(matchedCustomer.networkReturnedCount || 0),
          ledger.totalReturnedCount,
        );
        matchedCustomer.reportedCount = Math.max(
          Number(matchedCustomer.reportedCount || 0),
          ledger.activeAbuseReportsCount,
        );
        await this.customerRepo.save(matchedCustomer);
      }

      processedPhonesCount += 1;
    }

    return {
      processedPhonesCount,
      skippedInvalidCount,
      importedDeliveredTotal,
      importedReturnedTotal,
      importedReportsTotal,
    };
  }
}
