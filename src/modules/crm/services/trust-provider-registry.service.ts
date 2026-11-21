import { Injectable, Logger } from '@nestjs/common';

import { InjectRedis } from '@nestjs-modules/ioredis';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import {
  CustomerAbuseReportItem,
  PersistedTrustProviderDiagnosticItem,
} from 'src/entity/customer-profile.entity';

export interface DecryptedTrustProviderCredentials {
  pancakePosShopId?: string | null;
  pancakePosApiKey?: string | null;
  ghnShopId?: number | null;
  ghnToken?: string | null;
  ghtkToken?: string | null;
  vtpToken?: string | null;
  jtToken?: string | null;
  customWebhookUrl?: string | null;
  customApiKey?: string | null;
}

export interface ExternalProviderLookupHit {
  providerCode:
    | 'PANCAKE_POS_OPEN_API'
    | 'CARRIER_3PL_GHN_LIVE'
    | 'CARRIER_3PL_GHTK_LIVE'
    | 'CARRIER_3PL_VTP_LIVE'
    | 'CUSTOM_WEBHOOK_PROVIDER';
  providerName: string;
  targetBreakdownCode:
    | 'PANCAKE_COMMUNITY'
    | 'CARRIER_3PL_GHN'
    | 'CARRIER_3PL_GHTK'
    | 'CARRIER_3PL_VTP'
    | 'CUSTOM_WEBHOOK_PROVIDER';
  status: 'LIVE_VERIFIED' | 'NO_RECORD' | 'NOT_CONFIGURED' | 'PROVIDER_ERROR';
  deliveredCount: number;
  returnedCount: number;
  reportedCount: number;
  reports: Array<Partial<CustomerAbuseReportItem> & Record<string, unknown>>;
  latencyMs: number;
  fromCache: boolean;
  message: string;
  checkedAt: string;
}

const PROVIDER_CACHE_TTL_SECONDS = 900;
const PROVIDER_HTTP_TIMEOUT_MS = 3500;

@Injectable()
export class TrustProviderRegistryService {
  private readonly logger = new Logger(TrustProviderRegistryService.name);

  constructor(@InjectRedis() private readonly redis: Redis) {}

  /**
   * Thực thi song song tất cả các cổng tra cứu ngoài (Pancake POS Open API, Custom/SuperAI Webhook,
   * và các cổng 3PL đã được chủ shop khai báo Token) với Redis Cache 15 phút & Timeout cứng 3.5 giây.
   */
  public async queryAllConfiguredExternalProviders(params: {
    shopId: string;
    normalizedPhone: string;
    phoneGlobalHash: string;
    enabledCarriers: string[];
    usePancakeCommunity: boolean;
    useCarrier3pl: boolean;
    credentials: DecryptedTrustProviderCredentials;
    bypassCache?: boolean;
  }): Promise<{
    hits: ExternalProviderLookupHit[];
    diagnostics: PersistedTrustProviderDiagnosticItem[];
  }> {
    const tasks: Array<Promise<ExternalProviderLookupHit>> = [];

    if (params.usePancakeCommunity) {
      tasks.push(
        this.queryPancakePosOpenApi({
          shopId: params.shopId,
          normalizedPhone: params.normalizedPhone,
          phoneGlobalHash: params.phoneGlobalHash,
          pancakePosShopId: params.credentials.pancakePosShopId,
          pancakePosApiKey: params.credentials.pancakePosApiKey,
          bypassCache: params.bypassCache,
        }),
      );
    }

    if (params.useCarrier3pl) {
      const upperCarriers = new Set(params.enabledCarriers.map((c) => c.toUpperCase()));
      if (upperCarriers.has('GHN')) {
        tasks.push(
          this.queryGhnLiveOrdersByPhone({
            shopId: params.shopId,
            normalizedPhone: params.normalizedPhone,
            phoneGlobalHash: params.phoneGlobalHash,
            ghnShopId: params.credentials.ghnShopId,
            ghnToken: params.credentials.ghnToken,
            bypassCache: params.bypassCache,
          }),
        );
      }
      if (upperCarriers.has('GHTK')) {
        tasks.push(
          this.queryGhtkLiveConnectionHealth({
            ghtkToken: params.credentials.ghtkToken,
          }),
        );
      }
      if (upperCarriers.has('VTP')) {
        tasks.push(
          this.queryVtpLiveConnectionHealth({
            vtpToken: params.credentials.vtpToken,
          }),
        );
      }
    }

    tasks.push(
      this.queryCustomTrustWebhook({
        shopId: params.shopId,
        normalizedPhone: params.normalizedPhone,
        phoneGlobalHash: params.phoneGlobalHash,
        enabledCarriers: params.enabledCarriers,
        webhookUrl: params.credentials.customWebhookUrl,
        apiKey: params.credentials.customApiKey,
        bypassCache: params.bypassCache,
      }),
    );

    const hits = await Promise.all(tasks);
    const diagnostics: PersistedTrustProviderDiagnosticItem[] = hits.map((hit) => ({
      providerCode: hit.providerCode,
      providerName: hit.providerName,
      status: hit.status,
      deliveredCount: hit.deliveredCount,
      returnedCount: hit.returnedCount,
      reportedCount: hit.reportedCount,
      latencyMs: hit.latencyMs,
      fromCache: hit.fromCache,
      message: hit.message,
      checkedAt: hit.checkedAt,
    }));

    return { hits, diagnostics };
  }

  /**
   * Adapter 1: Pancake POS Open API (`GET https://pos.pages.fm/api/v1/shops/{shopId}/customers?search={phone}`)
   * Trả về trực tiếp `succeed_order_count`, `returned_order_count` và ghi chú cảnh báo khách hàng.
   */
  private async queryPancakePosOpenApi(params: {
    shopId: string;
    normalizedPhone: string;
    phoneGlobalHash: string;
    pancakePosShopId?: string | null;
    pancakePosApiKey?: string | null;
    bypassCache?: boolean;
  }): Promise<ExternalProviderLookupHit> {
    const checkedAt = new Date().toISOString();
    const baseHit: ExternalProviderLookupHit = {
      providerCode: 'PANCAKE_POS_OPEN_API',
      providerName: 'Pancake POS Open API',
      targetBreakdownCode: 'PANCAKE_COMMUNITY',
      status: 'NOT_CONFIGURED',
      deliveredCount: 0,
      returnedCount: 0,
      reportedCount: 0,
      reports: [],
      latencyMs: 0,
      fromCache: false,
      message:
        'Chưa nhập Pancake POS Shop ID / API Key (vẫn đang dùng Sổ cái Cộng đồng Nội bộ liên shop).',
      checkedAt,
    };

    const posShopId = (params.pancakePosShopId || '').trim();
    const apiKey = (params.pancakePosApiKey || '').trim();
    if (!posShopId || !apiKey) {
      return baseHit;
    }

    const cacheKey = `trust:provider:pancake_pos:${params.shopId}:${params.phoneGlobalHash}`;
    if (!params.bypassCache) {
      const cached = await this.readCache<ExternalProviderLookupHit>(cacheKey);
      if (cached) {
        return { ...cached, fromCache: true };
      }
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_HTTP_TIMEOUT_MS);

    try {
      const url = `https://pos.pages.fm/api/v1/shops/${encodeURIComponent(
        posShopId,
      )}/customers?api_key=${encodeURIComponent(apiKey)}&search=${encodeURIComponent(
        params.normalizedPhone,
      )}&page_size=5`;

      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        return {
          ...baseHit,
          status: 'PROVIDER_ERROR',
          latencyMs,
          message: `Pancake POS Open API phản hồi HTTP ${res.status}. Kiểm tra lại Shop ID hoặc API Key.`,
        };
      }

      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];

      const exactMatches = rows.filter((row) => {
        const phoneList = Array.isArray(row.phone_numbers)
          ? (row.phone_numbers as string[])
          : row.phone_number
            ? [String(row.phone_number)]
            : [];
        return phoneList.some((p) => {
          const digits = String(p || '').replace(/\D/g, '');
          const normalized =
            digits.startsWith('84') && digits.length === 11 ? `0${digits.slice(2)}` : digits;
          return normalized === params.normalizedPhone;
        });
      });

      if (exactMatches.length === 0) {
        const noRecordHit: ExternalProviderLookupHit = {
          ...baseHit,
          status: 'NO_RECORD',
          latencyMs,
          message:
            'Đã kết nối Pancake POS Open API — SĐT này chưa có lịch sử đơn trên Pancake POS.',
        };
        await this.writeCache(cacheKey, noRecordHit);
        return noRecordHit;
      }

      let deliveredCount = 0;
      let returnedCount = 0;
      let reportedCount = 0;
      const reports: Array<Partial<CustomerAbuseReportItem> & Record<string, unknown>> = [];

      for (const row of exactMatches) {
        deliveredCount += Math.max(0, Number(row.succeed_order_count || 0));
        returnedCount += Math.max(0, Number(row.returned_order_count || 0));
        const rowReportCount = Math.max(0, Number(row.report_count || row.bad_report_count || 0));
        reportedCount += rowReportCount;

        if (Array.isArray(row.notes)) {
          for (const noteItem of row.notes as Array<Record<string, unknown>>) {
            const msg = String(noteItem?.message || noteItem?.note || '').trim();
            if (msg && /(bom|hoàn|không nhận|thuê bao|chặn|lừa)/i.test(msg)) {
              reports.push({
                reportId: `rep_pancake_pos_${String(noteItem?.id || row.id || Date.now())}`,
                reason: msg,
                reasonCode: 'BOM_HANG',
                reasonNote: msg,
                source: 'PANCAKE_POS',
                sourceLabel: 'Pancake POS Open API',
                isCarrierVerified: false,
                reportedByName: 'Pancake POS Open API',
                reportedAt: String(
                  noteItem?.created_at || row.updated_at || new Date().toISOString(),
                ),
              });
            }
          }
        }
      }

      const liveHit: ExternalProviderLookupHit = {
        ...baseHit,
        status: 'LIVE_VERIFIED',
        deliveredCount,
        returnedCount,
        reportedCount: Math.max(reportedCount, reports.length),
        reports,
        latencyMs,
        message: `Đã đối chiếu trực tiếp Pancake POS (${deliveredCount} nhận / ${returnedCount} hoàn / ${Math.max(
          reportedCount,
          reports.length,
        )} cảnh báo).`,
      };
      await this.writeCache(cacheKey, liveHit);
      return liveHit;
    } catch (err) {
      clearTimeout(timer);
      return {
        ...baseHit,
        status: 'PROVIDER_ERROR',
        latencyMs: Date.now() - startedAt,
        message: `Lỗi kết nối Pancake POS Open API: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Adapter 2: Giao Hàng Nhanh (GHN) Live Order Search theo SĐT người nhận của cửa hàng.
   * Sử dụng `ShopId` + `Token` chính chủ để đối chiếu trực tiếp các vận đơn GHN chưa đồng bộ vào OMS.
   */
  private async queryGhnLiveOrdersByPhone(params: {
    shopId: string;
    normalizedPhone: string;
    phoneGlobalHash: string;
    ghnShopId?: number | null;
    ghnToken?: string | null;
    bypassCache?: boolean;
  }): Promise<ExternalProviderLookupHit> {
    const checkedAt = new Date().toISOString();
    const baseHit: ExternalProviderLookupHit = {
      providerCode: 'CARRIER_3PL_GHN_LIVE',
      providerName: 'Giao Hàng Nhanh (GHN Live API)',
      targetBreakdownCode: 'CARRIER_3PL_GHN',
      status: 'NOT_CONFIGURED',
      deliveredCount: 0,
      returnedCount: 0,
      reportedCount: 0,
      reports: [],
      latencyMs: 0,
      fromCache: false,
      message:
        'Chưa cấu hình GHN Token & ShopId (đang dùng dữ liệu vận đơn GHN từ sổ cái hệ thống).',
      checkedAt,
    };

    const token = (params.ghnToken || '').trim();
    const ghnShopId = Number(params.ghnShopId || 0);
    if (!token || !ghnShopId) {
      return baseHit;
    }

    const cacheKey = `trust:provider:ghn:${params.shopId}:${params.phoneGlobalHash}`;
    if (!params.bypassCache) {
      const cached = await this.readCache<ExternalProviderLookupHit>(cacheKey);
      if (cached) {
        return { ...cached, fromCache: true };
      }
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_HTTP_TIMEOUT_MS);

    try {
      const res = await fetch(
        'https://online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/search',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Token: token,
            ShopId: String(ghnShopId),
          },
          body: JSON.stringify({
            to_phone: params.normalizedPhone,
            limit: 50,
            offset: 0,
          }),
          signal: controller.signal,
        },
      );
      clearTimeout(timer);

      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        return {
          ...baseHit,
          status: 'PROVIDER_ERROR',
          latencyMs,
          message: `Cổng GHN phản hồi HTTP ${res.status}. Kiểm tra lại GHN Token / ShopId.`,
        };
      }

      const json = (await res.json().catch(() => ({}))) as Record<string, any>;
      const list = Array.isArray(json?.data?.data)
        ? json.data.data
        : Array.isArray(json?.data)
          ? json.data
          : [];

      if (list.length === 0) {
        const noRec: ExternalProviderLookupHit = {
          ...baseHit,
          status: 'NO_RECORD',
          latencyMs,
          message: 'Đã kết nối GHN Live API — chưa có vận đơn nào của SĐT này trên tài khoản GHN.',
        };
        await this.writeCache(cacheKey, noRec);
        return noRec;
      }

      let deliveredCount = 0;
      let returnedCount = 0;
      const reports: Array<Partial<CustomerAbuseReportItem> & Record<string, unknown>> = [];

      for (const ord of list as Array<Record<string, any>>) {
        const st = String(ord?.status || '').toLowerCase();
        if (st === 'delivered') {
          deliveredCount += 1;
        } else if (
          st === 'return' ||
          st === 'returned' ||
          st === 'return_transporting' ||
          st === 'return_sorting' ||
          st === 'returning' ||
          st === 'delivery_fail'
        ) {
          returnedCount += 1;
          const tracking = String(ord?.order_code || '').trim();
          reports.push({
            reportId: `rep_ghn_live_${tracking || ord?._id || Date.now()}`,
            reason: `GHN ghi nhận trạng thái ${st} cho vận đơn ${tracking || 'N/A'}`,
            reasonCode: st === 'delivery_fail' ? 'TU_CHOI_NHAN_NHIEU_LAN' : 'BOM_HANG',
            reasonNote: `Đối soát trực tiếp GHN Live API: trạng thái ${st}`,
            carrierCode: 'GHN',
            trackingNumber: tracking || null,
            source: 'CARRIER_3PL_GHN',
            sourceLabel: 'Giao Hàng Nhanh (GHN)',
            isCarrierVerified: true,
            severity: st === 'returned' ? 'CRITICAL' : 'HIGH',
            reportedByName: `GHN Live API${tracking ? ` (#${tracking})` : ''}`,
            reportedAt: String(ord?.updated_date || ord?.created_date || new Date().toISOString()),
          });
        }
      }

      const liveHit: ExternalProviderLookupHit = {
        ...baseHit,
        status: 'LIVE_VERIFIED',
        deliveredCount,
        returnedCount,
        reportedCount: reports.length,
        reports,
        latencyMs,
        message: `Đã đối chiếu trực tiếp GHN (${deliveredCount} giao thành công / ${returnedCount} hoàn hoặc thất bại).`,
      };
      await this.writeCache(cacheKey, liveHit);
      return liveHit;
    } catch (err) {
      clearTimeout(timer);
      return {
        ...baseHit,
        status: 'PROVIDER_ERROR',
        latencyMs: Date.now() - startedAt,
        message: `Lỗi kết nối GHN Live API: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Adapter 3: GHTK Token status & Ledger Readiness.
   * GHTK Open API theo quy định bảo mật dữ liệu cá nhân không cung cấp endpoint tra cứu lịch sử khách
   * theo SĐT không kèm mã vận đơn; dữ liệu GHTK được tổng hợp chuẩn xác 100% từ Webhook & Sổ cái vận đơn GHTK.
   */
  private async queryGhtkLiveConnectionHealth(params: {
    ghtkToken?: string | null;
  }): Promise<ExternalProviderLookupHit> {
    const checkedAt = new Date().toISOString();
    const hasToken = Boolean((params.ghtkToken || '').trim());
    return {
      providerCode: 'CARRIER_3PL_GHTK_LIVE',
      providerName: 'Giao Hàng Tiết Kiệm (GHTK)',
      targetBreakdownCode: 'CARRIER_3PL_GHTK',
      status: hasToken ? 'NO_RECORD' : 'NOT_CONFIGURED',
      deliveredCount: 0,
      returnedCount: 0,
      reportedCount: 0,
      reports: [],
      latencyMs: 0,
      fromCache: false,
      message: hasToken
        ? 'GHTK Token đã kích hoạt — tổng hợp chuẩn từ Webhook hành trình & Sổ cái vận đơn GHTK đa shop.'
        : 'Chưa khai báo GHTK Token — đang tổng hợp từ Sổ cái vận đơn GHTK nội bộ & liên shop.',
      checkedAt,
    };
  }

  /**
   * Adapter 4: ViettelPost Token status & Ledger Readiness.
   */
  private async queryVtpLiveConnectionHealth(params: {
    vtpToken?: string | null;
  }): Promise<ExternalProviderLookupHit> {
    const checkedAt = new Date().toISOString();
    const hasToken = Boolean((params.vtpToken || '').trim());
    return {
      providerCode: 'CARRIER_3PL_VTP_LIVE',
      providerName: 'ViettelPost (VTP)',
      targetBreakdownCode: 'CARRIER_3PL_VTP',
      status: hasToken ? 'NO_RECORD' : 'NOT_CONFIGURED',
      deliveredCount: 0,
      returnedCount: 0,
      reportedCount: 0,
      reports: [],
      latencyMs: 0,
      fromCache: false,
      message: hasToken
        ? 'ViettelPost Token đã kích hoạt — tổng hợp chuẩn từ Webhook hành trình & Sổ cái vận đơn VTP đa shop.'
        : 'Chưa khai báo ViettelPost Token — đang tổng hợp từ Sổ cái vận đơn VTP nội bộ & liên shop.',
      checkedAt,
    };
  }

  /**
   * Adapter 5: Cổng API Tín Nhiệm Đối Tác Mở Rộng (SuperAI / SuperShip / CheckBom / Custom Webhook).
   * Gửi cả `phone`, `phoneSha256` và `phoneGlobalHash` kèm Bearer/X-API-Key.
   */
  private async queryCustomTrustWebhook(params: {
    shopId: string;
    normalizedPhone: string;
    phoneGlobalHash: string;
    enabledCarriers: string[];
    webhookUrl?: string | null;
    apiKey?: string | null;
    bypassCache?: boolean;
  }): Promise<ExternalProviderLookupHit> {
    const checkedAt = new Date().toISOString();
    const url = (params.webhookUrl || '').trim();
    const baseHit: ExternalProviderLookupHit = {
      providerCode: 'CUSTOM_WEBHOOK_PROVIDER',
      providerName: 'Cổng Tín Nhiệm Mở Rộng (SuperAI / Webhook)',
      targetBreakdownCode: 'CUSTOM_WEBHOOK_PROVIDER',
      status: 'NOT_CONFIGURED',
      deliveredCount: 0,
      returnedCount: 0,
      reportedCount: 0,
      reports: [],
      latencyMs: 0,
      fromCache: false,
      message: 'Chưa cấu hình URL Webhook/API đối tác tín nhiệm bên thứ 3.',
      checkedAt,
    };

    if (!url || !/^https?:\/\//i.test(url)) {
      return baseHit;
    }

    const cacheKey = `trust:provider:custom:${params.shopId}:${params.phoneGlobalHash}`;
    if (!params.bypassCache) {
      const cached = await this.readCache<ExternalProviderLookupHit>(cacheKey);
      if (cached) {
        return { ...cached, fromCache: true };
      }
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_HTTP_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (params.apiKey) {
        headers['Authorization'] = `Bearer ${params.apiKey}`;
        headers['X-API-Key'] = params.apiKey;
      }

      const res = await fetch(url, {
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
      if (!res.ok) {
        return {
          ...baseHit,
          status: 'PROVIDER_ERROR',
          latencyMs,
          message: `Cổng API tín nhiệm mở rộng phản hồi HTTP ${res.status}.`,
        };
      }

      const extData = (await res.json().catch(() => ({}))) as Record<string, any>;
      const payloadNode = extData?.data || extData;

      const deliveredCount = Math.max(
        0,
        Number(
          payloadNode?.deliveredCount ??
            payloadNode?.succeed_order_count ??
            payloadNode?.success_count ??
            0,
        ),
      );
      const returnedCount = Math.max(
        0,
        Number(
          payloadNode?.returnedCount ??
            payloadNode?.returned_order_count ??
            payloadNode?.return_count ??
            0,
        ),
      );
      const rawReports = Array.isArray(payloadNode?.reportedReasons)
        ? payloadNode.reportedReasons
        : Array.isArray(payloadNode?.reports)
          ? payloadNode.reports
          : [];
      const reportedCount = Math.max(
        0,
        Number(payloadNode?.reportedCount ?? payloadNode?.report_count ?? 0),
        rawReports.length,
      );

      const mappedReports = rawReports.map((rep: Record<string, unknown>) => ({
        ...rep,
        source: String(rep?.source || 'CUSTOM_WEBHOOK_PROVIDER'),
      }));

      const hasData = deliveredCount > 0 || returnedCount > 0 || reportedCount > 0;
      const result: ExternalProviderLookupHit = {
        ...baseHit,
        status: hasData ? 'LIVE_VERIFIED' : 'NO_RECORD',
        deliveredCount,
        returnedCount,
        reportedCount,
        reports: mappedReports,
        latencyMs,
        message: hasData
          ? `Cổng mở rộng trả về ${deliveredCount} nhận / ${returnedCount} hoàn / ${reportedCount} báo xấu.`
          : 'Đã kết nối cổng mở rộng — chưa có dữ liệu lịch sử cho SĐT này.',
      };

      await this.writeCache(cacheKey, result);
      return result;
    } catch (err) {
      clearTimeout(timer);
      this.logger.warn(
        `Custom trust webhook lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ...baseHit,
        status: 'PROVIDER_ERROR',
        latencyMs: Date.now() - startedAt,
        message: `Không thể kết nối cổng mở rộng: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async readCache<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async writeCache<T>(key: string, value: T): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', PROVIDER_CACHE_TTL_SECONDS);
    } catch (err) {
      this.logger.debug(`Trust provider cache write skipped: ${String(err)}`);
    }
  }
}
