import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import * as crypto from 'crypto';
import {
  ChannelTypeEnum,
  DeliveryTrustBandEnum,
  PhoneTrustLookupSourceEnum,
  PosOrderStatusEnum,
} from 'src/common/enum';
import { CustomerAbuseReportItem, CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { PosOrderEntity } from 'src/entity/pos-order.entity';
import { CrmTrustAndIndustryConfig } from 'src/entity/shop-workspace.entity';
import { Repository } from 'typeorm';

export type DeliverySourceCodeType =
  | 'INTERNAL_SHOP_POS'
  | 'PANCAKE_COMMUNITY'
  | 'CARRIER_3PL_VTP'
  | 'CARRIER_3PL_GHN'
  | 'CARRIER_3PL_GHTK'
  | 'CARRIER_3PL_JT'
  | 'MARKETPLACE_SHOPEE'
  | 'CUSTOM_WEBHOOK_PROVIDER';

export interface DeliverySourceBreakdownItem {
  sourceCode: DeliverySourceCodeType;
  sourceName: string;
  shortLabel: string;
  deliveredCount: number;
  returnedCount: number;
  reportedCount: number;
  successRatePercent: number;
  confidenceWeight: number;
  status: 'LIVE_VERIFIED' | 'COMMUNITY_SYNCED' | 'LOCAL_LEDGER' | 'NO_RECORD' | 'NOT_CONFIGURED';
  lastUpdatedAt: string | null;
}

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
  reportedReasons: CustomerAbuseReportItem[];
  sourceBreakdowns: DeliverySourceBreakdownItem[];
  lookupSource: string;
  lookupSourceLabel: string;
  checkedAt: string;
}

export interface ExternalPhoneReputationLookupResult {
  networkDeliveredCount: number;
  networkReturnedCount: number;
  reportedCount: number;
  reportedReasons: CustomerAbuseReportItem[];
  sourceBreakdowns: DeliverySourceBreakdownItem[];
  lookupSource: string;
  lookupSourceLabel: string;
  hasPhoneIdentifier: boolean;
  warningMessage: string | null;
}

const SOURCE_META_MAP: Record<
  DeliverySourceCodeType,
  { sourceName: string; shortLabel: string; confidenceWeight: number }
> = {
  INTERNAL_SHOP_POS: {
    sourceName: 'Đơn nội bộ cửa hàng (POS)',
    shortLabel: 'POS nội bộ',
    confidenceWeight: 1.0,
  },
  PANCAKE_COMMUNITY: {
    sourceName: 'Cộng đồng Pancake v2 / Pancake POS',
    shortLabel: 'Pancake v2/POS',
    confidenceWeight: 0.9,
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
    sourceName: 'Cổng tín nhiệm mở rộng (Webhook)',
    shortLabel: 'API mở rộng',
    confidenceWeight: 0.85,
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
  ) {}

  public resolveLookupSourceLabel(source?: string | null, carriers?: string[]): string {
    const carrierStr =
      carriers && carriers.length > 0 ? carriers.join('/') : 'VTP/GHN/GHTK/J&T/Shopee';
    switch (source) {
      case PhoneTrustLookupSourceEnum.INTERNAL_SHOP_POS:
        return 'POS nội bộ cửa hàng';
      case PhoneTrustLookupSourceEnum.PANCAKE_COMMUNITY_NETWORK:
        return 'Cộng đồng Pancake v2 / POS';
      case PhoneTrustLookupSourceEnum.CARRIER_3PL_GHN_GHTK:
        return `ĐVVC 3PL (${carrierStr})`;
      case PhoneTrustLookupSourceEnum.CUSTOM_EXTERNAL_WEBHOOK:
        return 'API tín nhiệm mở rộng';
      default:
        return `Pancake v2/POS + ${carrierStr}`;
    }
  }

  public resolveReportSourceBadgeLabel(
    source?: string | null,
    carrierCode?: string | null,
  ): string {
    const upperCarrier = carrierCode ? carrierCode.trim().toUpperCase() : '';
    if (upperCarrier === 'VTP' || upperCarrier === 'VIETTELPOST') {
      return 'ViettelPost';
    }
    if (upperCarrier === 'GHN') {
      return 'Giao Hàng Nhanh (GHN)';
    }
    if (upperCarrier === 'GHTK') {
      return 'Giao Hàng Tiết Kiệm (GHTK)';
    }
    if (upperCarrier === 'JT' || upperCarrier === 'J&T') {
      return 'J&T Express';
    }
    if (upperCarrier === 'SPX' || upperCarrier === 'SHOPEE') {
      return 'Shopee / SPX';
    }
    if (upperCarrier) {
      return `ĐVVC ${upperCarrier}`;
    }

    switch (source) {
      case 'SHOP_INTERNAL':
        return 'POS nội bộ';
      case 'PANCAKE_COMMUNITY':
      case 'PANCAKE_V2':
      case 'PANCAKE_POS':
        return 'Cộng đồng Pancake v2/POS';
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
    if (upperCarrier === 'GHN') {
      return 'CARRIER_3PL_GHN';
    }
    if (upperCarrier === 'GHTK') {
      return 'CARRIER_3PL_GHTK';
    }
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
    return 'CARRIER_3PL_GHN';
  }

  private normalizeCarrierReportSource(
    source?: string | null,
    carrierCode?: string | null,
  ): DeliverySourceCodeType {
    if (carrierCode) {
      return this.mapCarrierOrChannelToSourceCode(carrierCode, null);
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
              trackingNumber ||
                sourceCode.startsWith('CARRIER_3PL_') ||
                sourceCode === 'MARKETPLACE_SHOPEE',
            );

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

  public async lookupPhoneReputationFromSources(params: {
    rawPhone?: string | null;
    phoneMasked?: string | null;
    phoneSearchHash?: string | null;
    excludeShopId?: string | null;
    customerId?: string | null;
    config?: Partial<CrmTrustAndIndustryConfig> | null;
    decryptedCustomApiKey?: string | null;
    overrideSources?: string[] | null;
    overrideWebhookUrl?: string | null;
  }): Promise<ExternalPhoneReputationLookupResult> {
    const safeRawPhone =
      params.rawPhone && !params.rawPhone.includes('[') && !params.rawPhone.includes('*')
        ? params.rawPhone
        : '';
    const cleanDigits = safeRawPhone.replace(/\D/g, '');
    const normalizedPhone =
      cleanDigits.startsWith('84') && cleanDigits.length === 11
        ? `0${cleanDigits.slice(2)}`
        : cleanDigits.length >= 9
          ? cleanDigits
          : '';

    const resolvedMaskedPhone =
      normalizedPhone.length >= 9
        ? `${normalizedPhone.slice(0, 3)}***${normalizedPhone.slice(-3)}`
        : params.phoneMasked && params.phoneMasked.includes('*')
          ? params.phoneMasked.trim()
          : '';

    const cfg = params.config || {};
    const overrideSet =
      Array.isArray(params.overrideSources) && params.overrideSources.length > 0
        ? new Set(params.overrideSources.map((s) => String(s).toUpperCase()))
        : null;

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

    let networkDeliveredCount = 0;
    let networkReturnedCount = 0;
    let reportedCount = 0;
    const collectedReports: Array<Partial<CustomerAbuseReportItem> & Record<string, any>> = [];
    let resolvedViaCustomWebhook = false;

    const hasPhoneIdentifier = Boolean(
      normalizedPhone || resolvedMaskedPhone || params.phoneSearchHash,
    );

    if (!hasPhoneIdentifier && !params.customerId) {
      return {
        networkDeliveredCount: 0,
        networkReturnedCount: 0,
        reportedCount: 0,
        reportedReasons: [],
        sourceBreakdowns: this.finalizeBreakdownList(breakdownMap),
        lookupSource: PhoneTrustLookupSourceEnum.INTERNAL_SHOP_POS,
        lookupSourceLabel: this.resolveLookupSourceLabel(
          PhoneTrustLookupSourceEnum.INTERNAL_SHOP_POS,
          enabledCarriers,
        ),
        hasPhoneIdentifier: false,
        warningMessage:
          'Khách hàng chưa có số điện thoại trong hồ sơ. Hãy lưu SĐT để tra cứu lịch sử nhận/hoàn từ cộng đồng và ĐVVC.',
      };
    }

    if (normalizedPhone && hasCustomWebhook) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (params.decryptedCustomApiKey) {
          headers['Authorization'] = `Bearer ${params.decryptedCustomApiKey}`;
          headers['X-API-Key'] = params.decryptedCustomApiKey;
        }

        const res = await fetch(effectiveWebhookUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            phone: normalizedPhone,
            phoneSha256: crypto.createHash('sha256').update(normalizedPhone).digest('hex'),
            phoneSearchHash: params.phoneSearchHash || null,
            enabledCarriers,
          }),
          signal: controller.signal,
        }).catch(() => null);
        clearTimeout(timeoutId);

        if (res && res.ok) {
          const extData = (await res.json().catch(() => ({}))) as Record<string, any>;
          const payloadNode = extData?.data || extData;
          if (
            typeof payloadNode?.deliveredCount === 'number' ||
            typeof payloadNode?.returnedCount === 'number' ||
            Array.isArray(payloadNode?.reportedReasons) ||
            Array.isArray(payloadNode?.reports)
          ) {
            resolvedViaCustomWebhook = true;
            const extDelivered = Math.max(0, Number(payloadNode.deliveredCount || 0));
            const extReturned = Math.max(0, Number(payloadNode.returnedCount || 0));
            const extReported = Math.max(0, Number(payloadNode.reportedCount || 0));

            networkDeliveredCount += extDelivered;
            networkReturnedCount += extReturned;
            reportedCount += extReported;

            const webhookBucket = breakdownMap.get('CUSTOM_WEBHOOK_PROVIDER')!;
            webhookBucket.deliveredCount += extDelivered;
            webhookBucket.returnedCount += extReturned;
            webhookBucket.reportedCount += extReported;
            webhookBucket.status = 'LIVE_VERIFIED';
            webhookBucket.lastUpdatedAt = new Date().toISOString();

            const extReports = Array.isArray(payloadNode.reportedReasons)
              ? payloadNode.reportedReasons
              : Array.isArray(payloadNode.reports)
                ? payloadNode.reports
                : [];
            for (const extRep of extReports) {
              collectedReports.push({
                ...extRep,
                source: extRep?.source || 'CUSTOM_WEBHOOK_PROVIDER',
              });
            }
          }
        }
      } catch (err) {
        clearTimeout(timeoutId);
        this.logger.warn(
          `Custom trust webhook lookup skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (useCommunity && (resolvedMaskedPhone || params.phoneSearchHash)) {
      try {
        const qb = this.customerRepo.createQueryBuilder('cp');
        if (resolvedMaskedPhone && params.phoneSearchHash) {
          qb.where('cp.phone_masked = :maskedPhone OR cp.phone_search_hash = :phoneSearchHash', {
            maskedPhone: resolvedMaskedPhone,
            phoneSearchHash: params.phoneSearchHash,
          });
        } else if (params.phoneSearchHash) {
          qb.where('cp.phone_search_hash = :phoneSearchHash', {
            phoneSearchHash: params.phoneSearchHash,
          });
        } else {
          qb.where('cp.phone_masked = :maskedPhone', {
            maskedPhone: resolvedMaskedPhone,
          });
        }

        const matchedProfiles = await qb.take(50).getMany();
        const communityBucket = breakdownMap.get('PANCAKE_COMMUNITY')!;
        const shopBucket = breakdownMap.get('INTERNAL_SHOP_POS')!;

        for (const prof of matchedProfiles) {
          const isOtherShop = Boolean(params.excludeShopId && prof.shopId !== params.excludeShopId);
          const profDelivered = Math.max(0, Number(prof.successfulDeliveriesCount || 0));
          const profReturned = Math.max(0, Number(prof.returnedOrdersCount || 0));
          const profReported = Math.max(0, Number(prof.reportedCount || 0));

          if (isOtherShop) {
            networkDeliveredCount += profDelivered;
            networkReturnedCount += profReturned;
            reportedCount += profReported;

            communityBucket.deliveredCount += profDelivered;
            communityBucket.returnedCount += profReturned;
            communityBucket.reportedCount += profReported;
            if (profDelivered > 0 || profReturned > 0 || profReported > 0) {
              communityBucket.status = 'COMMUNITY_SYNCED';
              communityBucket.lastUpdatedAt = new Date(
                prof.updatedAt || prof.createdAt || Date.now(),
              ).toISOString();
            }
          } else {
            shopBucket.deliveredCount = Math.max(shopBucket.deliveredCount, profDelivered);
            shopBucket.returnedCount = Math.max(shopBucket.returnedCount, profReturned);
            shopBucket.reportedCount = Math.max(shopBucket.reportedCount, profReported);
            if (profDelivered > 0 || profReturned > 0 || profReported > 0) {
              shopBucket.status = 'LOCAL_LEDGER';
              shopBucket.lastUpdatedAt = new Date(
                prof.updatedAt || prof.createdAt || Date.now(),
              ).toISOString();
            }
          }

          if (Array.isArray(prof.reportedReasonsJson)) {
            for (const rep of prof.reportedReasonsJson) {
              collectedReports.push({
                ...rep,
                source: rep.source || (isOtherShop ? 'PANCAKE_COMMUNITY' : 'SHOP_INTERNAL'),
              });
            }
          }
        }
      } catch (err) {
        this.logger.warn(
          `Community phone lookup fallback: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (useCarrier3pl && (resolvedMaskedPhone || params.customerId)) {
      try {
        const orderQb = this.posOrderRepo.createQueryBuilder('ord');
        if (resolvedMaskedPhone && params.customerId) {
          orderQb.where(
            'ord.customer_phone_masked = :maskedPhone OR ord.customer_id = :customerId',
            {
              maskedPhone: resolvedMaskedPhone,
              customerId: params.customerId,
            },
          );
        } else if (resolvedMaskedPhone) {
          orderQb.where('ord.customer_phone_masked = :maskedPhone', {
            maskedPhone: resolvedMaskedPhone,
          });
        } else {
          orderQb.where('ord.customer_id = :customerId', {
            customerId: params.customerId,
          });
        }

        const matchedOrders = await orderQb.orderBy('ord.created_at', 'DESC').take(100).getMany();

        let otherShopDeliveredOrders = 0;
        let otherShopReturnedOrders = 0;

        for (const ord of matchedOrders) {
          const isOtherShopOrder = Boolean(
            params.excludeShopId && ord.shopId !== params.excludeShopId,
          );
          const sourceCode = this.mapCarrierOrChannelToSourceCode(ord.carrierCode, ord.channelType);
          const carrierBucket = breakdownMap.get(sourceCode);
          const ordTimestampIso = new Date(
            ord.updatedAt || ord.createdAt || Date.now(),
          ).toISOString();

          if (
            ord.status === PosOrderStatusEnum.DELIVERED ||
            ord.status === PosOrderStatusEnum.DELIVERED_RECONCILED
          ) {
            if (isOtherShopOrder) {
              otherShopDeliveredOrders += 1;
            }
            if (carrierBucket) {
              carrierBucket.deliveredCount += 1;
              carrierBucket.status = 'LIVE_VERIFIED';
              carrierBucket.lastUpdatedAt = carrierBucket.lastUpdatedAt || ordTimestampIso;
            }
          } else if (
            ord.status === PosOrderStatusEnum.RETURNED_RESTOCKED ||
            ord.status === PosOrderStatusEnum.RETURNING ||
            ord.status === PosOrderStatusEnum.DELIVERY_FAILED_RESCUE
          ) {
            if (isOtherShopOrder) {
              otherShopReturnedOrders += 1;
            }
            if (carrierBucket) {
              carrierBucket.returnedCount += 1;
              carrierBucket.status = 'LIVE_VERIFIED';
              carrierBucket.lastUpdatedAt = carrierBucket.lastUpdatedAt || ordTimestampIso;
            }

            const carrierUpper = (ord.carrierCode || 'GHN').toUpperCase();
            const reportText =
              ord.note && ord.note.trim()
                ? ord.note.trim()
                : ord.status === PosOrderStatusEnum.DELIVERY_FAILED_RESCUE
                  ? `Giao hàng thất bại qua ${carrierUpper} — khách không nghe máy hoặc hẹn nhiều lần`
                  : `Đơn hàng hoàn về qua ${carrierUpper} (Trạng thái: ${ord.status})`;

            collectedReports.push({
              reportId: `rep_3pl_ord_${ord.id}`,
              reason: reportText,
              reasonCode:
                ord.status === PosOrderStatusEnum.DELIVERY_FAILED_RESCUE
                  ? 'TU_CHOI_NHAN_NHIEU_LAN'
                  : 'BOM_HANG',
              reasonNote: reportText,
              carrierCode: carrierUpper,
              orderCode: ord.orderCode,
              trackingNumber: ord.trackingNumber || null,
              source: sourceCode,
              isCarrierVerified: true,
              severity: ord.status === PosOrderStatusEnum.RETURNED_RESTOCKED ? 'CRITICAL' : 'HIGH',
              reportedByName: `Đối soát ${this.resolveReportSourceBadgeLabel(sourceCode, carrierUpper)}${ord.trackingNumber ? ` (#${ord.trackingNumber})` : ''}`,
              reportedAt: ordTimestampIso,
            });
          }
        }

        networkDeliveredCount = Math.max(networkDeliveredCount, otherShopDeliveredOrders);
        networkReturnedCount = Math.max(networkReturnedCount, otherShopReturnedOrders);
      } catch (err) {
        this.logger.warn(
          `3PL order ledger lookup fallback: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const sortedReasons = this.sortAndNormalizeAbuseReportsNewestFirst(collectedReports);

    for (const rep of sortedReasons) {
      const bucketCode = this.normalizeCarrierReportSource(rep.source, rep.carrierCode);
      const bucket = breakdownMap.get(bucketCode);
      if (bucket) {
        bucket.reportedCount = Math.max(bucket.reportedCount, 0) + 1;
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

    const finalReportedCount = Math.max(reportedCount, sortedReasons.length);

    const sourceEnum = resolvedViaCustomWebhook
      ? PhoneTrustLookupSourceEnum.CUSTOM_EXTERNAL_WEBHOOK
      : useCommunity && useCarrier3pl
        ? PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE
        : useCommunity
          ? PhoneTrustLookupSourceEnum.PANCAKE_COMMUNITY_NETWORK
          : useCarrier3pl
            ? PhoneTrustLookupSourceEnum.CARRIER_3PL_GHN_GHTK
            : PhoneTrustLookupSourceEnum.INTERNAL_SHOP_POS;

    return {
      networkDeliveredCount,
      networkReturnedCount,
      reportedCount: finalReportedCount,
      reportedReasons: sortedReasons,
      sourceBreakdowns: this.finalizeBreakdownList(breakdownMap),
      lookupSource: sourceEnum,
      lookupSourceLabel: this.resolveLookupSourceLabel(sourceEnum, enabledCarriers),
      hasPhoneIdentifier: true,
      warningMessage: null,
    };
  }

  public evaluateCustomerTrustScore(params: {
    successfulDeliveriesCount: number;
    returnedOrdersCount: number;
    networkDeliveredCount?: number;
    networkReturnedCount?: number;
    reportedCount?: number;
    reportedReasons?: CustomerAbuseReportItem[] | null;
    sourceBreakdowns?: DeliverySourceBreakdownItem[] | null;
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
        const recencyFactor = ageDays <= 90 ? 1.0 : ageDays <= 180 ? 0.75 : 0.5;
        const basePenalty = rep.isCarrierVerified ? 18 : 14;
        weightedReportPenalty += basePenalty * recencyFactor;
      }
      weightedReportPenalty = Math.min(50, Math.round(weightedReportPenalty));
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
          'Nên yêu cầu đặt cọc trước qua VietQR hoặc gọi xác nhận kỹ trước khi gửi hàng.',
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
        reportedReasons,
        sourceBreakdowns: resolvedBreakdowns,
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
          'Chưa có lịch sử hoàn đơn hay báo cáo xấu — xác nhận rõ địa chỉ trước khi gửi.',
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
        reportedReasons: [],
        sourceBreakdowns: resolvedBreakdowns,
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
        reportedReasons,
        sourceBreakdowns: resolvedBreakdowns,
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
      reportedReasons,
      sourceBreakdowns: resolvedBreakdowns,
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
