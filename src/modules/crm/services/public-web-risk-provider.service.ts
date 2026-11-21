import { Injectable, Logger } from '@nestjs/common';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  CustomerAbuseReportItem,
  PersistedTrustProviderDiagnosticItem,
} from 'src/entity/customer-profile.entity';

export interface PublicWebRiskHit {
  providerCode:
    | 'PUBLIC_WEB_GHETBOMHANG'
    | 'PUBLIC_WEB_CHONGBOMHANG'
    | 'PUBLIC_WEB_CHECKSCAM'
    | 'PUBLIC_WEB_CHONGLUADAO';
  providerName: string;
  status: 'LIVE_VERIFIED' | 'NO_RECORD' | 'PROVIDER_ERROR';
  reportedCount: number;
  reports: Array<Partial<CustomerAbuseReportItem> & Record<string, unknown>>;
  latencyMs: number;
  fromCache: boolean;
  message: string;
  checkedAt: string;
}

const PUBLIC_WEB_CACHE_TTL_SECONDS = 1800;
const PUBLIC_WEB_TIMEOUT_MS = 3500;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Dịch vụ Tra cứu Cộng đồng Công khai 100% Zero-Key (không yêu cầu bất kỳ API Key nào):
 * GhetBomHang.com, ChongBomHang.com, CheckScam.vn và ChongLuaDao.info.
 */
@Injectable()
export class PublicWebRiskProviderService {
  private readonly logger = new Logger(PublicWebRiskProviderService.name);

  constructor(@InjectRedis() private readonly redis: Redis) {}

  public async queryPublicCommunityPortals(params: {
    normalizedPhone: string;
    phoneGlobalHash: string;
    bypassCache?: boolean;
  }): Promise<{
    hits: PublicWebRiskHit[];
    diagnostics: PersistedTrustProviderDiagnosticItem[];
  }> {
    const tasks: Array<Promise<PublicWebRiskHit>> = [
      this.queryPublicHtmlPortal({
        providerCode: 'PUBLIC_WEB_GHETBOMHANG',
        providerName: 'Cộng đồng GhetBomHang.com (Miễn phí)',
        cachePrefix: 'ghetbomhang',
        targetUrl: `https://ghetbomhang.com/?search=${encodeURIComponent(params.normalizedPhone)}`,
        sourceLabel: 'GhetBomHang.com',
        reportedByName: 'Cộng đồng GhetBomHang.com',
        reasonCode: 'BOM_HANG',
        severity: 'HIGH',
        noResultPattern: /không tìm thấy|chưa có tố cáo|0 kết quả|chưa bị báo cáo/i,
        normalizedPhone: params.normalizedPhone,
        phoneGlobalHash: params.phoneGlobalHash,
        bypassCache: params.bypassCache,
      }),
      this.queryPublicHtmlPortal({
        providerCode: 'PUBLIC_WEB_CHONGBOMHANG',
        providerName: 'Cộng đồng ChongBomHang.com (Miễn phí)',
        cachePrefix: 'chongbomhang',
        targetUrl: `https://chongbomhang.com/?s=${encodeURIComponent(params.normalizedPhone)}`,
        sourceLabel: 'ChongBomHang.com',
        reportedByName: 'Cộng đồng ChongBomHang.com',
        reasonCode: 'BOM_HANG',
        severity: 'HIGH',
        noResultPattern: /không tìm thấy|chưa có dữ liệu|0 kết quả|no results/i,
        normalizedPhone: params.normalizedPhone,
        phoneGlobalHash: params.phoneGlobalHash,
        bypassCache: params.bypassCache,
      }),
      this.queryPublicHtmlPortal({
        providerCode: 'PUBLIC_WEB_CHECKSCAM',
        providerName: 'Cộng đồng CheckScam.vn (Miễn phí)',
        cachePrefix: 'checkscam',
        targetUrl: `https://checkscam.vn/?s=${encodeURIComponent(params.normalizedPhone)}`,
        sourceLabel: 'CheckScam.vn',
        reportedByName: 'Cộng đồng CheckScam.vn',
        reasonCode: 'BOOM_AO_SPAM',
        severity: 'CRITICAL',
        noResultPattern: /không tìm thấy|nothing found|0 kết quả|chưa có cảnh báo/i,
        normalizedPhone: params.normalizedPhone,
        phoneGlobalHash: params.phoneGlobalHash,
        bypassCache: params.bypassCache,
      }),
      this.queryPublicHtmlPortal({
        providerCode: 'PUBLIC_WEB_CHONGLUADAO',
        providerName: 'Cộng đồng ChongLuaDao.info (Miễn phí)',
        cachePrefix: 'chongluadao',
        targetUrl: `https://chongluadao.info/search?q=${encodeURIComponent(params.normalizedPhone)}`,
        sourceLabel: 'ChongLuaDao.info',
        reportedByName: 'Cộng đồng ChongLuaDao.info',
        reasonCode: 'BOOM_AO_SPAM',
        severity: 'CRITICAL',
        noResultPattern: /không tìm thấy|chưa có dữ liệu|0 kết quả|không có kết quả/i,
        normalizedPhone: params.normalizedPhone,
        phoneGlobalHash: params.phoneGlobalHash,
        bypassCache: params.bypassCache,
      }),
    ];

    const hits = await Promise.all(tasks);
    const diagnostics: PersistedTrustProviderDiagnosticItem[] = hits.map((hit) => ({
      providerCode: hit.providerCode,
      providerName: hit.providerName,
      status: hit.status,
      deliveredCount: 0,
      returnedCount: 0,
      reportedCount: hit.reportedCount,
      latencyMs: hit.latencyMs,
      fromCache: hit.fromCache,
      message: hit.message,
      checkedAt: hit.checkedAt,
    }));

    return { hits, diagnostics };
  }

  private async queryPublicHtmlPortal(params: {
    providerCode:
      | 'PUBLIC_WEB_GHETBOMHANG'
      | 'PUBLIC_WEB_CHONGBOMHANG'
      | 'PUBLIC_WEB_CHECKSCAM'
      | 'PUBLIC_WEB_CHONGLUADAO';
    providerName: string;
    cachePrefix: string;
    targetUrl: string;
    sourceLabel: string;
    reportedByName: string;
    reasonCode: string;
    severity: 'HIGH' | 'CRITICAL';
    noResultPattern: RegExp;
    normalizedPhone: string;
    phoneGlobalHash: string;
    bypassCache?: boolean;
  }): Promise<PublicWebRiskHit> {
    const checkedAt = new Date().toISOString();
    const cacheKey = `trust:public:${params.cachePrefix}:${params.phoneGlobalHash}`;
    if (!params.bypassCache) {
      const cached = await this.readCache<PublicWebRiskHit>(cacheKey);
      if (cached) return { ...cached, fromCache: true };
    }

    const startedAt = Date.now();
    const fetchResult = await this.fetchHtmlSafely(params.targetUrl);
    const latencyMs = Date.now() - startedAt;

    if (fetchResult.error || fetchResult.html === null) {
      return {
        providerCode: params.providerCode,
        providerName: params.providerName,
        status: 'PROVIDER_ERROR',
        reportedCount: 0,
        reports: [],
        latencyMs,
        fromCache: false,
        message: fetchResult.error || `Tạm thời không thể kết nối ${params.sourceLabel}.`,
        checkedAt,
      };
    }

    if (this.isBotChallengePage(fetchResult.html)) {
      return {
        providerCode: params.providerCode,
        providerName: params.providerName,
        status: 'PROVIDER_ERROR',
        reportedCount: 0,
        reports: [],
        latencyMs,
        fromCache: false,
        message: `${params.sourceLabel} đang bật bảo vệ Cloudflare — tạm bỏ qua cổng này và dùng dữ liệu các nguồn còn lại.`,
        checkedAt,
      };
    }

    // Loại bỏ input/meta/title trước khi đếm SĐT để không bị lệch do ô tìm kiếm lặp lại SĐT
    const sanitizedText = this.stripNonContentHtml(fetchResult.html);
    const exactMentions = this.countExactPhoneMentions(sanitizedText, params.normalizedPhone);
    const hasNoResultPhrase = params.noResultPattern.test(sanitizedText);

    if (exactMentions === 0 || hasNoResultPhrase) {
      const noRec: PublicWebRiskHit = {
        providerCode: params.providerCode,
        providerName: params.providerName,
        status: 'NO_RECORD',
        reportedCount: 0,
        reports: [],
        latencyMs,
        fromCache: false,
        message: `Chưa ghi nhận tố cáo bom hàng / lừa đảo nào trên ${params.sourceLabel}.`,
        checkedAt,
      };
      await this.writeCache(cacheKey, noRec);
      return noRec;
    }

    const snippet = this.extractContextSnippetAroundPhone(sanitizedText, params.normalizedPhone);
    const reports = [
      {
        reportId: `rep_pub_${params.cachePrefix}_${params.phoneGlobalHash.slice(0, 12)}`,
        reason: snippet || `SĐT có cảnh báo công khai trên ${params.sourceLabel}.`,
        reasonCode: params.reasonCode,
        reasonNote: snippet || `SĐT có cảnh báo công khai trên ${params.sourceLabel}.`,
        source: 'PANCAKE_COMMUNITY',
        sourceLabel: params.sourceLabel,
        severity: params.severity,
        isCarrierVerified: false,
        verificationLevel: 'SHOP_DECLARED' as const,
        evidenceUrl: params.targetUrl,
        reportedByName: params.reportedByName,
        reportedAt: checkedAt,
      },
    ];

    const hit: PublicWebRiskHit = {
      providerCode: params.providerCode,
      providerName: params.providerName,
      status: 'LIVE_VERIFIED',
      reportedCount: Math.min(5, exactMentions),
      reports,
      latencyMs,
      fromCache: false,
      message: `Phát hiện cảnh báo công khai trên ${params.sourceLabel} (${Math.min(5, exactMentions)} kết quả khớp SĐT).`,
      checkedAt,
    };
    await this.writeCache(cacheKey, hit);
    return hit;
  }

  private async fetchHtmlSafely(
    url: string,
  ): Promise<{ html: string | null; error: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUBLIC_WEB_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 403 || res.status === 503) {
        return { html: null, error: `Cổng công khai chặn truy cập tự động (HTTP ${res.status}).` };
      }
      if (!res.ok) {
        return { html: null, error: `Cổng công khai phản hồi HTTP ${res.status}.` };
      }
      return { html: await res.text(), error: null };
    } catch {
      clearTimeout(timer);
      return { html: null, error: 'Hết thời gian chờ kết nối cổng công khai (timeout 3.5s).' };
    }
  }

  private isBotChallengePage(html: string): boolean {
    return /cf-browser-verification|challenge-platform|just a moment\.\.\.|attention required!\s*\|\s*cloudflare/i.test(
      html,
    );
  }

  private stripNonContentHtml(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<input[^>]*>/gi, ' ')
      .replace(/<title[\s\S]*?<\/title>/gi, ' ')
      .replace(/<meta[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private countExactPhoneMentions(plainText: string, normalizedPhone: string): number {
    const escaped = normalizedPhone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?<!\\d)${escaped}(?!\\d)`, 'g');
    const matches = plainText.match(regex);
    return matches ? matches.length : 0;
  }

  private extractContextSnippetAroundPhone(plainText: string, normalizedPhone: string): string {
    const idx = plainText.indexOf(normalizedPhone);
    if (idx === -1) return '';
    const start = Math.max(0, idx - 60);
    const end = Math.min(plainText.length, idx + normalizedPhone.length + 140);
    return plainText.slice(start, end).trim();
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
      await this.redis.set(key, JSON.stringify(value), 'EX', PUBLIC_WEB_CACHE_TTL_SECONDS);
    } catch (err) {
      this.logger.debug(`Public web risk cache write skipped: ${String(err)}`);
    }
  }
}
