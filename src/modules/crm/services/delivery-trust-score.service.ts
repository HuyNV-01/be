import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import * as crypto from 'crypto';
import {
  DeliveryTrustBandEnum,
  PhoneTrustLookupSourceEnum,
  PosOrderStatusEnum,
} from 'src/common/enum';
import { CustomerAbuseReportItem, CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { PosOrderEntity } from 'src/entity/pos-order.entity';
import { CrmTrustAndIndustryConfig } from 'src/entity/shop-workspace.entity';
import { Repository } from 'typeorm';

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
  lookupSource: string;
  lookupSourceLabel: string;
  checkedAt: string;
}

export interface ExternalPhoneReputationLookupResult {
  networkDeliveredCount: number;
  networkReturnedCount: number;
  reportedCount: number;
  reportedReasons: CustomerAbuseReportItem[];
  lookupSource: string;
  lookupSourceLabel: string;
}

@Injectable()
export class DeliveryTrustScoreService {
  constructor(
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(PosOrderEntity)
    private readonly posOrderRepo: Repository<PosOrderEntity>,
  ) {}

  public resolveLookupSourceLabel(source?: string | null, carriers?: string[]): string {
    const carrierStr = carriers && carriers.length > 0 ? carriers.join('/') : 'GHN/GHTK/VTP/J&T';
    switch (source) {
      case PhoneTrustLookupSourceEnum.INTERNAL_SHOP_POS:
        return 'Lịch sử Đơn hàng Nội bộ Cửa hàng';
      case PhoneTrustLookupSourceEnum.PANCAKE_COMMUNITY_NETWORK:
        return 'Liên minh Cộng đồng Nhà bán hàng';
      case PhoneTrustLookupSourceEnum.CARRIER_3PL_GHN_GHTK:
        return `Đối soát ĐVVC 3PL (${carrierStr})`;
      case PhoneTrustLookupSourceEnum.CUSTOM_EXTERNAL_WEBHOOK:
        return 'API Nguồn Dữ Liệu Tín Nhiệm Mở Rộng';
      default:
        return `POS Nội bộ + Cộng đồng Shop + ĐVVC (${carrierStr})`;
    }
  }

  public resolveReportSourceBadgeLabel(
    source?: string | null,
    carrierCode?: string | null,
  ): string {
    if (carrierCode) {
      return `Đối soát ĐVVC ${carrierCode}`;
    }
    switch (source) {
      case 'SHOP_INTERNAL':
        return 'Báo cáo Nội bộ Cửa hàng';
      case 'PANCAKE_COMMUNITY':
        return 'Cộng đồng Nhà bán hàng';
      case 'CARRIER_3PL_GHN':
        return 'Đối soát Giao Hàng Nhanh (GHN)';
      case 'CARRIER_3PL_GHTK':
        return 'Đối soát Giao Hàng Tiết Kiệm (GHTK)';
      case 'CARRIER_3PL_VTP':
        return 'Đối soát ViettelPost (VTP)';
      case 'CARRIER_3PL_JT':
        return 'Đối soát J&T Express';
      case 'CUSTOM_WEBHOOK_PROVIDER':
        return 'API Đối tác Tín nhiệm';
      default:
        return source || 'Hệ thống Cảnh báo';
    }
  }

  /**
   * Chuẩn hóa, khử trùng theo `reportId` và sắp xếp danh sách Báo cáo Xấu theo thứ tự Thời gian từ Mới nhất đến Cũ nhất (`DESC`)
   */
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

      const normalizedItem: CustomerAbuseReportItem = {
        reportId,
        reason: reasonText,
        reasonCode: item.reasonCode ? String(item.reasonCode) : 'BOM_HANG',
        reasonNote: reasonText,
        carrierCode,
        orderCode,
        trackingNumber,
        source: sourceCode,
        sourceLabel:
          item.sourceLabel || this.resolveReportSourceBadgeLabel(sourceCode, carrierCode),
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

  /**
   * Tra cứu mở rộng đa nguồn chỉ số Nhận hàng, Hoàn hàng và Danh sách Báo cáo Xấu (`reportedReasons` sắp xếp Mới nhất -> Cũ nhất):
   * 1. Nguồn 1 (`CUSTOM_EXTERNAL_WEBHOOK`): Kết nối API / Webhook nguồn tín nhiệm mở rộng của đối tác hoặc cổng tổng hợp 3PL (GHN/GHTK/VTP/J&T) nếu Shop cấu hình `customLookupWebhookUrl`.
   * 2. Nguồn 2 (`PANCAKE_COMMUNITY_NETWORK`): Truy vấn liên minh dữ liệu ẩn danh qua Chỉ mục mù `phoneSearchHash` (`HMAC-SHA256`) và `phoneMasked` trên bảng `customer_profiles` mà không giải mã SĐT gốc.
   * 3. Nguồn 3 (`CARRIER_3PL_GHN_GHTK` & `pos_orders`): Tổng hợp trực tiếp từ Sổ cái Đơn hàng `pos_orders` (đơn giao thành công `DELIVERED` / `DELIVERED_RECONCILED` và đơn hoàn/giao thất bại `RETURNED_RESTOCKED` / `RETURNING` / `DELIVERY_FAILED_RESCUE` kèm trích xuất biên bản hoàn hàng từ bưu tá 3PL).
   */
  public async lookupPhoneReputationFromSources(params: {
    rawPhone: string;
    phoneSearchHash?: string | null;
    excludeShopId?: string | null;
    config?: Partial<CrmTrustAndIndustryConfig> | null;
    decryptedCustomApiKey?: string | null;
  }): Promise<ExternalPhoneReputationLookupResult> {
    const cleanPhone = (params.rawPhone || '').replace(/\D/g, '');
    const normalizedPhone =
      cleanPhone.startsWith('84') && cleanPhone.length === 11
        ? `0${cleanPhone.slice(2)}`
        : cleanPhone;

    const cfg = params.config || {};
    const useCommunity = cfg.usePancakeCommunityNetwork !== false;
    const useCarrier3pl = cfg.useCarrier3plLookup !== false;
    const enabledCarriers = cfg.enabledCarriers || ['GHN', 'GHTK', 'VTP', 'JT'];

    let networkDeliveredCount = 0;
    let networkReturnedCount = 0;
    let reportedCount = 0;
    const collectedReports: Array<Partial<CustomerAbuseReportItem> & Record<string, any>> = [];
    let resolvedViaCustomWebhook = false;

    // 1. Truy vấn Nguồn API / Webhook Tín Nhiệm Mở Rộng (nếu cửa hàng cấu hình URL)
    if (
      normalizedPhone &&
      cfg.customLookupWebhookUrl &&
      /^https?:\/\//i.test(cfg.customLookupWebhookUrl.trim())
    ) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (params.decryptedCustomApiKey) {
          headers['Authorization'] = `Bearer ${params.decryptedCustomApiKey}`;
          headers['X-API-Key'] = params.decryptedCustomApiKey;
        }

        const res = await fetch(cfg.customLookupWebhookUrl.trim(), {
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
            networkDeliveredCount += Math.max(0, Number(payloadNode.deliveredCount || 0));
            networkReturnedCount += Math.max(0, Number(payloadNode.returnedCount || 0));
            reportedCount += Math.max(0, Number(payloadNode.reportedCount || 0));

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
      } catch {
        clearTimeout(timeoutId);
      }
    }

    // 2. Truy vấn Liên minh Cộng đồng (`customer_profiles`) & Đối soát Sổ cái Vận đơn 3PL (`pos_orders`)
    if ((useCommunity || useCarrier3pl) && normalizedPhone && normalizedPhone.length >= 9) {
      const maskedPhone = `${normalizedPhone.slice(0, 3)}***${normalizedPhone.slice(-3)}`;
      try {
        if (useCommunity) {
          const qb = this.customerRepo
            .createQueryBuilder('cp')
            .where('cp.phone_masked = :maskedPhone', { maskedPhone });

          if (params.phoneSearchHash) {
            qb.orWhere('cp.phone_search_hash = :phoneSearchHash', {
              phoneSearchHash: params.phoneSearchHash,
            });
          }

          const matchedProfiles = await qb.take(30).getMany();
          for (const prof of matchedProfiles) {
            const isOtherShop = Boolean(
              params.excludeShopId && prof.shopId !== params.excludeShopId,
            );
            if (isOtherShop) {
              networkDeliveredCount += Math.max(0, Number(prof.successfulDeliveriesCount || 0));
              networkReturnedCount += Math.max(0, Number(prof.returnedOrdersCount || 0));
              reportedCount += Math.max(0, Number(prof.reportedCount || 0));
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
        }

        if (useCarrier3pl) {
          const matchedOrders = await this.posOrderRepo.find({
            where: { customerPhoneMasked: maskedPhone },
            order: { createdAt: 'DESC' },
            take: 50,
          });

          let dbDeliveredOrders = 0;
          let dbReturnedOrders = 0;

          for (const ord of matchedOrders) {
            const isOtherShopOrder = Boolean(
              params.excludeShopId && ord.shopId !== params.excludeShopId,
            );
            if (
              ord.status === PosOrderStatusEnum.DELIVERED ||
              ord.status === PosOrderStatusEnum.DELIVERED_RECONCILED
            ) {
              if (isOtherShopOrder) {
                dbDeliveredOrders += 1;
              }
            } else if (
              ord.status === PosOrderStatusEnum.RETURNED_RESTOCKED ||
              ord.status === PosOrderStatusEnum.RETURNING ||
              ord.status === PosOrderStatusEnum.DELIVERY_FAILED_RESCUE
            ) {
              if (isOtherShopOrder) {
                dbReturnedOrders += 1;
              }
              if (ord.note && ord.note.trim()) {
                const carrierUpper = (ord.carrierCode || 'GHN').toUpperCase();
                collectedReports.push({
                  reportId: `rep_3pl_ord_${ord.id}`,
                  reason: ord.note.trim(),
                  reasonCode:
                    ord.status === PosOrderStatusEnum.DELIVERY_FAILED_RESCUE
                      ? 'TU_CHOI_NHAN_NHIEU_LAN'
                      : 'BOM_HANG',
                  reasonNote: ord.note.trim(),
                  carrierCode: carrierUpper,
                  orderCode: ord.orderCode,
                  trackingNumber: ord.trackingNumber || null,
                  source: `CARRIER_3PL_${carrierUpper}`,
                  reportedByName: `Đối soát Vận đơn ${carrierUpper}${ord.trackingNumber ? ` (#${ord.trackingNumber})` : ''}`,
                  reportedAt: new Date(ord.updatedAt || ord.createdAt).toISOString(),
                });
              }
            }
          }

          networkDeliveredCount = Math.max(networkDeliveredCount, dbDeliveredOrders);
          networkReturnedCount = Math.max(networkReturnedCount, dbReturnedOrders);
        }
      } catch {
        // Nếu bảng chưa có dữ liệu thì giữ nguyên giá trị 0
      }
    }

    const sortedReasons = this.sortAndNormalizeAbuseReportsNewestFirst(collectedReports);
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
      lookupSource: sourceEnum,
      lookupSourceLabel: this.resolveLookupSourceLabel(sourceEnum, enabledCarriers),
    };
  }

  /**
   * Tính điểm Uy tín Nhận hàng (0 - 100 điểm), phân loại 4 mức cảnh báo Bom hàng (F04.3)
   * và luôn trả về danh sách `reportedReasons` đã được sắp xếp theo thứ tự Thời gian từ Mới nhất đến Cũ nhất.
   */
  public evaluateCustomerTrustScore(params: {
    successfulDeliveriesCount: number;
    returnedOrdersCount: number;
    networkDeliveredCount?: number;
    networkReturnedCount?: number;
    reportedCount?: number;
    reportedReasons?: CustomerAbuseReportItem[] | null;
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
    const reportPenalty = Math.min(45, reportedCount * 15);

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

    const returnRateThreshold = Number(params.highRiskReturnRateThresholdPercent || 30);
    const reportedThreshold = Number(params.highRiskReportedCountThreshold || 1);

    const lookupSource = params.lookupSource || PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE;
    const lookupSourceLabel = this.resolveLookupSourceLabel(lookupSource, params.enabledCarriers);
    const checkedAt = params.checkedAt
      ? new Date(params.checkedAt).toISOString()
      : new Date().toISOString();

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
          ? `Cảnh báo Đỏ: Khách nằm trong Danh sách đen (${reportedCount} báo cáo • Hoàn ${totalReturnedCount} đơn)`
          : `Rủi ro Bom hàng Cao (${clampedScore}/100 điểm • Nhận ${totalDeliveredCount} / Hoàn ${totalReturnedCount} / Báo xấu ${reportedCount})`,
        recommendation:
          'Bắt buộc thu cọc trước qua VietQR hoặc gọi xác nhận kỹ trước khi đẩy đơn sang hãng vận chuyển.',
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
        headline: 'Khách hàng mới (Chưa có lịch sử hoàn đơn hay báo cáo xấu)',
        recommendation: 'Khách lần đầu mua hàng — xác nhận rõ địa chỉ 3 cấp và SĐT trước khi gửi.',
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
        headline: `Uy tín Cao (${clampedScore}/100 điểm • Nhận ${totalDeliveredCount} đơn • 0 hoàn • 0 báo xấu)`,
        recommendation: 'Khách hàng uy tín cao — ưu tiên duyệt đơn và đóng gói gửi nhanh.',
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
        lookupSource,
        lookupSourceLabel,
        checkedAt,
      };
    }

    return {
      score: clampedScore,
      band: DeliveryTrustBandEnum.CAUTION_AMBER,
      badgeVariant: 'warning',
      headline: `Cần Lưu Ý (${clampedScore}/100 điểm • Nhận ${totalDeliveredCount} / Hoàn ${totalReturnedCount} • Tỷ lệ nhận ${successRatePercent}%)`,
      recommendation: 'Nên gọi xác nhận kỹ khung giờ nhận hàng và địa chỉ trước khi xuất kho.',
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
      lookupSource,
      lookupSourceLabel,
      checkedAt,
    };
  }
}
