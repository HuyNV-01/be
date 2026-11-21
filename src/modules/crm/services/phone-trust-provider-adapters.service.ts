import { Injectable, Logger } from '@nestjs/common';

import { InjectRedis } from '@nestjs-modules/ioredis';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import * as net from 'net';
import {
  DeliverySourceCodeEnum,
  PhoneTrustVerificationLevelEnum,
  TrustProviderStatusEnum,
} from 'src/common/enum';
import { envs } from 'src/config/envs/envs';
import { CustomerAbuseReportItem } from 'src/entity/customer-profile.entity';

import { PiiVaultAndAuditService } from './pii-vault-and-audit.service';

export interface ExternalProviderLookupOutput {
  providerCode: string;
  providerName: string;
  sourceCode: DeliverySourceCodeEnum;
  shortLabel: string;
  status: TrustProviderStatusEnum;
  deliveredCount: number;
  returnedCount: number;
  reportedCount: number;
  reportedReasons: CustomerAbuseReportItem[];
  confidenceWeight: number;
  latencyMs: number;
  fromCache: boolean;
  message: string;
  checkedAt: string;
}

export interface TrackingVerificationResult {
  verified: boolean;
  carrierCode: string;
  trackingNumber: string;
  rawStatus: string | null;
  outcome: 'DELIVERED' | 'RETURNED' | 'DELIVERY_FAILED' | 'IN_TRANSIT' | 'UNKNOWN';
  reasonNote: string | null;
}

/**
 * Executes real outbound integrations against external partner gateways, POS platforms,
 * and Vietnamese 3PL APIs. Every call is bounded by AbortController timeouts and protected
 * by Redis circuit breakers to preserve sub-second SLA on live chat flows.
 */
@Injectable()
export class PhoneTrustProviderAdaptersService {
  private readonly logger = new Logger(PhoneTrustProviderAdaptersService.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly piiVaultService: PiiVaultAndAuditService,
  ) {}

  public computeRawSha256(rawPhone: string): string {
    const normalized = this.piiVaultService.normalizeLocalVietnamesePhone(rawPhone);
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * Blocks private, loopback, and link-local destinations so sellers cannot abuse
   * custom lookup webhooks to probe internal cloud metadata or LAN services.
   */
  public assertSafeExternalWebhookUrl(rawUrl: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      throw new Error('INVALID_EXTERNAL_WEBHOOK_URL');
    }

    if (parsed.protocol !== 'https:' && (envs.isProduction || parsed.protocol !== 'http:')) {
      throw new Error('EXTERNAL_WEBHOOK_MUST_USE_HTTPS');
    }

    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname === 'metadata.google.internal'
    ) {
      throw new Error('EXTERNAL_WEBHOOK_PRIVATE_HOST_BLOCKED');
    }

    if (net.isIP(hostname) && this.isPrivateIpAddress(hostname)) {
      throw new Error('EXTERNAL_WEBHOOK_PRIVATE_IP_BLOCKED');
    }

    return parsed;
  }

  private isPrivateIpAddress(ip: string): boolean {
    if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) {
      return true;
    }
    const octets = ip.split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) {
      return true;
    }
    const [a, b] = octets;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  public async isCircuitOpen(providerKey: string): Promise<boolean> {
    try {
      return (await this.redis.get(`trust:cb:open:${providerKey}`)) === '1';
    } catch {
      return false;
    }
  }

  public async recordProviderSuccess(providerKey: string): Promise<void> {
    try {
      await this.redis.del(`trust:cb:fail:${providerKey}`, `trust:cb:open:${providerKey}`);
    } catch {
      // Cache failure must not interrupt trust lookup pipeline.
    }
  }

  public async recordProviderFailure(providerKey: string): Promise<void> {
    try {
      const failKey = `trust:cb:fail:${providerKey}`;
      const failures = await this.redis.incr(failKey);
      if (failures === 1) {
        await this.redis.expire(failKey, envs.phoneTrust.circuitBreakerCooldownSeconds * 2);
      }
      if (failures >= envs.phoneTrust.circuitBreakerFailureThreshold) {
        await this.redis.set(
          `trust:cb:open:${providerKey}`,
          '1',
          'EX',
          envs.phoneTrust.circuitBreakerCooldownSeconds,
        );
        this.logger.warn(
          `Circuit breaker opened for trust provider "${providerKey}" after ${failures} failures`,
        );
      }
    } catch {
      // Cache failure must not interrupt trust lookup pipeline.
    }
  }

  /**
   * Queries the platform-level Partner / Aggregator Gateway configured via
   * PLATFORM_TRUST_COMMUNITY_GATEWAY_URL (e.g., GHN/GHTK/VTP Partner contract,
   * SuperShip, Nhanh.vn, or Pancake POS aggregator).
   */
  public async queryPlatformCommunityGateway(params: {
    normalizedPhone: string;
    globalPhoneHash: string;
    shopId: string;
  }): Promise<ExternalProviderLookupOutput> {
    const providerCode = 'PLATFORM_COMMUNITY_GATEWAY';
    const providerName = envs.phoneTrust.communityGatewayProviderName;
    const checkedAt = new Date().toISOString();
    const gatewayUrl = envs.phoneTrust.communityGatewayUrl;

    if (!gatewayUrl) {
      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.PANCAKE_COMMUNITY,
        shortLabel: providerName,
        status: TrustProviderStatusEnum.NOT_CONFIGURED,
        deliveredCount: 0,
        returnedCount: 0,
        reportedCount: 0,
        reportedReasons: [],
        confidenceWeight: 0,
        latencyMs: 0,
        fromCache: false,
        message:
          'Chưa cấu hình PLATFORM_TRUST_COMMUNITY_GATEWAY_URL ở tầng hạ tầng (.env). Đang dùng sổ cái nội bộ & mạng lưới liên shop.',
        checkedAt,
      };
    }

    if (await this.isCircuitOpen(providerCode)) {
      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.PANCAKE_COMMUNITY,
        shortLabel: providerName,
        status: TrustProviderStatusEnum.PROVIDER_ERROR,
        deliveredCount: 0,
        returnedCount: 0,
        reportedCount: 0,
        reportedReasons: [],
        confidenceWeight: 0,
        latencyMs: 0,
        fromCache: false,
        message:
          'Cổng đối tác tạm ngắt mạch bảo vệ (Circuit Breaker) do lỗi liên tiếp từ upstream.',
        checkedAt,
      };
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      envs.phoneTrust.communityGatewayTimeoutMs,
    );

    try {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const phoneSha256 = this.computeRawSha256(params.normalizedPhone);
      const payloadObj: Record<string, unknown> = {
        phoneSha256,
        globalPhoneHash: params.globalPhoneHash,
        tenantShopId: params.shopId,
        requestedAt: checkedAt,
      };
      if (envs.phoneTrust.communityGatewaySendRawPhone) {
        payloadObj.phone = params.normalizedPhone;
      }
      const rawBody = JSON.stringify(payloadObj);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Request-Timestamp': timestamp,
      };
      if (envs.phoneTrust.communityGatewayApiKey) {
        headers['Authorization'] = `Bearer ${envs.phoneTrust.communityGatewayApiKey}`;
        headers['X-API-Key'] = envs.phoneTrust.communityGatewayApiKey;
      }
      if (envs.phoneTrust.communityGatewaySigningSecret) {
        headers['X-Platform-Signature'] = crypto
          .createHmac('sha256', envs.phoneTrust.communityGatewaySigningSecret)
          .update(`${timestamp}.${rawBody}`)
          .digest('hex');
      }

      const response = await fetch(gatewayUrl, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        await this.recordProviderFailure(providerCode);
        return {
          providerCode,
          providerName,
          sourceCode: DeliverySourceCodeEnum.PANCAKE_COMMUNITY,
          shortLabel: providerName,
          status: TrustProviderStatusEnum.PROVIDER_ERROR,
          deliveredCount: 0,
          returnedCount: 0,
          reportedCount: 0,
          reportedReasons: [],
          confidenceWeight: 0,
          latencyMs,
          fromCache: false,
          message: `Cổng đối tác trả về HTTP ${response.status}.`,
          checkedAt,
        };
      }

      const body = (await response.json()) as Record<string, any>;
      const dataNode = (body?.data && typeof body.data === 'object' ? body.data : body) as Record<
        string,
        any
      >;

      const deliveredCount = Math.max(
        0,
        Number(
          dataNode.deliveredCount ??
            dataNode.succeedOrderCount ??
            dataNode.success_count ??
            dataNode.delivered ??
            0,
        ),
      );
      const returnedCount = Math.max(
        0,
        Number(
          dataNode.returnedCount ??
            dataNode.returnOrderCount ??
            dataNode.return_count ??
            dataNode.returned ??
            0,
        ),
      );
      const reportedCount = Math.max(
        0,
        Number(
          dataNode.reportedCount ??
            dataNode.badReportCount ??
            dataNode.report_count ??
            dataNode.blacklist_count ??
            0,
        ),
      );

      const rawReasons = Array.isArray(dataNode.reportedReasons)
        ? dataNode.reportedReasons
        : Array.isArray(dataNode.reports)
          ? dataNode.reports
          : [];

      const reportedReasons: CustomerAbuseReportItem[] = rawReasons
        .slice(0, 10)
        .map((item: Record<string, any>, idx: number) => ({
          reportId: String(item.reportId || item.id || `gw_${phoneSha256.slice(0, 8)}_${idx}`),
          reason: String(item.reason || item.reasonNote || item.note || 'Cảnh báo từ cổng đối tác'),
          reasonCode: item.reasonCode ? String(item.reasonCode) : 'BOM_HANG',
          reasonNote: String(item.reasonNote || item.reason || item.note || ''),
          carrierCode: item.carrierCode ? String(item.carrierCode) : null,
          orderCode: item.orderCode ? String(item.orderCode) : null,
          source: 'PANCAKE_COMMUNITY',
          reportedByName: String(item.reportedByName || providerName),
          reportedAt: String(item.reportedAt || item.createdAt || checkedAt),
        }));

      await this.recordProviderSuccess(providerCode);
      const hasAnyRecord = deliveredCount > 0 || returnedCount > 0 || reportedCount > 0;

      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.PANCAKE_COMMUNITY,
        shortLabel: providerName,
        status: hasAnyRecord
          ? TrustProviderStatusEnum.LIVE_VERIFIED
          : TrustProviderStatusEnum.NO_RECORD,
        deliveredCount,
        returnedCount,
        reportedCount,
        reportedReasons,
        confidenceWeight: hasAnyRecord ? 1.0 : 0,
        latencyMs,
        fromCache: false,
        message: hasAnyRecord
          ? `Đã đối soát thực từ ${providerName}: Nhận ${deliveredCount} • Hoàn ${returnedCount} • Báo xấu ${reportedCount}.`
          : `Không tìm thấy lịch sử giao nhận tại ${providerName}.`,
        checkedAt,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      await this.recordProviderFailure(providerCode);
      const isAbort = error instanceof Error && error.name === 'AbortError';
      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.PANCAKE_COMMUNITY,
        shortLabel: providerName,
        status: TrustProviderStatusEnum.PROVIDER_ERROR,
        deliveredCount: 0,
        returnedCount: 0,
        reportedCount: 0,
        reportedReasons: [],
        confidenceWeight: 0,
        latencyMs: Date.now() - startedAt,
        fromCache: false,
        message: isAbort
          ? `Quá thời gian phản hồi (${envs.phoneTrust.communityGatewayTimeoutMs}ms) khi gọi ${providerName}.`
          : `Lỗi kết nối ${providerName}: ${error instanceof Error ? error.message : 'UNKNOWN'}`,
        checkedAt,
      };
    }
  }

  /**
   * Queries Pancake POS Open API v1 (https://pos.pages.fm/api/v1/shops/{SHOP_ID}/customers)
   * using the seller's decrypted shop API key to fetch real order_count, succeed_order_count,
   * block status, and risk tags.
   */
  public async queryPancakePosLiveApi(params: {
    normalizedPhone: string;
    pancakePosShopId?: string | null;
    decryptedApiKey?: string | null;
  }): Promise<ExternalProviderLookupOutput> {
    const providerCode = 'PANCAKE_POS_OPEN_API';
    const providerName = 'Pancake POS Open API';
    const checkedAt = new Date().toISOString();

    if (!params.pancakePosShopId || !params.decryptedApiKey) {
      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.PANCAKE_COMMUNITY,
        shortLabel: 'Pancake POS',
        status: TrustProviderStatusEnum.NOT_CONFIGURED,
        deliveredCount: 0,
        returnedCount: 0,
        reportedCount: 0,
        reportedReasons: [],
        confidenceWeight: 0,
        latencyMs: 0,
        fromCache: false,
        message: 'Shop chưa khai báo Pancake POS Shop ID & API Key.',
        checkedAt,
      };
    }

    const cbKey = `${providerCode}:${params.pancakePosShopId}`;
    if (await this.isCircuitOpen(cbKey)) {
      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.PANCAKE_COMMUNITY,
        shortLabel: 'Pancake POS',
        status: TrustProviderStatusEnum.PROVIDER_ERROR,
        deliveredCount: 0,
        returnedCount: 0,
        reportedCount: 0,
        reportedReasons: [],
        confidenceWeight: 0,
        latencyMs: 0,
        fromCache: false,
        message: 'Pancake POS API đang tạm ngắt mạch bảo vệ.',
        checkedAt,
      };
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      const encodedShopId = encodeURIComponent(params.pancakePosShopId.trim());
      const query = new URLSearchParams({
        api_key: params.decryptedApiKey.trim(),
        search: params.normalizedPhone,
        page_size: '5',
        page_number: '1',
      });
      const url = `https://pos.pages.fm/api/v1/shops/${encodedShopId}/customers?${query.toString()}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        await this.recordProviderFailure(cbKey);
        return {
          providerCode,
          providerName,
          sourceCode: DeliverySourceCodeEnum.PANCAKE_COMMUNITY,
          shortLabel: 'Pancake POS',
          status: TrustProviderStatusEnum.PROVIDER_ERROR,
          deliveredCount: 0,
          returnedCount: 0,
          reportedCount: 0,
          reportedReasons: [],
          confidenceWeight: 0,
          latencyMs,
          fromCache: false,
          message: `Pancake POS trả về HTTP ${response.status}.`,
          checkedAt,
        };
      }

      const json = (await response.json()) as {
        success?: boolean;
        data?: Array<{
          id?: string;
          name?: string;
          phone_numbers?: string[];
          order_count?: number;
          succeed_order_count?: number;
          is_block?: boolean;
          tags?: string[];
          notes?: Array<{ id?: string; message?: string; created_at?: number }>;
        }>;
      };

      await this.recordProviderSuccess(cbKey);

      const matched = (json.data || []).find((item) =>
        (item.phone_numbers || []).some(
          (p) => this.piiVaultService.normalizeLocalVietnamesePhone(p) === params.normalizedPhone,
        ),
      );

      if (!matched) {
        return {
          providerCode,
          providerName,
          sourceCode: DeliverySourceCodeEnum.PANCAKE_COMMUNITY,
          shortLabel: 'Pancake POS',
          status: TrustProviderStatusEnum.NO_RECORD,
          deliveredCount: 0,
          returnedCount: 0,
          reportedCount: 0,
          reportedReasons: [],
          confidenceWeight: 0,
          latencyMs,
          fromCache: false,
          message: 'SĐT chưa từng phát sinh hồ sơ trên Pancake POS của shop.',
          checkedAt,
        };
      }

      const totalOrders = Math.max(0, Number(matched.order_count || 0));
      const deliveredCount = Math.max(0, Number(matched.succeed_order_count || 0));
      const returnedCount = Math.max(0, totalOrders - deliveredCount);
      const riskTags = (matched.tags || []).filter((tag) =>
        /ho[àa]n|bom|boom|ch[ặa]n|blacklist|l[ừu]a/i.test(tag),
      );
      const reportedCount = (matched.is_block ? 1 : 0) + (riskTags.length > 0 ? 1 : 0);
      const reportedReasons: CustomerAbuseReportItem[] = [];

      if (matched.is_block || riskTags.length > 0) {
        reportedReasons.push({
          reportId: `ppos_${matched.id || Date.now()}`,
          reason: matched.is_block
            ? `Khách bị chặn trên Pancake POS${riskTags.length ? ` (Nhãn: ${riskTags.join(', ')})` : ''}`
            : `Gắn nhãn rủi ro trên Pancake POS: ${riskTags.join(', ')}`,
          reasonCode: 'BOM_HANG',
          source: 'PANCAKE_COMMUNITY',
          reportedByName: 'Pancake POS Open API',
          reportedAt: checkedAt,
        });
      }

      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.PANCAKE_COMMUNITY,
        shortLabel: 'Pancake POS',
        status: TrustProviderStatusEnum.LIVE_VERIFIED,
        deliveredCount,
        returnedCount,
        reportedCount,
        reportedReasons,
        confidenceWeight: 0.95,
        latencyMs,
        fromCache: false,
        message: `Đối soát trực tiếp Pancake POS: Nhận ${deliveredCount} / Tổng ${totalOrders} đơn.`,
        checkedAt,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      await this.recordProviderFailure(cbKey);
      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.PANCAKE_COMMUNITY,
        shortLabel: 'Pancake POS',
        status: TrustProviderStatusEnum.PROVIDER_ERROR,
        deliveredCount: 0,
        returnedCount: 0,
        reportedCount: 0,
        reportedReasons: [],
        confidenceWeight: 0,
        latencyMs: Date.now() - startedAt,
        fromCache: false,
        message: `Lỗi kết nối Pancake POS: ${error instanceof Error ? error.message : 'UNKNOWN'}`,
        checkedAt,
      };
    }
  }

  /**
   * Queries Nhanh.vn Open API v3.0 (https://pos.open.nhanh.vn/v3.0/customer/list)
   * using the seller's appId, businessId, and decrypted accessToken.
   */
  public async queryNhanhVnLiveApi(params: {
    normalizedPhone: string;
    nhanhAppId?: string | null;
    nhanhBusinessId?: string | null;
    decryptedAccessToken?: string | null;
  }): Promise<ExternalProviderLookupOutput> {
    const providerCode = 'NHANH_VN_OPEN_API_V3';
    const providerName = 'Nhanh.vn Open API v3';
    const checkedAt = new Date().toISOString();

    if (!params.nhanhAppId || !params.nhanhBusinessId || !params.decryptedAccessToken) {
      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.CUSTOM_WEBHOOK_PROVIDER,
        shortLabel: 'Nhanh.vn',
        status: TrustProviderStatusEnum.NOT_CONFIGURED,
        deliveredCount: 0,
        returnedCount: 0,
        reportedCount: 0,
        reportedReasons: [],
        confidenceWeight: 0,
        latencyMs: 0,
        fromCache: false,
        message: 'Shop chưa cấu hình Nhanh.vn AppId / BusinessId / AccessToken.',
        checkedAt,
      };
    }

    const cbKey = `${providerCode}:${params.nhanhBusinessId}`;
    if (await this.isCircuitOpen(cbKey)) {
      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.CUSTOM_WEBHOOK_PROVIDER,
        shortLabel: 'Nhanh.vn',
        status: TrustProviderStatusEnum.PROVIDER_ERROR,
        deliveredCount: 0,
        returnedCount: 0,
        reportedCount: 0,
        reportedReasons: [],
        confidenceWeight: 0,
        latencyMs: 0,
        fromCache: false,
        message: 'Nhanh.vn API đang tạm ngắt mạch bảo vệ.',
        checkedAt,
      };
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      const qs = new URLSearchParams({
        appId: params.nhanhAppId.trim(),
        businessId: params.nhanhBusinessId.trim(),
      });
      const response = await fetch(
        `https://pos.open.nhanh.vn/v3.0/customer/list?${qs.toString()}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: params.decryptedAccessToken.trim(),
          },
          body: JSON.stringify({
            filters: {
              mobile: params.normalizedPhone,
            },
            paginator: {
              size: 10,
            },
          }),
          signal: controller.signal,
        },
      );
      clearTimeout(timeoutId);

      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        await this.recordProviderFailure(cbKey);
        return {
          providerCode,
          providerName,
          sourceCode: DeliverySourceCodeEnum.CUSTOM_WEBHOOK_PROVIDER,
          shortLabel: 'Nhanh.vn',
          status: TrustProviderStatusEnum.PROVIDER_ERROR,
          deliveredCount: 0,
          returnedCount: 0,
          reportedCount: 0,
          reportedReasons: [],
          confidenceWeight: 0,
          latencyMs,
          fromCache: false,
          message: `Nhanh.vn API trả về HTTP ${response.status}.`,
          checkedAt,
        };
      }

      const json = (await response.json()) as {
        code?: number;
        data?: Array<Record<string, any>>;
      };
      await this.recordProviderSuccess(cbKey);

      const customers = Array.isArray(json.data) ? json.data : [];
      const matched = customers.find(
        (c) =>
          this.piiVaultService.normalizeLocalVietnamesePhone(String(c.mobile || c.phone || '')) ===
          params.normalizedPhone,
      );

      if (!matched) {
        return {
          providerCode,
          providerName,
          sourceCode: DeliverySourceCodeEnum.CUSTOM_WEBHOOK_PROVIDER,
          shortLabel: 'Nhanh.vn',
          status: TrustProviderStatusEnum.NO_RECORD,
          deliveredCount: 0,
          returnedCount: 0,
          reportedCount: 0,
          reportedReasons: [],
          confidenceWeight: 0,
          latencyMs,
          fromCache: false,
          message: 'Không có lịch sử khách hàng tương ứng trên Nhanh.vn.',
          checkedAt,
        };
      }

      const deliveredCount = Math.max(0, Number(matched.successOrders ?? matched.totalOrders ?? 0));
      const returnedCount = Math.max(
        0,
        Number(matched.returnedOrders ?? matched.failedOrders ?? 0),
      );
      const reportedCount = Math.max(0, Number(matched.badReportCount ?? 0));

      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.CUSTOM_WEBHOOK_PROVIDER,
        shortLabel: 'Nhanh.vn',
        status: TrustProviderStatusEnum.LIVE_VERIFIED,
        deliveredCount,
        returnedCount,
        reportedCount,
        reportedReasons: [],
        confidenceWeight: 0.9,
        latencyMs,
        fromCache: false,
        message: `Đối soát Nhanh.vn thành công: Nhận ${deliveredCount} • Hoàn ${returnedCount}.`,
        checkedAt,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      await this.recordProviderFailure(cbKey);
      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.CUSTOM_WEBHOOK_PROVIDER,
        shortLabel: 'Nhanh.vn',
        status: TrustProviderStatusEnum.PROVIDER_ERROR,
        deliveredCount: 0,
        returnedCount: 0,
        reportedCount: 0,
        reportedReasons: [],
        confidenceWeight: 0,
        latencyMs: Date.now() - startedAt,
        fromCache: false,
        message: `Lỗi kết nối Nhanh.vn: ${error instanceof Error ? error.message : 'UNKNOWN'}`,
        checkedAt,
      };
    }
  }

  /**
   * Queries a shop-configured external webhook URL with strict SSRF protection.
   */
  public async queryCustomExternalWebhook(params: {
    normalizedPhone: string;
    globalPhoneHash: string;
    customWebhookUrl?: string | null;
    decryptedCustomApiKey?: string | null;
  }): Promise<ExternalProviderLookupOutput> {
    const providerCode = 'CUSTOM_SHOP_WEBHOOK';
    const providerName = 'Webhook ERP / CRM Tùy Chỉnh';
    const checkedAt = new Date().toISOString();

    if (!params.customWebhookUrl || !params.customWebhookUrl.trim()) {
      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.CUSTOM_WEBHOOK_PROVIDER,
        shortLabel: 'Custom API',
        status: TrustProviderStatusEnum.NOT_CONFIGURED,
        deliveredCount: 0,
        returnedCount: 0,
        reportedCount: 0,
        reportedReasons: [],
        confidenceWeight: 0,
        latencyMs: 0,
        fromCache: false,
        message: 'Shop chưa cấu hình URL tra cứu ngoài tùy chỉnh.',
        checkedAt,
      };
    }

    let safeUrl: URL;
    try {
      safeUrl = this.assertSafeExternalWebhookUrl(params.customWebhookUrl);
    } catch (err) {
      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.CUSTOM_WEBHOOK_PROVIDER,
        shortLabel: 'Custom API',
        status: TrustProviderStatusEnum.PROVIDER_ERROR,
        deliveredCount: 0,
        returnedCount: 0,
        reportedCount: 0,
        reportedReasons: [],
        confidenceWeight: 0,
        latencyMs: 0,
        fromCache: false,
        message: `URL Webhook không hợp lệ hoặc bị chặn bởi chính sách chống SSRF (${err instanceof Error ? err.message : 'BLOCKED'}).`,
        checkedAt,
      };
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (params.decryptedCustomApiKey) {
        headers['Authorization'] = `Bearer ${params.decryptedCustomApiKey}`;
        headers['X-API-Key'] = params.decryptedCustomApiKey;
      }

      const response = await fetch(safeUrl.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          phone: params.normalizedPhone,
          phoneSha256: this.computeRawSha256(params.normalizedPhone),
          globalPhoneHash: params.globalPhoneHash,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        return {
          providerCode,
          providerName,
          sourceCode: DeliverySourceCodeEnum.CUSTOM_WEBHOOK_PROVIDER,
          shortLabel: 'Custom API',
          status: TrustProviderStatusEnum.PROVIDER_ERROR,
          deliveredCount: 0,
          returnedCount: 0,
          reportedCount: 0,
          reportedReasons: [],
          confidenceWeight: 0,
          latencyMs,
          fromCache: false,
          message: `Webhook tùy chỉnh trả về HTTP ${response.status}.`,
          checkedAt,
        };
      }

      const extData = (await response.json()) as Record<string, any>;
      const deliveredCount = Math.max(0, Number(extData.deliveredCount || 0));
      const returnedCount = Math.max(0, Number(extData.returnedCount || 0));
      const reportedCount = Math.max(0, Number(extData.reportedCount || 0));
      const hasData = deliveredCount > 0 || returnedCount > 0 || reportedCount > 0;

      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.CUSTOM_WEBHOOK_PROVIDER,
        shortLabel: 'Custom API',
        status: hasData ? TrustProviderStatusEnum.LIVE_VERIFIED : TrustProviderStatusEnum.NO_RECORD,
        deliveredCount,
        returnedCount,
        reportedCount,
        reportedReasons: Array.isArray(extData.reportedReasons) ? extData.reportedReasons : [],
        confidenceWeight: hasData ? 0.85 : 0,
        latencyMs,
        fromCache: false,
        message: hasData
          ? `Đã đồng bộ từ Custom API: Nhận ${deliveredCount} • Hoàn ${returnedCount} • Báo xấu ${reportedCount}.`
          : 'Custom API không ghi nhận lịch sử cho SĐT này.',
        checkedAt,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      return {
        providerCode,
        providerName,
        sourceCode: DeliverySourceCodeEnum.CUSTOM_WEBHOOK_PROVIDER,
        shortLabel: 'Custom API',
        status: TrustProviderStatusEnum.PROVIDER_ERROR,
        deliveredCount: 0,
        returnedCount: 0,
        reportedCount: 0,
        reportedReasons: [],
        confidenceWeight: 0,
        latencyMs: Date.now() - startedAt,
        fromCache: false,
        message: `Lỗi kết nối Custom API: ${error instanceof Error ? error.message : 'UNKNOWN'}`,
        checkedAt,
      };
    }
  }

  /**
   * Verifies a carrier tracking number live against GHN or GHTK when a seller submits
   * an abuse report, automatically upgrading the report to CARRIER_VERIFIED if the carrier
   * confirms a returned / failed delivery state.
   */
  public async verifyTrackingNumberWithCarrier(params: {
    carrierCode: string;
    trackingNumber: string;
    decryptedGhnToken?: string | null;
    decryptedGhtkToken?: string | null;
  }): Promise<TrackingVerificationResult> {
    const carrier = (params.carrierCode || '').toUpperCase();
    const tracking = (params.trackingNumber || '').trim();

    if (!tracking) {
      return {
        verified: false,
        carrierCode: carrier,
        trackingNumber: tracking,
        rawStatus: null,
        outcome: 'UNKNOWN',
        reasonNote: null,
      };
    }

    if (carrier === 'GHN' && params.decryptedGhnToken) {
      return this.verifyGhnTrackingNumber(tracking, params.decryptedGhnToken);
    }

    if (carrier === 'GHTK' && params.decryptedGhtkToken) {
      return this.verifyGhtkTrackingNumber(tracking, params.decryptedGhtkToken);
    }

    return {
      verified: false,
      carrierCode: carrier,
      trackingNumber: tracking,
      rawStatus: null,
      outcome: 'UNKNOWN',
      reasonNote: null,
    };
  }

  private async verifyGhnTrackingNumber(
    orderCode: string,
    token: string,
  ): Promise<TrackingVerificationResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(
        'https://online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/detail',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Token: token.trim(),
          },
          body: JSON.stringify({ order_code: orderCode }),
          signal: controller.signal,
        },
      );
      clearTimeout(timeoutId);
      if (!response.ok) {
        return {
          verified: false,
          carrierCode: 'GHN',
          trackingNumber: orderCode,
          rawStatus: null,
          outcome: 'UNKNOWN',
          reasonNote: null,
        };
      }
      const json = (await response.json()) as {
        code?: number;
        data?: { status?: string; log?: Array<{ status?: string; reason?: string }> };
      };
      const rawStatus = String(json?.data?.status || '').toLowerCase();
      if (!rawStatus) {
        return {
          verified: false,
          carrierCode: 'GHN',
          trackingNumber: orderCode,
          rawStatus: null,
          outcome: 'UNKNOWN',
          reasonNote: null,
        };
      }
      const outcome = this.mapGhnStatusToOutcome(rawStatus);
      const latestLog = Array.isArray(json.data?.log)
        ? json.data?.log[json.data.log.length - 1]
        : null;
      return {
        verified:
          outcome === 'RETURNED' || outcome === 'DELIVERY_FAILED' || outcome === 'DELIVERED',
        carrierCode: 'GHN',
        trackingNumber: orderCode,
        rawStatus,
        outcome,
        reasonNote: latestLog?.reason || null,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      this.logger.debug(`GHN tracking verification failed for ${orderCode}: ${String(err)}`);
      return {
        verified: false,
        carrierCode: 'GHN',
        trackingNumber: orderCode,
        rawStatus: null,
        outcome: 'UNKNOWN',
        reasonNote: null,
      };
    }
  }

  private async verifyGhtkTrackingNumber(
    trackingOrder: string,
    token: string,
  ): Promise<TrackingVerificationResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(
        `https://services.giaohangtietkiem.vn/services/shipment/v2/${encodeURIComponent(trackingOrder)}`,
        {
          method: 'GET',
          headers: {
            Token: token.trim(),
            Accept: 'application/json',
          },
          signal: controller.signal,
        },
      );
      clearTimeout(timeoutId);
      if (!response.ok) {
        return {
          verified: false,
          carrierCode: 'GHTK',
          trackingNumber: trackingOrder,
          rawStatus: null,
          outcome: 'UNKNOWN',
          reasonNote: null,
        };
      }
      const json = (await response.json()) as {
        success?: boolean;
        order?: { status?: number | string; status_text?: string };
      };
      if (!json.success || !json.order) {
        return {
          verified: false,
          carrierCode: 'GHTK',
          trackingNumber: trackingOrder,
          rawStatus: null,
          outcome: 'UNKNOWN',
          reasonNote: null,
        };
      }
      const statusId = Number(json.order.status);
      const outcome = this.mapGhtkStatusIdToOutcome(statusId);
      return {
        verified:
          outcome === 'RETURNED' || outcome === 'DELIVERY_FAILED' || outcome === 'DELIVERED',
        carrierCode: 'GHTK',
        trackingNumber: trackingOrder,
        rawStatus: String(statusId),
        outcome,
        reasonNote: json.order.status_text || null,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      this.logger.debug(`GHTK tracking verification failed for ${trackingOrder}: ${String(err)}`);
      return {
        verified: false,
        carrierCode: 'GHTK',
        trackingNumber: trackingOrder,
        rawStatus: null,
        outcome: 'UNKNOWN',
        reasonNote: null,
      };
    }
  }

  public mapGhnStatusToOutcome(
    rawStatus: string,
  ): 'DELIVERED' | 'RETURNED' | 'DELIVERY_FAILED' | 'IN_TRANSIT' | 'UNKNOWN' {
    const normalized = rawStatus.trim().toLowerCase();
    if (normalized === 'delivered') return 'DELIVERED';
    if (
      [
        'waiting_to_return',
        'return',
        'return_transporting',
        'return_sorting',
        'returning',
        'return_fail',
        'returned',
      ].includes(normalized)
    ) {
      return 'RETURNED';
    }
    if (normalized === 'delivery_fail') return 'DELIVERY_FAILED';
    if (
      [
        'ready_to_pick',
        'picking',
        'money_collect_picking',
        'picked',
        'storing',
        'sorting',
        'transporting',
        'delivering',
        'money_collect_delivering',
      ].includes(normalized)
    ) {
      return 'IN_TRANSIT';
    }
    return 'UNKNOWN';
  }

  public mapGhtkStatusIdToOutcome(
    statusId: number,
  ): 'DELIVERED' | 'RETURNED' | 'DELIVERY_FAILED' | 'IN_TRANSIT' | 'UNKNOWN' {
    if (statusId === 5 || statusId === 6 || statusId === 45) return 'DELIVERED';
    if ([9, 11, 20, 21].includes(statusId)) return 'RETURNED';
    if (statusId === 49 || statusId === 410) return 'DELIVERY_FAILED';
    if ([1, 2, 3, 4, 12, 123].includes(statusId)) return 'IN_TRANSIT';
    return 'UNKNOWN';
  }

  public mapViettelPostStatusToOutcome(
    orderStatus: number,
  ): 'DELIVERED' | 'RETURNED' | 'DELIVERY_FAILED' | 'IN_TRANSIT' | 'UNKNOWN' {
    if (orderStatus === 501) return 'DELIVERED';
    if ([504, 505, 515].includes(orderStatus)) return 'RETURNED';
    if ([506, 507, 508].includes(orderStatus)) return 'DELIVERY_FAILED';
    if (orderStatus >= 100 && orderStatus < 501) return 'IN_TRANSIT';
    return 'UNKNOWN';
  }

  public mapSuperShipStatusToOutcome(
    rawStatus: string | number,
  ): 'DELIVERED' | 'RETURNED' | 'DELIVERY_FAILED' | 'IN_TRANSIT' | 'UNKNOWN' {
    const str = String(rawStatus || '')
      .trim()
      .toLowerCase();
    if (str === '12' || str.includes('đã giao') || str.includes('delivered')) {
      return 'DELIVERED';
    }
    if (
      str === '16' ||
      str === '17' ||
      str.includes('trả hàng') ||
      str.includes('hoàn') ||
      str.includes('return')
    ) {
      return 'RETURNED';
    }
    if (str === '14' || str.includes('không giao được') || str.includes('fail')) {
      return 'DELIVERY_FAILED';
    }
    return 'IN_TRANSIT';
  }

  public resolveVerificationLevelFromTracking(
    result: TrackingVerificationResult,
    hasOrderCode: boolean,
  ): PhoneTrustVerificationLevelEnum {
    if (
      result.verified &&
      (result.outcome === 'RETURNED' || result.outcome === 'DELIVERY_FAILED')
    ) {
      return PhoneTrustVerificationLevelEnum.CARRIER_VERIFIED;
    }
    if (hasOrderCode) {
      return PhoneTrustVerificationLevelEnum.ORDER_LINKED;
    }
    return PhoneTrustVerificationLevelEnum.SHOP_DECLARED;
  }
}
