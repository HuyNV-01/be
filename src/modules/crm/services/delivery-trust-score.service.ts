import { Injectable } from '@nestjs/common';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { DeliveryTrustBandEnum, PhoneTrustLookupSourceEnum } from 'src/common/enum';
import { DeliverySourceCodeEnum, TrustProviderStatusEnum } from 'src/common/enum/phone-trust.enum';
import { envs } from 'src/config/envs/envs';
import { CustomerAbuseReportItem } from 'src/entity/customer-profile.entity';
import { CrmTrustAndIndustryConfig } from 'src/entity/shop-workspace.entity';
import { MessageCryptoService } from 'src/modules/chat/services/message-crypto.service';

import { PhoneTrustBlindIndexService } from './phone-trust-blind-index.service';
import { PhoneTrustLedgerService } from './phone-trust-ledger.service';
import {
  ExternalProviderLookupOutput,
  PhoneTrustProviderAdaptersService,
} from './phone-trust-provider-adapters.service';

export interface TrustProviderDiagnosticItem {
  providerCode: string;
  providerName: string;
  status: TrustProviderStatusEnum;
  deliveredCount: number;
  returnedCount: number;
  reportedCount: number;
  latencyMs: number;
  fromCache: boolean;
  message: string;
  checkedAt: string;
}

export interface DeliverySourceBreakdownItem {
  sourceCode: DeliverySourceCodeEnum;
  sourceName: string;
  shortLabel: string;
  deliveredCount: number;
  returnedCount: number;
  reportedCount: number;
  successRatePercent: number;
  confidenceWeight: number;
  status: TrustProviderStatusEnum;
  lastUpdatedAt: string | null;
  diagnosticMessage?: string | null;
  latencyMs?: number | null;
}

export interface DeliveryTrustEvaluationResult {
  score: number;
  band: DeliveryTrustBandEnum;
  badgeVariant: 'success' | 'info' | 'warning' | 'danger';
  headline: string;
  recommendation: string;
  requireDepositVietQr: boolean;
  isBlacklisted?: boolean;
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
  providerDiagnostics: TrustProviderDiagnosticItem[];
  lookupSource: string;
  lookupSourceLabel: string;
  checkedAt: string;
  lastLookupAt: string;
}

export interface ExternalPhoneReputationLookupResult {
  shopDeliveredCount: number;
  shopReturnedCount: number;
  shopDeliveredFromLedger: number;
  shopReturnedFromLedger: number;
  networkDeliveredCount: number;
  networkReturnedCount: number;
  reportedCount: number;
  verifiedReportedCount: number;
  reportedReasons: CustomerAbuseReportItem[];
  sourceBreakdowns: DeliverySourceBreakdownItem[];
  providerDiagnostics: TrustProviderDiagnosticItem[];
  lookupSource: string;
  lookupSourceLabel: string;
  warningMessage: string | null;
}

/**
 * Production real-data trust scoring engine.
 * Aggregates internal shop ledger, multi-tenant cross-shop consortium, platform partner gateway
 * (PLATFORM_TRUST_COMMUNITY_GATEWAY_URL), Pancake POS, Nhanh.vn, and custom shop webhooks
 * concurrently without any hardcoded seed or synthetic hash fabrication.
 */
@Injectable()
export class DeliveryTrustScoreService {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly blindIndexService: PhoneTrustBlindIndexService,
    private readonly ledgerService: PhoneTrustLedgerService,
    private readonly providerAdapters: PhoneTrustProviderAdaptersService,
    private readonly messageCryptoService: MessageCryptoService,
  ) {}

  public resolveLookupSourceLabel(source?: string | null, carriers?: string[]): string {
    const carrierStr = carriers && carriers.length > 0 ? carriers.join('/') : 'GHN/GHTK/VTP/J&T';
    switch (source) {
      case PhoneTrustLookupSourceEnum.INTERNAL_SHOP_POS:
        return 'Sổ cái Đơn hàng Nội bộ Cửa hàng';
      case PhoneTrustLookupSourceEnum.PANCAKE_COMMUNITY_NETWORK:
        return 'Mạng lưới Liên shop & Đối tác Cộng đồng';
      case PhoneTrustLookupSourceEnum.CARRIER_3PL_GHN_GHTK:
        return `Đồng bộ ĐVVC 3PL (${carrierStr})`;
      case PhoneTrustLookupSourceEnum.CUSTOM_EXTERNAL_WEBHOOK:
        return 'API Nguồn Dữ Liệu Tùy Chỉnh';
      default:
        return `Đa nguồn thực (Nội bộ + Liên shop + ĐVVC ${carrierStr})`;
    }
  }

  private decryptShopSecretInRam(shopId: string, encrypted?: string | null): string | null {
    if (!encrypted) return null;
    return (
      this.messageCryptoService.decryptForConversation(encrypted, `pii_vault:${shopId}`) || null
    );
  }

  public async lookupPhoneReputationFromSources(params: {
    shopId: string;
    rawPhone: string;
    phoneMasked?: string | null;
    customerId?: string | null;
    config?: Partial<CrmTrustAndIndustryConfig> | null;
    decryptedCustomApiKey?: string | null;
    bypassCache?: boolean;
  }): Promise<ExternalPhoneReputationLookupResult> {
    const normalizedPhone = this.blindIndexService.normalizeVietnamesePhone(params.rawPhone);
    const enabledCarriers = params.config?.enabledCarriers || ['GHN', 'GHTK', 'VTP', 'JT'];

    if (!this.blindIndexService.isValidVietnamesePhone(normalizedPhone)) {
      return {
        shopDeliveredCount: 0,
        shopReturnedCount: 0,
        shopDeliveredFromLedger: 0,
        shopReturnedFromLedger: 0,
        networkDeliveredCount: 0,
        networkReturnedCount: 0,
        reportedCount: 0,
        verifiedReportedCount: 0,
        reportedReasons: [],
        sourceBreakdowns: [],
        providerDiagnostics: [],
        lookupSource: PhoneTrustLookupSourceEnum.INTERNAL_SHOP_POS,
        lookupSourceLabel: this.resolveLookupSourceLabel(
          PhoneTrustLookupSourceEnum.INTERNAL_SHOP_POS,
          enabledCarriers,
        ),
        warningMessage: 'Số điện thoại không đúng định dạng Việt Nam hợp lệ.',
      };
    }

    const globalPhoneHash = this.blindIndexService.computeGlobalPhoneHash(normalizedPhone);
    const cacheKey = `trust:lookup:v2:${params.shopId}:${globalPhoneHash}`;

    if (!params.bypassCache) {
      try {
        const cachedRaw = await this.redis.get(cacheKey);
        if (cachedRaw) {
          const parsed = JSON.parse(cachedRaw) as ExternalPhoneReputationLookupResult;
          parsed.providerDiagnostics = parsed.providerDiagnostics.map((diag) => ({
            ...diag,
            fromCache: true,
          }));
          return parsed;
        }
      } catch {
        // Proceed with live lookup if Redis is temporarily unavailable.
      }
    }

    const cfg = params.config || {};
    const useCommunity = cfg.usePancakeCommunityNetwork !== false;
    const useCarrier3pl = cfg.useCarrier3plLookup !== false;
    const nowIso = new Date().toISOString();

    const decryptedPancakeKey = this.decryptShopSecretInRam(
      params.shopId,
      cfg.pancakePosApiKeyEncrypted,
    );
    const decryptedNhanhToken = this.decryptShopSecretInRam(
      params.shopId,
      cfg.nhanhAccessTokenEncrypted,
    );
    const decryptedCustomKey =
      params.decryptedCustomApiKey ??
      this.decryptShopSecretInRam(params.shopId, cfg.customLookupApiKeyEncrypted);

    const ledgerStartedAt = Date.now();
    const [ledgerSnapshot, gatewayResult, pancakePosResult, nhanhVnResult, customWebhookResult] =
      await Promise.all([
        this.ledgerService.getLedgerSnapshotForPhone({
          shopId: params.shopId,
          normalizedPhone,
          includeConsortium: useCommunity,
        }),
        useCommunity || useCarrier3pl
          ? this.providerAdapters.queryPlatformCommunityGateway({
              normalizedPhone,
              globalPhoneHash,
              shopId: params.shopId,
            })
          : Promise.resolve(null),
        cfg.pancakePosShopId && decryptedPancakeKey
          ? this.providerAdapters.queryPancakePosLiveApi({
              normalizedPhone,
              pancakePosShopId: cfg.pancakePosShopId,
              decryptedApiKey: decryptedPancakeKey,
            })
          : Promise.resolve(null),
        cfg.nhanhAppId && cfg.nhanhBusinessId && decryptedNhanhToken
          ? this.providerAdapters.queryNhanhVnLiveApi({
              normalizedPhone,
              nhanhAppId: cfg.nhanhAppId,
              nhanhBusinessId: cfg.nhanhBusinessId,
              decryptedAccessToken: decryptedNhanhToken,
            })
          : Promise.resolve(null),
        cfg.customLookupWebhookUrl
          ? this.providerAdapters.queryCustomExternalWebhook({
              normalizedPhone,
              globalPhoneHash,
              customWebhookUrl: cfg.customLookupWebhookUrl,
              decryptedCustomApiKey: decryptedCustomKey,
            })
          : Promise.resolve(null),
      ]);
    const ledgerLatencyMs = Date.now() - ledgerStartedAt;

    const sourceBreakdowns: DeliverySourceBreakdownItem[] = [];
    const providerDiagnostics: TrustProviderDiagnosticItem[] = [];
    const allReasons: CustomerAbuseReportItem[] = [...ledgerSnapshot.activeReports];

    // 1. Internal Shop Ledger breakdown
    const shopTotal = ledgerSnapshot.shopDeliveredCount + ledgerSnapshot.shopReturnedCount;
    const shopSuccessRate =
      shopTotal > 0 ? Math.round((ledgerSnapshot.shopDeliveredCount / shopTotal) * 100) : 100;
    const ownShopReportsCount = ledgerSnapshot.activeReports.filter(
      (r) => r.source === 'SHOP_INTERNAL',
    ).length;

    sourceBreakdowns.push({
      sourceCode: DeliverySourceCodeEnum.INTERNAL_SHOP_POS,
      sourceName: 'Sổ cái Đơn hàng Nội bộ Shop',
      shortLabel: 'Nội bộ Shop',
      deliveredCount: ledgerSnapshot.shopDeliveredCount,
      returnedCount: ledgerSnapshot.shopReturnedCount,
      reportedCount: ownShopReportsCount,
      successRatePercent: shopSuccessRate,
      confidenceWeight: 1.0,
      status:
        shopTotal > 0 || ownShopReportsCount > 0
          ? TrustProviderStatusEnum.LOCAL_LEDGER
          : TrustProviderStatusEnum.NO_RECORD,
      lastUpdatedAt: ledgerSnapshot.lastEventAt,
      latencyMs: ledgerLatencyMs,
    });

    providerDiagnostics.push({
      providerCode: 'INTERNAL_SHOP_LEDGER',
      providerName: 'Sổ cái Đơn hàng & Báo xấu Nội bộ Shop',
      status:
        shopTotal > 0 || ownShopReportsCount > 0
          ? TrustProviderStatusEnum.LOCAL_LEDGER
          : TrustProviderStatusEnum.NO_RECORD,
      deliveredCount: ledgerSnapshot.shopDeliveredCount,
      returnedCount: ledgerSnapshot.shopReturnedCount,
      reportedCount: ownShopReportsCount,
      latencyMs: ledgerLatencyMs,
      fromCache: false,
      message:
        shopTotal > 0 || ownShopReportsCount > 0
          ? `Ghi nhận thực tại shop: Nhận ${ledgerSnapshot.shopDeliveredCount} • Hoàn ${ledgerSnapshot.shopReturnedCount} • Báo xấu ${ownShopReportsCount}.`
          : 'Khách chưa có lịch sử giao nhận hoặc báo xấu tại shop này.',
      checkedAt: nowIso,
    });

    // 2. Internal Cross-Shop Consortium Network breakdown
    const consortiumReportsCount = ledgerSnapshot.activeReports.filter(
      (r) => r.source !== 'SHOP_INTERNAL',
    ).length;
    const consortiumTotal =
      ledgerSnapshot.consortiumOtherShopsDeliveredCount +
      ledgerSnapshot.consortiumOtherShopsReturnedCount;
    const consortiumSuccessRate =
      consortiumTotal > 0
        ? Math.round((ledgerSnapshot.consortiumOtherShopsDeliveredCount / consortiumTotal) * 100)
        : 100;

    if (useCommunity) {
      sourceBreakdowns.push({
        sourceCode: DeliverySourceCodeEnum.PANCAKE_COMMUNITY,
        sourceName: 'Mạng lưới Liên shop Nền tảng (Consortium)',
        shortLabel: 'Liên shop',
        deliveredCount: ledgerSnapshot.consortiumOtherShopsDeliveredCount,
        returnedCount: ledgerSnapshot.consortiumOtherShopsReturnedCount,
        reportedCount: consortiumReportsCount,
        successRatePercent: consortiumSuccessRate,
        confidenceWeight: 0.95,
        status:
          consortiumTotal > 0 || consortiumReportsCount > 0
            ? TrustProviderStatusEnum.COMMUNITY_SYNCED
            : TrustProviderStatusEnum.NO_RECORD,
        lastUpdatedAt: ledgerSnapshot.lastEventAt,
        latencyMs: ledgerLatencyMs,
      });

      providerDiagnostics.push({
        providerCode: 'INTERNAL_MULTI_SHOP_CONSORTIUM',
        providerName: 'Mạng lưới Liên shop (Blind Index)',
        status:
          consortiumTotal > 0 || consortiumReportsCount > 0
            ? TrustProviderStatusEnum.COMMUNITY_SYNCED
            : TrustProviderStatusEnum.NO_RECORD,
        deliveredCount: ledgerSnapshot.consortiumOtherShopsDeliveredCount,
        returnedCount: ledgerSnapshot.consortiumOtherShopsReturnedCount,
        reportedCount: consortiumReportsCount,
        latencyMs: ledgerLatencyMs,
        fromCache: false,
        message:
          consortiumTotal > 0 || consortiumReportsCount > 0
            ? `Đồng bộ từ các shop khác trên hệ thống: Nhận ${ledgerSnapshot.consortiumOtherShopsDeliveredCount} • Hoàn ${ledgerSnapshot.consortiumOtherShopsReturnedCount} • Báo xấu ${consortiumReportsCount}.`
            : 'Chưa có shop nào khác trên nền tảng ghi nhận lịch sử cho SĐT này.',
        checkedAt: nowIso,
      });
    }

    // 3. Per-carrier breakdown from verified webhook ledger (GHN / GHTK / VTP / JT)
    const carrierSourceMap: Record<
      string,
      { code: DeliverySourceCodeEnum; name: string; shortLabel: string }
    > = {
      GHN: {
        code: DeliverySourceCodeEnum.CARRIER_3PL_GHN,
        name: 'Giao Hàng Nhanh (GHN Webhook)',
        shortLabel: 'GHN',
      },
      GHTK: {
        code: DeliverySourceCodeEnum.CARRIER_3PL_GHTK,
        name: 'Giao Hàng Tiết Kiệm (GHTK Webhook)',
        shortLabel: 'GHTK',
      },
      VTP: {
        code: DeliverySourceCodeEnum.CARRIER_3PL_VTP,
        name: 'ViettelPost (VTP Webhook)',
        shortLabel: 'ViettelPost',
      },
      JT: {
        code: DeliverySourceCodeEnum.CARRIER_3PL_JT,
        name: 'J&T Express (3PL Ledger)',
        shortLabel: 'J&T',
      },
    };

    for (const [carrierKey, stats] of Object.entries(ledgerSnapshot.carrierBreakdown)) {
      const meta = carrierSourceMap[carrierKey];
      if (!meta) continue;
      const cTotal = stats.deliveredCount + stats.returnedCount;
      if (cTotal === 0) continue;
      sourceBreakdowns.push({
        sourceCode: meta.code,
        sourceName: meta.name,
        shortLabel: meta.shortLabel,
        deliveredCount: stats.deliveredCount,
        returnedCount: stats.returnedCount,
        reportedCount: 0,
        successRatePercent: Math.round((stats.deliveredCount / cTotal) * 100),
        confidenceWeight: 1.0,
        status: TrustProviderStatusEnum.LIVE_VERIFIED,
        lastUpdatedAt: stats.lastEventAt,
      });
    }

    // 4. Merge external live adapter outputs without double-counting internal ledger
    const externalOutputs: ExternalProviderLookupOutput[] = [
      gatewayResult,
      pancakePosResult,
      nhanhVnResult,
      customWebhookResult,
    ].filter((item): item is ExternalProviderLookupOutput => Boolean(item));

    let externalDelivered = 0;
    let externalReturned = 0;
    let externalReported = 0;

    for (const ext of externalOutputs) {
      providerDiagnostics.push({
        providerCode: ext.providerCode,
        providerName: ext.providerName,
        status: ext.status,
        deliveredCount: ext.deliveredCount,
        returnedCount: ext.returnedCount,
        reportedCount: ext.reportedCount,
        latencyMs: ext.latencyMs,
        fromCache: ext.fromCache,
        message: ext.message,
        checkedAt: ext.checkedAt,
      });

      if (ext.status === TrustProviderStatusEnum.LIVE_VERIFIED) {
        externalDelivered += ext.deliveredCount;
        externalReturned += ext.returnedCount;
        externalReported += ext.reportedCount;
        allReasons.push(...ext.reportedReasons);

        const extTotal = ext.deliveredCount + ext.returnedCount;
        sourceBreakdowns.push({
          sourceCode: ext.sourceCode,
          sourceName: ext.providerName,
          shortLabel: ext.shortLabel,
          deliveredCount: ext.deliveredCount,
          returnedCount: ext.returnedCount,
          reportedCount: ext.reportedCount,
          successRatePercent:
            extTotal > 0 ? Math.round((ext.deliveredCount / extTotal) * 100) : 100,
          confidenceWeight: ext.confidenceWeight,
          status: ext.status,
          lastUpdatedAt: ext.checkedAt,
          diagnosticMessage: ext.message,
          latencyMs: ext.latencyMs,
        });
      }
    }

    const networkDeliveredCount =
      ledgerSnapshot.consortiumOtherShopsDeliveredCount + externalDelivered;
    const networkReturnedCount =
      ledgerSnapshot.consortiumOtherShopsReturnedCount + externalReturned;
    const reportedCount = ledgerSnapshot.activeReports.length + externalReported;

    const gatewayNotConfigured =
      gatewayResult?.status === TrustProviderStatusEnum.NOT_CONFIGURED &&
      networkDeliveredCount === 0 &&
      networkReturnedCount === 0 &&
      ledgerSnapshot.shopDeliveredCount === 0 &&
      ledgerSnapshot.shopReturnedCount === 0;

    const warningMessage = gatewayNotConfigured
      ? 'SĐT này chưa có lịch sử giao nhận trong hệ thống nội bộ và nền tảng chưa khai báo PLATFORM_TRUST_COMMUNITY_GATEWAY_URL để tra cứu liên sàn bên ngoài.'
      : null;

    const lookupSource =
      gatewayResult?.status === TrustProviderStatusEnum.LIVE_VERIFIED
        ? PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE
        : customWebhookResult?.status === TrustProviderStatusEnum.LIVE_VERIFIED
          ? PhoneTrustLookupSourceEnum.CUSTOM_EXTERNAL_WEBHOOK
          : useCommunity
            ? PhoneTrustLookupSourceEnum.PANCAKE_COMMUNITY_NETWORK
            : PhoneTrustLookupSourceEnum.INTERNAL_SHOP_POS;

    const finalOutput: ExternalPhoneReputationLookupResult = {
      shopDeliveredCount: ledgerSnapshot.shopDeliveredCount,
      shopReturnedCount: ledgerSnapshot.shopReturnedCount,
      shopDeliveredFromLedger: ledgerSnapshot.shopDeliveredCount,
      shopReturnedFromLedger: ledgerSnapshot.shopReturnedCount,
      networkDeliveredCount,
      networkReturnedCount,
      reportedCount,
      verifiedReportedCount: ledgerSnapshot.verifiedReportedCount,
      reportedReasons: allReasons.slice(0, 20),
      sourceBreakdowns,
      providerDiagnostics,
      lookupSource,
      lookupSourceLabel: this.resolveLookupSourceLabel(lookupSource, enabledCarriers),
      warningMessage,
    };

    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(finalOutput),
        'EX',
        envs.phoneTrust.cacheTtlSeconds,
      );
    } catch {
      // Cache write failure must not block lookup response.
    }

    return finalOutput;
  }

  /**
   * Computes the weighted 0-100 Delivery Trust Score and 4-tier risk classification
   * strictly from real delivery/return/report counts.
   */
  public evaluateCustomerTrustScore(params: {
    successfulDeliveriesCount: number;
    returnedOrdersCount: number;
    networkDeliveredCount?: number;
    networkReturnedCount?: number;
    reportedCount?: number;
    verifiedReportedCount?: number;
    reportedReasons?: CustomerAbuseReportItem[] | null;
    sourceBreakdowns?: DeliverySourceBreakdownItem[];
    providerDiagnostics?: TrustProviderDiagnosticItem[];
    isBlacklisted: boolean;
    shopRequireDepositOnHighRisk?: boolean;
    highRiskReturnRateThresholdPercent?: number;
    highRiskReportedCountThreshold?: number;
    autoRequireDepositBelowTrustScore?: number;
    lookupSource?: string | null;
    enabledCarriers?: string[];
    checkedAt?: Date | string | null;
  }): DeliveryTrustEvaluationResult {
    const shopDeliveredCount = Math.max(0, Number(params.successfulDeliveriesCount || 0));
    const shopReturnedCount = Math.max(0, Number(params.returnedOrdersCount || 0));
    const networkDeliveredCount = Math.max(0, Number(params.networkDeliveredCount || 0));
    const networkReturnedCount = Math.max(0, Number(params.networkReturnedCount || 0));
    const reportedCount = Math.max(0, Number(params.reportedCount || 0));
    const verifiedReportedCount = Math.max(0, Number(params.verifiedReportedCount || 0));
    const reportedReasons = Array.isArray(params.reportedReasons) ? params.reportedReasons : [];
    const sourceBreakdowns = Array.isArray(params.sourceBreakdowns) ? params.sourceBreakdowns : [];
    const providerDiagnostics = Array.isArray(params.providerDiagnostics)
      ? params.providerDiagnostics
      : [];

    const totalDeliveredCount = shopDeliveredCount + networkDeliveredCount;
    const totalReturnedCount = shopReturnedCount + networkReturnedCount;
    const totalCompletedOrReturned = totalDeliveredCount + totalReturnedCount;

    const isBlacklisted = Boolean(params.isBlacklisted);
    const blacklistPenalty = isBlacklisted ? 60 : 0;
    const unverifiedReports = Math.max(0, reportedCount - verifiedReportedCount);
    const reportPenalty = Math.min(50, verifiedReportedCount * 20 + unverifiedReports * 12);

    // Laplace-smoothed Bayesian score prevents a single new order from swinging the score to 0 or 100
    const rawFormulaScore = Math.round(
      ((totalDeliveredCount + 1) / (totalDeliveredCount + totalReturnedCount * 2.5 + 1)) * 100,
    );
    const clampedScore = Math.max(
      0,
      Math.min(100, rawFormulaScore - blacklistPenalty - reportPenalty),
    );

    const successRatePercent =
      totalCompletedOrReturned > 0
        ? Math.round((totalDeliveredCount / totalCompletedOrReturned) * 100)
        : 100;
    const returnRatePercent =
      totalCompletedOrReturned > 0 ? Math.max(0, 100 - successRatePercent) : 0;

    const returnRateThreshold = Number(params.highRiskReturnRateThresholdPercent ?? 30);
    const reportedThreshold = Number(params.highRiskReportedCountThreshold ?? 1);
    const depositScoreThreshold = Number(params.autoRequireDepositBelowTrustScore ?? 50);

    const lookupSource = params.lookupSource || PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE;
    const lookupSourceLabel = this.resolveLookupSourceLabel(lookupSource, params.enabledCarriers);
    const checkedAt = params.checkedAt
      ? new Date(params.checkedAt).toISOString()
      : new Date().toISOString();

    if (
      isBlacklisted ||
      clampedScore < depositScoreThreshold ||
      totalReturnedCount >= 2 ||
      reportedCount >= reportedThreshold ||
      (totalCompletedOrReturned >= 2 && returnRatePercent >= returnRateThreshold)
    ) {
      return {
        score: clampedScore,
        band: DeliveryTrustBandEnum.HIGH_RISK_RED,
        badgeVariant: 'danger',
        headline: isBlacklisted
          ? `Cảnh báo Đỏ: Danh sách đen (${reportedCount} báo cáo • Hoàn ${totalReturnedCount} đơn)`
          : `Rủi ro Bom hàng Cao (${clampedScore}/100 • Nhận ${totalDeliveredCount} / Hoàn ${totalReturnedCount} / Báo xấu ${reportedCount})`,
        recommendation:
          'Bắt buộc thu cọc qua VietQR hoặc gọi xác nhận kỹ trước khi đẩy đơn sang đơn vị vận chuyển.',
        requireDepositVietQr: params.shopRequireDepositOnHighRisk ?? true,
        isBlacklisted,
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
        sourceBreakdowns,
        providerDiagnostics,
        lookupSource,
        lookupSourceLabel,
        checkedAt,
        lastLookupAt: checkedAt,
      };
    }

    if (totalCompletedOrReturned === 0 && reportedCount === 0) {
      return {
        score: 80,
        band: DeliveryTrustBandEnum.NEW_NEUTRAL,
        badgeVariant: 'info',
        headline: 'Chưa có lịch sử giao nhận (0 nhận • 0 hoàn • 0 báo xấu)',
        recommendation:
          'Chưa có dữ liệu đối soát thực cho SĐT này — xác nhận rõ địa chỉ và khung giờ nhận trước khi gửi.',
        requireDepositVietQr: false,
        isBlacklisted: false,
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
        sourceBreakdowns,
        providerDiagnostics,
        lookupSource,
        lookupSourceLabel,
        checkedAt,
        lastLookupAt: checkedAt,
      };
    }

    if (clampedScore >= 85 && totalReturnedCount === 0 && reportedCount === 0) {
      return {
        score: clampedScore,
        band: DeliveryTrustBandEnum.TRUSTED_GREEN,
        badgeVariant: 'success',
        headline: `Uy tín Cao (${clampedScore}/100 • Nhận ${totalDeliveredCount} đơn • 0 hoàn • 0 báo xấu)`,
        recommendation:
          'Khách hàng có lịch sử nhận hàng thực tế tốt — ưu tiên duyệt và giao nhanh.',
        requireDepositVietQr: false,
        isBlacklisted: false,
        successRatePercent,
        returnRatePercent,
        totalDeliveredCount,
        shopDeliveredCount,
        networkDeliveredCount,
        totalReturnedCount,
        shopReturnedCount,
        networkReturnedCount,
        reportedCount: 0,
        verifiedReportedCount: 0,
        reportedReasons,
        sourceBreakdowns,
        providerDiagnostics,
        lookupSource,
        lookupSourceLabel,
        checkedAt,
        lastLookupAt: checkedAt,
      };
    }

    return {
      score: clampedScore,
      band: DeliveryTrustBandEnum.CAUTION_AMBER,
      badgeVariant: 'warning',
      headline: `Cần Lưu Ý (${clampedScore}/100 • Nhận ${totalDeliveredCount} / Hoàn ${totalReturnedCount} • Tỷ lệ nhận ${successRatePercent}%)`,
      recommendation: 'Nên gọi xác nhận kỹ thời gian nhận hàng và địa chỉ trước khi xuất kho.',
      requireDepositVietQr: false,
      isBlacklisted: false,
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
      sourceBreakdowns,
      providerDiagnostics,
      lookupSource,
      lookupSourceLabel,
      checkedAt,
      lastLookupAt: checkedAt,
    };
  }
}
