import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

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
    sourceName: 'Mạng lưới Cộng đồng & Pancake POS',
    shortLabel: 'Cộng đồng / Pancake',
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
    sourceName: 'Cổng Tín Nhiệm Mở Rộng (SuperAI / Webhook)',
    shortLabel: 'API mở rộng',
    confidenceWeight: 0.88,
  },
};

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
        return 'Cộng đồng liên shop & Pancake POS';
      case PhoneTrustLookupSourceEnum.CARRIER_3PL_GHN_GHTK:
        return `ĐVVC 3PL (${carrierStr})`;
      case PhoneTrustLookupSourceEnum.CUSTOM_EXTERNAL_WEBHOOK:
        return 'API tín nhiệm mở rộng';
      default:
        return `Cộng đồng + ${carrierStr}`;
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
        return 'Cộng đồng / Pancake POS';
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
      case 'CUSTOM_WEBHOOK_PROVIDER':
        return 'API đối tác tín nhiệm';
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
      case 'CUSTOM_WEBHOOK_PROVIDER':
        return 'CUSTOM_WEBHOOK_PROVIDER';
      default:
        return 'PANCAKE_COMMUNITY';
    }
  }

  public sortAndNormalizeAbuseReportsNewestFirst(
    rawReports?: Array<Partial<CustomerAbuseReportItem> & Record<string, any>> | null,
  ): CustomerAbuseReportItem[] {
    if (!Array.isArray(rawReports) || rawReports.length === 0) {
      return [];
    }

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
          `rep_${sourceCode}_${orderCode || idx}_${normalizedIso.slice(0, 19)}`,
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

      if (!deduplicatedMap.has(reportId)) {
        deduplicatedMap.set(reportId, normalizedItem);
      }
    }

    return Array.from(deduplicatedMap.values()).sort((a, b) => {
      const timeA = Date.parse(a.reportedAt) || 0;
      const timeB = Date.parse(b.reportedAt) || 0;
      return timeB - timeA;
    });
  }

  private initSourceBreakdownMap(
    hasCustomWebhook: boolean,
  ): Map<DeliverySourceCodeType, DeliverySourceBreakdownItem> {
    const map = new Map<DeliverySourceCodeType, DeliverySourceBreakdownItem>();
    const allCodes: DeliverySourceCodeType[] = [
      'INTERNAL_SHOP_POS',
      'PANCAKE_COMMUNITY',
      'CARRIER_3PL_VTP',
      'CARRIER_3PL_GHN',
      'CARRIER_3PL_GHTK',
      'CARRIER_3PL_JT',
      'MARKETPLACE_SHOPEE',
      'CUSTOM_WEBHOOK_PROVIDER',
    ];

    for (const code of allCodes) {
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
        status:
          code === 'CUSTOM_WEBHOOK_PROVIDER' && !hasCustomWebhook ? 'NOT_CONFIGURED' : 'NO_RECORD',
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
   * Động cơ Tra cứu Uy tín SĐT Đa Nguồn Chuẩn Production (v2):
   * - Tầng 1: Tổng hợp trực tiếp từ `PosOrderEntity` của chính cửa hàng hiện tại (không bỏ sót đơn DELIVERED / RETURNING).
   * - Tầng 2: Tra cứu 1-1 không va chạm bằng `phoneGlobalHash` trên Sổ cái Cộng đồng (`phone_reputation_ledgers`)
   *           và Bảng Báo cáo Xấu Có Kiểm Chứng (`community_phone_abuse_reports`).
   * - Tầng 3: Gọi song song các Provider Adapter thực tế (Pancake POS Open API, GHN Live API, Custom/SuperAI Webhook)
   *           qua `TrustProviderRegistryService` kèm Redis cache và chẩn đoán trạng thái từng nguồn.
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

    const cfg = params.config || {};
    const overrideSet =
      Array.isArray(params.overrideSources) && params.overrideSources.length > 0
        ? new Set(params.overrideSources.map((s) => String(s).toUpperCase()))
        : null;

    const useInternal = cfg.useInternalPosHistory !== false;
    const useCommunity = overrideSet
      ? overrideSet.has('PANCAKE_COMMUNITY') || overrideSet.has('PANCAKE_COMMUNITY_NETWORK')
      : cfg.usePancakeCommunityNetwork !== false;
    const useCarrier3pl = overrideSet
      ? overrideSet.has('CARRIER_3PL') || overrideSet.has('CARRIER_3PL_GHN_GHTK')
      : cfg.useCarrier3plLookup !== false;
    const enabledCarriers = cfg.enabledCarriers || ['VTP', 'GHN', 'GHTK', 'JT'];

    const effectiveWebhookUrl = (
      params.overrideWebhookUrl ||
      cfg.customLookupWebhookUrl ||
      ''
    ).trim();
    const hasCustomWebhook = Boolean(
      effectiveWebhookUrl && /^https?:\/\//i.test(effectiveWebhookUrl),
    );

    const breakdownMap = this.initSourceBreakdownMap(hasCustomWebhook);
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
          'Khách hàng chưa có số điện thoại gốc trong PII Vault. Hãy lưu SĐT để tra cứu lịch sử nhận/hoàn từ 3PL & Cộng đồng.',
      };
    }

    const currentShopId = params.excludeShopId || params.shopId;
    let shopDeliveredCount = 0;
    let shopReturnedCount = 0;
    let networkDeliveredCount = 0;
    let networkReturnedCount = 0;

    // =========================================================================
    // TẦNG 1: ĐỐI SOÁT ĐƠN HÀNG THỰC TẾ NỘI BỘ CỬA HÀNG (POS/OMS)
    // =========================================================================
    if (useInternal && currentShopId) {
      const startedInternal = Date.now();
      let resolvedCustomerId = params.customerId || null;

      if (!resolvedCustomerId && (params.phoneSearchHash || resolvedGlobalHash)) {
        const matchedCustomer = await this.customerRepo.findOne({
          where: resolvedGlobalHash
            ? { shopId: currentShopId, phoneGlobalHash: resolvedGlobalHash }
            : { shopId: currentShopId, phoneSearchHash: params.phoneSearchHash! },
        });
        resolvedCustomerId = matchedCustomer?.id || null;
      }

      if (resolvedCustomerId) {
        const shopOrders = await this.posOrderRepo.find({
          where: { shopId: currentShopId, customerId: resolvedCustomerId },
          order: { createdAt: 'DESC' },
          take: 200,
        });

        const shopBucket = breakdownMap.get('INTERNAL_SHOP_POS')!;
        for (const ord of shopOrders) {
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
      }

      diagnostics.push({
        providerCode: 'INTERNAL_SHOP_OMS',
        providerName: 'Sổ cái Đơn hàng Nội bộ (OMS/POS)',
        status: shopDeliveredCount + shopReturnedCount > 0 ? 'LOCAL_LEDGER' : 'NO_RECORD',
        deliveredCount: shopDeliveredCount,
        returnedCount: shopReturnedCount,
        reportedCount: 0,
        latencyMs: Date.now() - startedInternal,
        fromCache: false,
        message:
          shopDeliveredCount + shopReturnedCount > 0
            ? `Đã khớp ${shopDeliveredCount} đơn giao thành công & ${shopReturnedCount} đơn hoàn tại cửa hàng.`
            : 'Khách chưa có đơn giao thành công hoặc hoàn tại cửa hàng này.',
        checkedAt: new Date().toISOString(),
      });
    }

    // =========================================================================
    // TẦNG 2: MẠNG LƯỚI CỘNG ĐỒNG LIÊN SHOP (HMAC phoneGlobalHash — 0% VA CHẠM)
    // =========================================================================
    if (useCommunity && resolvedGlobalHash) {
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
        // Loại trừ các đơn thuộc chính shop hiện tại bằng danh sách processedOrdersJson để chống đếm trùng
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

        // Bổ sung phân rã 3PL từ các shop khác trong mạng lưới
        if (useCarrier3pl && ledger.carrierBreakdownJson) {
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
        providerName: 'Mạng lưới Cộng đồng Liên Shop (HMAC-SHA256)',
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
            ? `Khớp 1-1 qua HMAC: ${otherShopsDelivered} đơn nhận, ${otherShopsReturned} đơn hoàn, ${activeCommunityReports.length} báo xấu từ mạng lưới.`
            : 'SĐT này chưa có lịch sử giao nhận hoặc báo xấu trên mạng lưới liên shop.',
        checkedAt: new Date().toISOString(),
      });
    }

    // =========================================================================
    // TẦNG 3: TRA CỨU CỔNG CỘNG ĐỒNG CÔNG KHAI KHÔNG CẦN API KEY (ZERO-KEY)
    // (ChongBomHang.com, GhetBomHang.com, CheckScam.vn — Redis Cache 30 phút)
    // =========================================================================
    let resolvedViaPublicWeb = false;
    const enablePublicWeb =
      params.enablePublicWebRiskLookup ??
      (cfg as CrmTrustAndIndustryConfig)?.enablePublicWebRiskLookup ??
      true;

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
          resolvedViaPublicWeb = true;
          communityBucket.status = 'LIVE_VERIFIED';
          communityBucket.lastUpdatedAt = hit.checkedAt;
          for (const rep of hit.reports) {
            collectedReports.push(rep);
          }
        }
      }
    }

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
        ? 'SĐT này hiện sạch (0 đơn nhận / 0 đơn hoàn / 0 báo xấu) trên OMS nội bộ, Sổ cái dữ liệu đã nạp và 3 cổng cộng đồng công khai.'
        : null;

    const sourceEnum = resolvedViaPublicWeb
      ? PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE
      : useCommunity && useCarrier3pl
        ? PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE
        : useCommunity
          ? PhoneTrustLookupSourceEnum.PANCAKE_COMMUNITY_NETWORK
          : PhoneTrustLookupSourceEnum.INTERNAL_SHOP_POS;

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
      lookupSource: sourceEnum,
      lookupSourceLabel: this.resolveLookupSourceLabel(sourceEnum, enabledCarriers),
      phoneGlobalHash: resolvedGlobalHash,
      hasPhoneIdentifier: true,
      warningMessage,
    };
  }

  /**
   * Chấm điểm Uy tín Giao nhận (0–100) theo công thức Bayesian có trọng số + Time-Decay báo cáo xấu.
   */
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
          'Chưa ghi nhận đơn nhận/hoàn hay báo xấu trên các nguồn đang kết nối — xác nhận rõ địa chỉ trước khi gửi.',
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
    const map = this.initSourceBreakdownMap(false);
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
