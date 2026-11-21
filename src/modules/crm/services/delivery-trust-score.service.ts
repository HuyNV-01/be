import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import {
  ChannelTypeEnum,
  DeliveryTrustBandEnum,
  PhoneTrustLookupSourceEnum,
  PosOrderStatusEnum,
} from 'src/common/enum';
import { CommunityPhoneAbuseReportEntity } from 'src/entity/community-phone-abuse-report.entity';
import {
  CustomerAbuseReportItem,
  CustomerProfileEntity,
  PersistedTrustProviderDiagnosticItem,
  PersistedTrustSourceBreakdownItem,
} from 'src/entity/customer-profile.entity';
import { PhoneReputationLedgerEntity } from 'src/entity/phone-reputation-ledger.entity';
import { PosOrderEntity } from 'src/entity/pos-order.entity';
import { CrmTrustAndIndustryConfig } from 'src/entity/shop-workspace.entity';
import { Repository } from 'typeorm';

import { PiiVaultAndAuditService } from './pii-vault-and-audit.service';
import { PublicWebRiskProviderService } from './public-web-risk-provider.service';

export type DeliverySourceCodeType =
  | 'INTERNAL_SHOP_POS'
  | 'PANCAKE_COMMUNITY'
  | 'CARRIER_3PL_VTP'
  | 'CARRIER_3PL_GHN'
  | 'CARRIER_3PL_GHTK'
  | 'CARRIER_3PL_JT'
  | 'MARKETPLACE_SHOPEE'
  | 'CUSTOM_WEBHOOK_PROVIDER';

export type DeliverySourceBreakdownItem = PersistedTrustSourceBreakdownItem & {
  sourceCode: DeliverySourceCodeType;
};

export interface DeliveryTrustEvaluationResult {
  score: number;
  band: DeliveryTrustBandEnum;
  badgeVariant: 'success' | 'info' | 'warning' | 'danger';
  headline: string;
  recommendation: string;
  requireDepositVietQr: boolean;
  successRatePercent: number;
  returnRatePercent: number;
  totalDeliveredCount: number;
  shopDeliveredCount: number;
  networkDeliveredCount: number;
  totalReturnedCount: number;
  shopReturnedCount: number;
  networkReturnedCount: number;
  reportedCount: number;
  verifiedReportedCount: number;
  reportedReasons: CustomerAbuseReportItem[];
  sourceBreakdowns: DeliverySourceBreakdownItem[];
  providerDiagnostics: PersistedTrustProviderDiagnosticItem[];
  lookupSource: string;
  lookupSourceLabel: string;
  checkedAt: string;
}

export interface ExternalPhoneReputationLookupResult {
  shopDeliveredCount: number;
  shopReturnedCount: number;
  networkDeliveredCount: number;
  networkReturnedCount: number;
  reportedCount: number;
  verifiedReportedCount: number;
  reportedReasons: CustomerAbuseReportItem[];
  sourceBreakdowns: DeliverySourceBreakdownItem[];
  providerDiagnostics: PersistedTrustProviderDiagnosticItem[];
  lookupSource: string;
  lookupSourceLabel: string;
  phoneGlobalHash: string | null;
  hasPhoneIdentifier: boolean;
  warningMessage: string | null;
}

const SOURCE_META_MAP: Record<
  DeliverySourceCodeType,
  { sourceName: string; shortLabel: string; confidenceWeight: number }
> = {
  INTERNAL_SHOP_POS: {
    sourceName: 'Đơn nội bộ cửa hàng (OMS/POS)',
    shortLabel: 'POS nội bộ',
    confidenceWeight: 1.0,
  },
  PANCAKE_COMMUNITY: {
    sourceName: 'Mạng lưới Cộng đồng Liên Shop & Cổng Công Khai',
    shortLabel: 'Cộng đồng',
    confidenceWeight: 0.92,
  },
  CARRIER_3PL_VTP: {
    sourceName: 'ViettelPost (VTP)',
    shortLabel: 'ViettelPost',
    confidenceWeight: 1.0,
  },
  CARRIER_3PL_GHN: {
    sourceName: 'Giao Hàng Nhanh (GHN)',
    shortLabel: 'GHN',
    confidenceWeight: 1.0,
  },
  CARRIER_3PL_GHTK: {
    sourceName: 'Giao Hàng Tiết Kiệm (GHTK)',
    shortLabel: 'GHTK',
    confidenceWeight: 1.0,
  },
  CARRIER_3PL_JT: {
    sourceName: 'J&T Express',
    shortLabel: 'J&T',
    confidenceWeight: 0.95,
  },
  MARKETPLACE_SHOPEE: {
    sourceName: 'Sàn Shopee / SPX Express',
    shortLabel: 'Shopee / SPX',
    confidenceWeight: 0.95,
  },
  CUSTOM_WEBHOOK_PROVIDER: {
    sourceName: 'Cổng Đối Tác Nền Tảng',
    shortLabel: 'Đối tác mở rộng',
    confidenceWeight: 0.9,
  },
};

const PLATFORM_HUB_TIMEOUT_MS = 3500;
const PLATFORM_HUB_CACHE_TTL_SECONDS = 900;

@Injectable()
export class DeliveryTrustScoreService {
  private readonly logger = new Logger(DeliveryTrustScoreService.name);

  constructor(
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(PosOrderEntity)
    private readonly posOrderRepo: Repository<PosOrderEntity>,
    @InjectRepository(PhoneReputationLedgerEntity)
    private readonly ledgerRepo: Repository<PhoneReputationLedgerEntity>,
    @InjectRepository(CommunityPhoneAbuseReportEntity)
    private readonly abuseReportRepo: Repository<CommunityPhoneAbuseReportEntity>,
    @InjectRedis() private readonly redis: Redis,
    private readonly piiVaultService: PiiVaultAndAuditService,
    private readonly publicWebRiskProvider: PublicWebRiskProviderService,
  ) {}

  public resolveLookupSourceLabel(source?: string | null, carriers?: string[]): string {
    const carrierStr =
      carriers && carriers.length > 0 ? carriers.join('/') : 'VTP/GHN/GHTK/J&T/Shopee';
    switch (source) {
      case PhoneTrustLookupSourceEnum.INTERNAL_SHOP_POS:
        return 'POS nội bộ cửa hàng';
      case PhoneTrustLookupSourceEnum.PANCAKE_COMMUNITY_NETWORK:
        return 'Mạng lưới Cộng đồng liên shop';
      case PhoneTrustLookupSourceEnum.CARRIER_3PL_GHN_GHTK:
        return `ĐVVC 3PL (${carrierStr})`;
      default:
        return `Tự động Đa nguồn (Cộng đồng + ${carrierStr})`;
    }
  }

  public resolveReportSourceBadgeLabel(
    source?: string | null,
    carrierCode?: string | null,
  ): string {
    const upperCarrier = carrierCode ? carrierCode.trim().toUpperCase() : '';
    if (upperCarrier === 'VTP' || upperCarrier === 'VIETTELPOST') return 'ViettelPost';
    if (upperCarrier === 'GHN') return 'Giao Hàng Nhanh (GHN)';
    if (upperCarrier === 'GHTK') return 'Giao Hàng Tiết Kiệm (GHTK)';
    if (upperCarrier === 'JT' || upperCarrier === 'J&T') return 'J&T Express';
    if (upperCarrier === 'SPX' || upperCarrier === 'SHOPEE') return 'Shopee / SPX';
    if (upperCarrier) return `ĐVVC ${upperCarrier}`;

    switch (source) {
      case 'SHOP_INTERNAL':
        return 'POS nội bộ';
      case 'PANCAKE_COMMUNITY':
      case 'PANCAKE_V2':
      case 'PANCAKE_POS':
        return 'Cộng đồng liên shop';
      case 'CARRIER_3PL_GHN':
        return 'Giao Hàng Nhanh (GHN)';
      case 'CARRIER_3PL_GHTK':
        return 'Giao Hàng Tiết Kiệm (GHTK)';
      case 'CARRIER_3PL_VTP':
        return 'ViettelPost';
      case 'CARRIER_3PL_JT':
        return 'J&T Express';
      case 'MARKETPLACE_SHOPEE':
        return 'Shopee / SPX';
      default:
        return source || 'Hệ thống cảnh báo';
    }
  }

  private mapCarrierOrChannelToSourceCode(
    carrierCode?: string | null,
    channelType?: ChannelTypeEnum | string | null,
  ): DeliverySourceCodeType {
    const upperCarrier = (carrierCode || '').trim().toUpperCase();
    if (
      upperCarrier === 'VTP' ||
      upperCarrier === 'VIETTELPOST' ||
      upperCarrier === 'VIETTEL_POST'
    ) {
      return 'CARRIER_3PL_VTP';
    }
    if (upperCarrier === 'GHN') return 'CARRIER_3PL_GHN';
    if (upperCarrier === 'GHTK') return 'CARRIER_3PL_GHTK';
    if (upperCarrier === 'JT' || upperCarrier === 'J&T' || upperCarrier === 'JT_EXPRESS') {
      return 'CARRIER_3PL_JT';
    }
    if (
      upperCarrier === 'SPX' ||
      upperCarrier === 'SHOPEE' ||
      channelType === ChannelTypeEnum.SHOPEE
    ) {
      return 'MARKETPLACE_SHOPEE';
    }
    return 'INTERNAL_SHOP_POS';
  }

  private normalizeCarrierReportSource(
    source?: string | null,
    carrierCode?: string | null,
  ): DeliverySourceCodeType {
    if (carrierCode) {
      const mapped = this.mapCarrierOrChannelToSourceCode(carrierCode, null);
      if (mapped !== 'INTERNAL_SHOP_POS') return mapped;
    }
    switch (source) {
      case 'SHOP_INTERNAL':
      case 'INTERNAL_SHOP_POS':
        return 'INTERNAL_SHOP_POS';
      case 'PANCAKE_COMMUNITY':
      case 'PANCAKE_V2':
      case 'PANCAKE_POS':
        return 'PANCAKE_COMMUNITY';
      case 'CARRIER_3PL_VTP':
        return 'CARRIER_3PL_VTP';
      case 'CARRIER_3PL_GHN':
        return 'CARRIER_3PL_GHN';
      case 'CARRIER_3PL_GHTK':
        return 'CARRIER_3PL_GHTK';
      case 'CARRIER_3PL_JT':
        return 'CARRIER_3PL_JT';
      case 'MARKETPLACE_SHOPEE':
        return 'MARKETPLACE_SHOPEE';
      default:
        return 'PANCAKE_COMMUNITY';
    }
  }

  public sortAndNormalizeAbuseReportsNewestFirst(
    rawReports?: Array<Partial<CustomerAbuseReportItem> & Record<string, any>> | null,
  ): CustomerAbuseReportItem[] {
    if (!Array.isArray(rawReports) || rawReports.length === 0) return [];

    const deduplicatedMap = new Map<string, CustomerAbuseReportItem>();

    for (let idx = 0; idx < rawReports.length; idx++) {
      const item = rawReports[idx];
      if (!item) continue;

      const reasonText = String(
        item.reasonNote || item.reason || item.comment || item.message || '',
      ).trim();
      if (!reasonText) continue;

      const reportedAtRaw = item.reportedAt || item.createdAt || item.timestamp || null;
      const parsedTime = reportedAtRaw ? Date.parse(String(reportedAtRaw)) : NaN;
      const normalizedIso = !Number.isNaN(parsedTime)
        ? new Date(parsedTime).toISOString()
        : new Date(0).toISOString();

      const sourceCode = String(item.source || 'SHOP_INTERNAL').trim();
      const carrierCode = item.carrierCode ? String(item.carrierCode).trim().toUpperCase() : null;
      const orderCode = item.orderCode ? String(item.orderCode).trim() : null;
      const trackingNumber = item.trackingNumber ? String(item.trackingNumber).trim() : null;

      const reportId = String(
        item.reportId ||
          item.id ||
          `rep_${sourceCode}_${trackingNumber || orderCode || idx}_${normalizedIso.slice(0, 19)}`,
      ).trim();

      const reasonCode = item.reasonCode ? String(item.reasonCode) : 'BOM_HANG';
      const isCarrierVerified =
        typeof item.isCarrierVerified === 'boolean'
          ? item.isCarrierVerified
          : Boolean(
              item.verificationLevel === 'CARRIER_VERIFIED' ||
                trackingNumber ||
                sourceCode.startsWith('CARRIER_3PL_') ||
                sourceCode === 'MARKETPLACE_SHOPEE',
            );

      const verificationLevel =
        item.verificationLevel ||
        (isCarrierVerified ? 'CARRIER_VERIFIED' : orderCode ? 'ORDER_LINKED' : 'SHOP_DECLARED');

      const severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' =
        item.severity ||
        (reasonCode === 'BOM_HANG' || reasonCode === 'BOOM_AO_SPAM'
          ? isCarrierVerified
            ? 'CRITICAL'
            : 'HIGH'
          : reasonCode === 'TU_CHOI_NHAN_NHIEU_LAN'
            ? 'HIGH'
            : 'MEDIUM');

      const normalizedItem: CustomerAbuseReportItem = {
        reportId,
        reason: reasonText,
        reasonCode,
        reasonNote: reasonText,
        carrierCode,
        orderCode,
        trackingNumber,
        source: sourceCode,
        sourceLabel:
          item.sourceLabel || this.resolveReportSourceBadgeLabel(sourceCode, carrierCode),
        severity,
        isCarrierVerified,
        verificationLevel,
        canRetract: Boolean(item.canRetract),
        evidenceUrl: item.evidenceUrl ? String(item.evidenceUrl) : null,
        reportedByName: String(
          item.reportedByName ||
            item.reporterName ||
            this.resolveReportSourceBadgeLabel(sourceCode, carrierCode),
        ).trim(),
        reportedAt: normalizedIso,
      };

      const dedupeKey = trackingNumber
        ? `track:${carrierCode || sourceCode}:${trackingNumber}`
        : reportId;

      if (!deduplicatedMap.has(dedupeKey)) {
        deduplicatedMap.set(dedupeKey, normalizedItem);
      }
    }

    return Array.from(deduplicatedMap.values()).sort((a, b) => {
      const timeA = Date.parse(a.reportedAt) || 0;
      const timeB = Date.parse(b.reportedAt) || 0;
      return timeB - timeA;
    });
  }

  private initZeroConfigBreakdownMap(): Map<DeliverySourceCodeType, DeliverySourceBreakdownItem> {
    const map = new Map<DeliverySourceCodeType, DeliverySourceBreakdownItem>();
    const activeCodes: DeliverySourceCodeType[] = [
      'INTERNAL_SHOP_POS',
      'PANCAKE_COMMUNITY',
      'CARRIER_3PL_VTP',
      'CARRIER_3PL_GHN',
      'CARRIER_3PL_GHTK',
      'CARRIER_3PL_JT',
      'MARKETPLACE_SHOPEE',
    ];

    for (const code of activeCodes) {
      const meta = SOURCE_META_MAP[code];
      map.set(code, {
        sourceCode: code,
        sourceName: meta.sourceName,
        shortLabel: meta.shortLabel,
        deliveredCount: 0,
        returnedCount: 0,
        reportedCount: 0,
        successRatePercent: 100,
        confidenceWeight: meta.confidenceWeight,
        status: 'NO_RECORD',
        lastUpdatedAt: null,
        diagnosticMessage: null,
        latencyMs: null,
      });
    }
    return map;
  }

  private finalizeBreakdownList(
    map: Map<DeliverySourceCodeType, DeliverySourceBreakdownItem>,
  ): DeliverySourceBreakdownItem[] {
    return Array.from(map.values()).map((item) => {
      const total = item.deliveredCount + item.returnedCount;
      const successRatePercent = total > 0 ? Math.round((item.deliveredCount * 100) / total) : 100;
      return {
        ...item,
        successRatePercent,
      };
    });
  }

  /**
   * Động cơ Tra cứu Uy tín SĐT 100% Zero-Config (không yêu cầu chủ shop nhập bất kỳ khóa 3PL nào):
   * - Lớp 1: Đơn hàng thực tế nội bộ (khớp cả `customerId` và SĐT giải mã chống sót đơn).
   * - Lớp 2: Sổ cái Cộng đồng Liên Shop (`phone_reputation_ledgers` + `community_phone_abuse_reports`)
   *          được tự động thu hoạch từ OMS & Webhook 3PL toàn hệ thống.
   * - Lớp 3: 4 Cổng cộng đồng công khai miễn phí (GhetBomHang, ChongBomHang, CheckScam, ChongLuaDao).
   * - Lớp 4: Cổng đối tác trung tâm ở tầng server (chạy ngầm nếu nền tảng có cấu hình sẵn).
   */
  public async lookupPhoneReputationFromSources(params: {
    shopId: string;
    rawPhone?: string | null;
    phoneMasked?: string | null;
    phoneSearchHash?: string | null;
    phoneGlobalHash?: string | null;
    excludeShopId?: string | null;
    customerId?: string | null;
    config?: Partial<CrmTrustAndIndustryConfig> | null;
    enablePublicWebRiskLookup?: boolean;
    overrideSources?: string[] | null;
    overrideWebhookUrl?: string | null;
    bypassCache?: boolean;
  }): Promise<ExternalPhoneReputationLookupResult> {
    const safeRawPhone =
      params.rawPhone && !params.rawPhone.includes('[') && !params.rawPhone.includes('*')
        ? params.rawPhone
        : '';
    const normalizedPhone = safeRawPhone
      ? this.piiVaultService.normalizeLocalVietnamesePhone(safeRawPhone)
      : '';
    const validPhone = normalizedPhone.length >= 9 ? normalizedPhone : '';

    const resolvedGlobalHash = validPhone
      ? this.piiVaultService.computeGlobalPhoneConsortiumHash(validPhone)
      : params.phoneGlobalHash || null;

    const resolvedMasked = validPhone
      ? this.piiVaultService.maskPhoneNumber(validPhone)
      : params.phoneMasked || null;

    const cfg = params.config || {};
    const enabledCarriers = cfg.enabledCarriers || ['VTP', 'GHN', 'GHTK', 'JT'];
    const breakdownMap = this.initZeroConfigBreakdownMap();
    const diagnostics: PersistedTrustProviderDiagnosticItem[] = [];
    const collectedReports: Array<Partial<CustomerAbuseReportItem> & Record<string, any>> = [];

    if (!validPhone && !resolvedGlobalHash && !params.customerId) {
      return {
        shopDeliveredCount: 0,
        shopReturnedCount: 0,
        networkDeliveredCount: 0,
        networkReturnedCount: 0,
        reportedCount: 0,
        verifiedReportedCount: 0,
        reportedReasons: [],
        sourceBreakdowns: this.finalizeBreakdownList(breakdownMap),
        providerDiagnostics: [],
        lookupSource: PhoneTrustLookupSourceEnum.INTERNAL_SHOP_POS,
        lookupSourceLabel: this.resolveLookupSourceLabel(
          PhoneTrustLookupSourceEnum.INTERNAL_SHOP_POS,
          enabledCarriers,
        ),
        phoneGlobalHash: null,
        hasPhoneIdentifier: false,
        warningMessage:
          'Khách hàng chưa có số điện thoại gốc. Hãy lưu SĐT để hệ thống tự động tra cứu uy tín nhận/hoàn.',
      };
    }

    const currentShopId = params.excludeShopId || params.shopId;
    let shopDeliveredCount = 0;
    let shopReturnedCount = 0;
    let networkDeliveredCount = 0;
    let networkReturnedCount = 0;

    // LỚP 1: ĐỐI SOÁT ĐƠN HÀNG THỰC TẾ NỘI BỘ CỬA HÀNG (CHỐNG SÓT ĐƠN RỜI)
    if (cfg.useInternalPosHistory !== false && currentShopId) {
      const startedInternal = Date.now();
      const matchedCustomerIds = new Set<string>();
      if (params.customerId) matchedCustomerIds.add(params.customerId);

      if (resolvedGlobalHash || params.phoneSearchHash) {
        const matchedCustomers = await this.customerRepo.find({
          where: [
            ...(resolvedGlobalHash
              ? [{ shopId: currentShopId, phoneGlobalHash: resolvedGlobalHash }]
              : []),
            ...(params.phoneSearchHash
              ? [{ shopId: currentShopId, phoneSearchHash: params.phoneSearchHash }]
              : []),
          ],
          take: 10,
        });
        for (const c of matchedCustomers) matchedCustomerIds.add(c.id);
      }

      const orderMap = new Map<string, PosOrderEntity>();
      if (matchedCustomerIds.size > 0) {
        const byCustomerOrders = await this.posOrderRepo
          .createQueryBuilder('o')
          .where('o.shop_id = :shopId AND o.customer_id IN (:...customerIds)', {
            shopId: currentShopId,
            customerIds: Array.from(matchedCustomerIds),
          })
          .orderBy('o.created_at', 'DESC')
          .take(250)
          .getMany();
        for (const ord of byCustomerOrders) orderMap.set(ord.id, ord);
      }

      if (validPhone && resolvedMasked) {
        const unlinkedCandidates = await this.posOrderRepo.find({
          where: { shopId: currentShopId, customerPhoneMasked: resolvedMasked },
          order: { createdAt: 'DESC' },
          take: 100,
        });
        for (const ord of unlinkedCandidates) {
          if (orderMap.has(ord.id) || !ord.customerPhoneEncrypted) continue;
          const dec = this.piiVaultService.decryptPhoneInRam(
            currentShopId,
            ord.customerPhoneEncrypted,
          );
          if (dec && this.piiVaultService.normalizeLocalVietnamesePhone(dec) === validPhone) {
            orderMap.set(ord.id, ord);
          }
        }
      }

      const shopBucket = breakdownMap.get('INTERNAL_SHOP_POS')!;
      for (const ord of orderMap.values()) {
        const tsIso = new Date(ord.updatedAt || ord.createdAt || Date.now()).toISOString();
        const carrierSource = this.mapCarrierOrChannelToSourceCode(
          ord.carrierCode,
          ord.channelType,
        );
        const carrierBucket =
          carrierSource !== 'INTERNAL_SHOP_POS' ? breakdownMap.get(carrierSource) : null;

        if (
          ord.status === PosOrderStatusEnum.DELIVERED ||
          ord.status === PosOrderStatusEnum.DELIVERED_RECONCILED
        ) {
          shopDeliveredCount += 1;
          shopBucket.deliveredCount += 1;
          shopBucket.status = 'LOCAL_LEDGER';
          shopBucket.lastUpdatedAt = shopBucket.lastUpdatedAt || tsIso;
          if (carrierBucket) {
            carrierBucket.deliveredCount += 1;
            carrierBucket.status = 'LOCAL_LEDGER';
            carrierBucket.lastUpdatedAt = carrierBucket.lastUpdatedAt || tsIso;
          }
        } else if (
          ord.status === PosOrderStatusEnum.RETURNING ||
          ord.status === PosOrderStatusEnum.RETURNED_RESTOCKED
        ) {
          shopReturnedCount += 1;
          shopBucket.returnedCount += 1;
          shopBucket.status = 'LOCAL_LEDGER';
          shopBucket.lastUpdatedAt = shopBucket.lastUpdatedAt || tsIso;
          if (carrierBucket) {
            carrierBucket.returnedCount += 1;
            carrierBucket.status = 'LOCAL_LEDGER';
            carrierBucket.lastUpdatedAt = carrierBucket.lastUpdatedAt || tsIso;
          }
        }
      }

      diagnostics.push({
        providerCode: 'INTERNAL_SHOP_OMS',
        providerName: 'Sổ cái Đơn hàng Nội bộ (Tự động)',
        status: shopDeliveredCount + shopReturnedCount > 0 ? 'LOCAL_LEDGER' : 'NO_RECORD',
        deliveredCount: shopDeliveredCount,
        returnedCount: shopReturnedCount,
        reportedCount: 0,
        latencyMs: Date.now() - startedInternal,
        fromCache: false,
        message:
          shopDeliveredCount + shopReturnedCount > 0
            ? `Đã khớp ${shopDeliveredCount} đơn giao thành công & ${shopReturnedCount} đơn hoàn tại cửa hàng.`
            : 'Khách chưa phát sinh đơn giao thành công hoặc hoàn tại cửa hàng này.',
        checkedAt: new Date().toISOString(),
      });
    }

    // LỚP 2: MẠNG LƯỚI CỘNG ĐỒNG LIÊN SHOP (TỰ ĐỘNG THU HOẠCH OMS & WEBHOOK 3PL ĐA SHOP)
    if (cfg.usePancakeCommunityNetwork !== false && resolvedGlobalHash) {
      const startedCommunity = Date.now();
      const [ledger, activeCommunityReports] = await Promise.all([
        this.ledgerRepo.findOne({ where: { phoneGlobalHash: resolvedGlobalHash } }),
        this.abuseReportRepo.find({
          where: { phoneGlobalHash: resolvedGlobalHash, status: 'ACTIVE' },
          order: { createdAt: 'DESC' },
          take: 50,
        }),
      ]);

      let otherShopsDelivered = 0;
      let otherShopsReturned = 0;

      if (ledger) {
        const processed = Array.isArray(ledger.processedOrdersJson)
          ? ledger.processedOrdersJson
          : [];
        const ownShopDeliveredInLedger = processed.filter(
          (p) => p.shopId === currentShopId && p.outcome === 'DELIVERED',
        ).length;
        const ownShopReturnedInLedger = processed.filter(
          (p) => p.shopId === currentShopId && p.outcome === 'RETURNED',
        ).length;

        otherShopsDelivered = Math.max(0, ledger.totalDeliveredCount - ownShopDeliveredInLedger);
        otherShopsReturned = Math.max(0, ledger.totalReturnedCount - ownShopReturnedInLedger);

        networkDeliveredCount += otherShopsDelivered;
        networkReturnedCount += otherShopsReturned;

        const communityBucket = breakdownMap.get('PANCAKE_COMMUNITY')!;
        communityBucket.deliveredCount += otherShopsDelivered;
        communityBucket.returnedCount += otherShopsReturned;
        if (otherShopsDelivered > 0 || otherShopsReturned > 0) {
          communityBucket.status = 'COMMUNITY_SYNCED';
          communityBucket.lastUpdatedAt = ledger.lastOrderEventAt
            ? new Date(ledger.lastOrderEventAt).toISOString()
            : new Date().toISOString();
        }

        if (ledger.carrierBreakdownJson) {
          for (const [carrierKey, counts] of Object.entries(ledger.carrierBreakdownJson)) {
            const targetCode = this.mapCarrierOrChannelToSourceCode(carrierKey, null);
            if (targetCode === 'INTERNAL_SHOP_POS') continue;
            const cBucket = breakdownMap.get(targetCode);
            if (!cBucket) continue;

            cBucket.deliveredCount = Math.max(cBucket.deliveredCount, counts.deliveredCount || 0);
            cBucket.returnedCount = Math.max(cBucket.returnedCount, counts.returnedCount || 0);
            if ((counts.deliveredCount || 0) > 0 || (counts.returnedCount || 0) > 0) {
              cBucket.status = 'COMMUNITY_SYNCED';
              cBucket.lastUpdatedAt = counts.lastEventAt || cBucket.lastUpdatedAt;
            }
          }
        }
      }

      for (const rep of activeCommunityReports) {
        const isOwnReport = rep.reporterShopId === currentShopId;
        collectedReports.push({
          reportId: rep.id,
          reason: rep.reasonNote,
          reasonCode: rep.reasonCode,
          reasonNote: rep.reasonNote,
          carrierCode: rep.carrierCode,
          orderCode: isOwnReport ? rep.orderCode : null,
          trackingNumber: isOwnReport ? rep.trackingNumber : null,
          source: isOwnReport ? rep.sourceCode || 'SHOP_INTERNAL' : 'PANCAKE_COMMUNITY',
          sourceLabel: isOwnReport
            ? this.resolveReportSourceBadgeLabel(rep.sourceCode, rep.carrierCode)
            : `Cộng đồng (${rep.reporterShopAlias})`,
          severity: rep.severity,
          isCarrierVerified: rep.verificationLevel === 'CARRIER_VERIFIED',
          verificationLevel: rep.verificationLevel,
          canRetract: isOwnReport,
          reportedByName: isOwnReport ? 'Cửa hàng hiện tại' : rep.reporterShopAlias,
          reportedAt: new Date(rep.createdAt || Date.now()).toISOString(),
        });
      }

      diagnostics.push({
        providerCode: 'CROSS_SHOP_CONSORTIUM',
        providerName: 'Mạng lưới Cộng đồng & 3PL Liên Shop (Tự động)',
        status:
          otherShopsDelivered + otherShopsReturned + activeCommunityReports.length > 0
            ? 'COMMUNITY_SYNCED'
            : 'NO_RECORD',
        deliveredCount: otherShopsDelivered,
        returnedCount: otherShopsReturned,
        reportedCount: activeCommunityReports.length,
        latencyMs: Date.now() - startedCommunity,
        fromCache: false,
        message:
          otherShopsDelivered + otherShopsReturned + activeCommunityReports.length > 0
            ? `Khớp tự động: ${otherShopsDelivered} đơn nhận, ${otherShopsReturned} đơn hoàn, ${activeCommunityReports.length} báo xấu từ mạng lưới liên shop.`
            : 'SĐT này chưa có lịch sử giao nhận hoặc báo xấu trên mạng lưới liên shop.',
        checkedAt: new Date().toISOString(),
      });
    }

    // LỚP 3: 4 CỔNG CỘNG ĐỒNG CÔNG KHAI MIỄN PHÍ KHÔNG CẦN KEY
    const enablePublicWeb =
      params.enablePublicWebRiskLookup ?? cfg.enablePublicWebRiskLookup ?? true;
    if (enablePublicWeb && validPhone && resolvedGlobalHash) {
      const pubRes = await this.publicWebRiskProvider.queryPublicCommunityPortals({
        normalizedPhone: validPhone,
        phoneGlobalHash: resolvedGlobalHash,
        bypassCache: params.bypassCache,
      });
      diagnostics.push(...pubRes.diagnostics);

      const communityBucket = breakdownMap.get('PANCAKE_COMMUNITY')!;
      for (const hit of pubRes.hits) {
        if (hit.status === 'LIVE_VERIFIED' && hit.reports.length > 0) {
          communityBucket.status = 'LIVE_VERIFIED';
          communityBucket.lastUpdatedAt = hit.checkedAt;
          for (const rep of hit.reports) {
            collectedReports.push(rep);
          }
        }
      }
    }

    // LỚP 4: CỔNG ĐỐI TÁC TRUNG TÂM TẦNG HẠ TẦNG (CHẠY NGẦM NẾU SERVER CÓ CẤU HÌNH SẴN — 0 CẤU HÌNH TỪ SHOP)
    const platformHubUrl = (process.env.PLATFORM_TRUST_COMMUNITY_GATEWAY_URL || '').trim();
    if (
      platformHubUrl &&
      /^https?:\/\//i.test(platformHubUrl) &&
      validPhone &&
      resolvedGlobalHash
    ) {
      const hubHit = await this.queryManagedPlatformHubSilently({
        url: platformHubUrl,
        apiKey: (process.env.PLATFORM_TRUST_COMMUNITY_GATEWAY_API_KEY || '').trim() || null,
        normalizedPhone: validPhone,
        phoneGlobalHash: resolvedGlobalHash,
        enabledCarriers,
        bypassCache: params.bypassCache,
      });

      if (hubHit) {
        diagnostics.push(hubHit.diagnostic);
        if (hubHit.deliveredCount > 0 || hubHit.returnedCount > 0 || hubHit.reports.length > 0) {
          const communityBucket = breakdownMap.get('PANCAKE_COMMUNITY')!;
          const deltaDel = Math.max(0, hubHit.deliveredCount - communityBucket.deliveredCount);
          const deltaRet = Math.max(0, hubHit.returnedCount - communityBucket.returnedCount);
          networkDeliveredCount += deltaDel;
          networkReturnedCount += deltaRet;
          communityBucket.deliveredCount = Math.max(
            communityBucket.deliveredCount,
            hubHit.deliveredCount,
          );
          communityBucket.returnedCount = Math.max(
            communityBucket.returnedCount,
            hubHit.returnedCount,
          );
          communityBucket.status = 'LIVE_VERIFIED';
          communityBucket.lastUpdatedAt = hubHit.diagnostic.checkedAt;
          collectedReports.push(...hubHit.reports);
        }
      }
    }

    // HỢP NHẤT CUỐI CÙNG
    const sortedReasons = this.sortAndNormalizeAbuseReportsNewestFirst(collectedReports);
    const verifiedReportedCount = sortedReasons.filter((r) => r.isCarrierVerified).length;

    for (const rep of sortedReasons) {
      const bucketCode = this.normalizeCarrierReportSource(rep.source, rep.carrierCode);
      const bucket = breakdownMap.get(bucketCode);
      if (bucket) {
        bucket.reportedCount += 1;
        if (bucket.status === 'NO_RECORD') {
          bucket.status =
            bucketCode === 'INTERNAL_SHOP_POS'
              ? 'LOCAL_LEDGER'
              : bucketCode === 'PANCAKE_COMMUNITY'
                ? 'COMMUNITY_SYNCED'
                : 'LIVE_VERIFIED';
        }
        if (!bucket.lastUpdatedAt) {
          bucket.lastUpdatedAt = rep.reportedAt;
        }
      }
    }

    const finalReportedCount = sortedReasons.length;
    const totalAllSignals =
      shopDeliveredCount +
      shopReturnedCount +
      networkDeliveredCount +
      networkReturnedCount +
      finalReportedCount;

    const warningMessage =
      totalAllSignals === 0
        ? 'SĐT này hiện chưa ghi nhận đơn nhận, đơn hoàn hay cảnh báo xấu trên toàn bộ mạng lưới nội bộ, liên shop và 4 cổng cộng đồng công khai.'
        : null;

    return {
      shopDeliveredCount,
      shopReturnedCount,
      networkDeliveredCount,
      networkReturnedCount,
      reportedCount: finalReportedCount,
      verifiedReportedCount,
      reportedReasons: sortedReasons,
      sourceBreakdowns: this.finalizeBreakdownList(breakdownMap),
      providerDiagnostics: diagnostics,
      lookupSource: PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE,
      lookupSourceLabel: this.resolveLookupSourceLabel(
        PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE,
        enabledCarriers,
      ),
      phoneGlobalHash: resolvedGlobalHash,
      hasPhoneIdentifier: true,
      warningMessage,
    };
  }

  private async queryManagedPlatformHubSilently(params: {
    url: string;
    apiKey: string | null;
    normalizedPhone: string;
    phoneGlobalHash: string;
    enabledCarriers: string[];
    bypassCache?: boolean;
  }): Promise<{
    deliveredCount: number;
    returnedCount: number;
    reports: Array<Partial<CustomerAbuseReportItem> & Record<string, unknown>>;
    diagnostic: PersistedTrustProviderDiagnosticItem;
  } | null> {
    const cacheKey = `trust:platform_hub:${params.phoneGlobalHash}`;
    if (!params.bypassCache) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          return {
            ...parsed,
            diagnostic: { ...parsed.diagnostic, fromCache: true },
          };
        }
      } catch {
        // Bỏ qua lỗi cache để tiếp tục tra cứu trực tiếp
      }
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLATFORM_HUB_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (params.apiKey) {
        headers.Authorization = `Bearer ${params.apiKey}`;
        headers['X-API-Key'] = params.apiKey;
      }

      const res = await fetch(params.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          phone: params.normalizedPhone,
          phoneSha256: crypto.createHash('sha256').update(params.normalizedPhone).digest('hex'),
          phoneGlobalHash: params.phoneGlobalHash,
          enabledCarriers: params.enabledCarriers,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const latencyMs = Date.now() - startedAt;
      const checkedAt = new Date().toISOString();
      if (!res.ok) {
        return {
          deliveredCount: 0,
          returnedCount: 0,
          reports: [],
          diagnostic: {
            providerCode: 'PLATFORM_MANAGED_HUB',
            providerName: 'Cổng Đối Soát 3PL Trung Tâm (Tự động)',
            status: 'PROVIDER_ERROR',
            deliveredCount: 0,
            returnedCount: 0,
            reportedCount: 0,
            latencyMs,
            fromCache: false,
            message: `Cổng trung tâm tạm gián đoạn (HTTP ${res.status}).`,
            checkedAt,
          },
        };
      }

      const json = (await res.json().catch(() => ({}))) as Record<string, any>;
      const node = json?.data ?? json;
      const deliveredCount = Math.max(
        0,
        Number(node?.deliveredCount ?? node?.succeed_order_count ?? 0),
      );
      const returnedCount = Math.max(
        0,
        Number(node?.returnedCount ?? node?.returned_order_count ?? 0),
      );
      const reports = Array.isArray(node?.reportedReasons)
        ? node.reportedReasons
        : Array.isArray(node?.reports)
          ? node.reports
          : [];
      const hasData = deliveredCount > 0 || returnedCount > 0 || reports.length > 0;

      const payload = {
        deliveredCount,
        returnedCount,
        reports,
        diagnostic: {
          providerCode: 'PLATFORM_MANAGED_HUB',
          providerName: 'Cổng Đối Soát 3PL Trung Tâm (Tự động)',
          status: hasData ? ('LIVE_VERIFIED' as const) : ('NO_RECORD' as const),
          deliveredCount,
          returnedCount,
          reportedCount: reports.length,
          latencyMs,
          fromCache: false,
          message: hasData
            ? `Cổng trung tâm trả về ${deliveredCount} nhận / ${returnedCount} hoàn / ${reports.length} báo xấu.`
            : 'Đã đối soát cổng trung tâm — chưa ghi nhận lịch sử cho SĐT này.',
          checkedAt,
        },
      };

      try {
        await this.redis.set(
          cacheKey,
          JSON.stringify(payload),
          'EX',
          PLATFORM_HUB_CACHE_TTL_SECONDS,
        );
      } catch {
        // Không làm gián đoạn luồng trả kết quả khi Redis bận
      }
      return payload;
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  public evaluateCustomerTrustScore(params: {
    successfulDeliveriesCount: number;
    returnedOrdersCount: number;
    networkDeliveredCount?: number;
    networkReturnedCount?: number;
    reportedCount?: number;
    reportedReasons?: CustomerAbuseReportItem[] | null;
    sourceBreakdowns?: DeliverySourceBreakdownItem[] | null;
    providerDiagnostics?: PersistedTrustProviderDiagnosticItem[] | null;
    isBlacklisted: boolean;
    shopRequireDepositOnHighRisk?: boolean;
    highRiskReturnRateThresholdPercent?: number;
    highRiskReportedCountThreshold?: number;
    lookupSource?: string | null;
    enabledCarriers?: string[];
    checkedAt?: Date | string | null;
  }): DeliveryTrustEvaluationResult {
    const shopDeliveredCount = Math.max(0, Number(params.successfulDeliveriesCount || 0));
    const shopReturnedCount = Math.max(0, Number(params.returnedOrdersCount || 0));
    const networkDeliveredCount = Math.max(0, Number(params.networkDeliveredCount || 0));
    const networkReturnedCount = Math.max(0, Number(params.networkReturnedCount || 0));
    const reportedReasons = this.sortAndNormalizeAbuseReportsNewestFirst(params.reportedReasons);
    const verifiedReportedCount = reportedReasons.filter((r) => r.isCarrierVerified).length;
    const reportedCount = Math.max(0, Number(params.reportedCount || 0), reportedReasons.length);

    const totalDeliveredCount = shopDeliveredCount + networkDeliveredCount;
    const totalReturnedCount = shopReturnedCount + networkReturnedCount;
    const totalCompletedOrReturned = totalDeliveredCount + totalReturnedCount;

    const isBlacklisted = Boolean(params.isBlacklisted);
    const blacklistPenalty = isBlacklisted ? 60 : 0;

    const nowMs = Date.now();
    let weightedReportPenalty = 0;
    if (reportedReasons.length > 0) {
      for (const rep of reportedReasons) {
        const repTime = Date.parse(rep.reportedAt || '') || nowMs;
        const ageDays = Math.max(0, (nowMs - repTime) / 86_400_000);
        const recencyFactor =
          ageDays <= 90 ? 1.0 : ageDays <= 180 ? 0.75 : ageDays <= 365 ? 0.5 : 0.3;
        const basePenalty = rep.isCarrierVerified ? 20 : 14;
        weightedReportPenalty += basePenalty * recencyFactor;
      }
      weightedReportPenalty = Math.min(55, Math.round(weightedReportPenalty));
    } else {
      weightedReportPenalty = Math.min(45, reportedCount * 15);
    }

    const rawFormulaScore = Math.round(
      ((totalDeliveredCount + 1) / (totalDeliveredCount + totalReturnedCount * 2.5 + 1)) * 100,
    );
    const clampedScore = Math.max(
      0,
      Math.min(100, rawFormulaScore - blacklistPenalty - weightedReportPenalty),
    );

    const successRatePercent =
      totalCompletedOrReturned > 0
        ? Math.round((totalDeliveredCount / totalCompletedOrReturned) * 100)
        : 100;
    const returnRatePercent =
      totalCompletedOrReturned > 0 ? Math.max(0, 100 - successRatePercent) : 0;

    const returnRateThreshold = Number(params.highRiskReturnRateThresholdPercent || 30);
    const reportedThreshold = Number(params.highRiskReportedCountThreshold || 1);

    const lookupSource = params.lookupSource || PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE;
    const lookupSourceLabel = this.resolveLookupSourceLabel(lookupSource, params.enabledCarriers);
    const checkedAt = params.checkedAt
      ? new Date(params.checkedAt).toISOString()
      : new Date().toISOString();

    const resolvedBreakdowns =
      Array.isArray(params.sourceBreakdowns) && params.sourceBreakdowns.length > 0
        ? params.sourceBreakdowns
        : this.buildFallbackBreakdownsFromCounters({
            shopDeliveredCount,
            shopReturnedCount,
            networkDeliveredCount,
            networkReturnedCount,
            reportedReasons,
            checkedAt,
          });

    const providerDiagnostics = Array.isArray(params.providerDiagnostics)
      ? params.providerDiagnostics
      : [];

    if (
      isBlacklisted ||
      clampedScore < 50 ||
      totalReturnedCount >= 2 ||
      reportedCount >= reportedThreshold ||
      (totalCompletedOrReturned >= 2 && returnRatePercent >= returnRateThreshold)
    ) {
      return {
        score: clampedScore,
        band: DeliveryTrustBandEnum.HIGH_RISK_RED,
        badgeVariant: 'danger',
        headline: isBlacklisted
          ? `Cảnh báo đỏ • Danh sách đen (${reportedCount} báo cáo)`
          : `Rủi ro bom hàng cao (${clampedScore}/100)`,
        recommendation:
          'Nên yêu cầu đặt cọc trước qua VietQR hoặc gọi xác nhận kỹ trước khi đẩy đơn 3PL.',
        requireDepositVietQr: params.shopRequireDepositOnHighRisk ?? true,
        successRatePercent,
        returnRatePercent,
        totalDeliveredCount,
        shopDeliveredCount,
        networkDeliveredCount,
        totalReturnedCount,
        shopReturnedCount,
        networkReturnedCount,
        reportedCount,
        verifiedReportedCount,
        reportedReasons,
        sourceBreakdowns: resolvedBreakdowns,
        providerDiagnostics,
        lookupSource,
        lookupSourceLabel,
        checkedAt,
      };
    }

    if (totalCompletedOrReturned === 0 && reportedCount === 0) {
      return {
        score: 80,
        band: DeliveryTrustBandEnum.NEW_NEUTRAL,
        badgeVariant: 'info',
        headline: 'Khách hàng mới (80/100)',
        recommendation:
          'Chưa ghi nhận đơn nhận/hoàn hay báo xấu — xác nhận rõ địa chỉ trước khi gửi.',
        requireDepositVietQr: false,
        successRatePercent: 100,
        returnRatePercent: 0,
        totalDeliveredCount: 0,
        shopDeliveredCount: 0,
        networkDeliveredCount: 0,
        totalReturnedCount: 0,
        shopReturnedCount: 0,
        networkReturnedCount: 0,
        reportedCount: 0,
        verifiedReportedCount: 0,
        reportedReasons: [],
        sourceBreakdowns: resolvedBreakdowns,
        providerDiagnostics,
        lookupSource,
        lookupSourceLabel,
        checkedAt,
      };
    }

    if (clampedScore >= 85 && totalReturnedCount === 0 && reportedCount === 0) {
      return {
        score: clampedScore,
        band: DeliveryTrustBandEnum.TRUSTED_GREEN,
        badgeVariant: 'success',
        headline: `Uy tín cao (${clampedScore}/100 • Nhận ${totalDeliveredCount} đơn)`,
        recommendation: 'Lịch sử nhận hàng tốt — ưu tiên duyệt và đóng gói giao nhanh.',
        requireDepositVietQr: false,
        successRatePercent,
        returnRatePercent,
        totalDeliveredCount,
        shopDeliveredCount,
        networkDeliveredCount,
        totalReturnedCount: 0,
        shopReturnedCount: 0,
        networkReturnedCount: 0,
        reportedCount: 0,
        verifiedReportedCount: 0,
        reportedReasons,
        sourceBreakdowns: resolvedBreakdowns,
        providerDiagnostics,
        lookupSource,
        lookupSourceLabel,
        checkedAt,
      };
    }

    return {
      score: clampedScore,
      band: DeliveryTrustBandEnum.CAUTION_AMBER,
      badgeVariant: 'warning',
      headline: `Cần lưu ý (${clampedScore}/100 • Tỷ lệ nhận ${successRatePercent}%)`,
      recommendation: 'Gọi xác nhận khung giờ nhận hàng và địa chỉ chi tiết trước khi xuất kho.',
      requireDepositVietQr: false,
      successRatePercent,
      returnRatePercent,
      totalDeliveredCount,
      shopDeliveredCount,
      networkDeliveredCount,
      totalReturnedCount,
      shopReturnedCount,
      networkReturnedCount,
      reportedCount,
      verifiedReportedCount,
      reportedReasons,
      sourceBreakdowns: resolvedBreakdowns,
      providerDiagnostics,
      lookupSource,
      lookupSourceLabel,
      checkedAt,
    };
  }

  private buildFallbackBreakdownsFromCounters(params: {
    shopDeliveredCount: number;
    shopReturnedCount: number;
    networkDeliveredCount: number;
    networkReturnedCount: number;
    reportedReasons: CustomerAbuseReportItem[];
    checkedAt: string;
  }): DeliverySourceBreakdownItem[] {
    const map = this.initZeroConfigBreakdownMap();
    const shopBucket = map.get('INTERNAL_SHOP_POS')!;
    shopBucket.deliveredCount = params.shopDeliveredCount;
    shopBucket.returnedCount = params.shopReturnedCount;
    if (params.shopDeliveredCount > 0 || params.shopReturnedCount > 0) {
      shopBucket.status = 'LOCAL_LEDGER';
      shopBucket.lastUpdatedAt = params.checkedAt;
    }

    const communityBucket = map.get('PANCAKE_COMMUNITY')!;
    communityBucket.deliveredCount = params.networkDeliveredCount;
    communityBucket.returnedCount = params.networkReturnedCount;
    if (params.networkDeliveredCount > 0 || params.networkReturnedCount > 0) {
      communityBucket.status = 'COMMUNITY_SYNCED';
      communityBucket.lastUpdatedAt = params.checkedAt;
    }

    for (const rep of params.reportedReasons) {
      const code = this.normalizeCarrierReportSource(rep.source, rep.carrierCode);
      const b = map.get(code);
      if (b) {
        b.reportedCount += 1;
        if (b.status === 'NO_RECORD') {
          b.status = code === 'INTERNAL_SHOP_POS' ? 'LOCAL_LEDGER' : 'LIVE_VERIFIED';
        }
        b.lastUpdatedAt = b.lastUpdatedAt || rep.reportedAt;
      }
    }

    return this.finalizeBreakdownList(map);
  }
}
