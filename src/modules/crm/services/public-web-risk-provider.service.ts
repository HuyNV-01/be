import { Injectable, Logger } from '@nestjs/common';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  CustomerAbuseReportItem,
  PersistedTrustProviderDiagnosticItem,
} from 'src/entity/customer-profile.entity';

export interface PublicWebRiskHit {
  providerCode: 'PUBLIC_WEB_CHONGBOMHANG' | 'PUBLIC_WEB_GHETBOMHANG' | 'PUBLIC_WEB_CHECKSCAM';
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
 * Dịch vụ Tra cứu Cảnh báo Bom hàng / Lừa đảo Công khai KHÔNG CẦN API KEY (`Zero-Key Public Web Risk Providers`).
 * Truy vấn song song các cổng cộng đồng công khai tại Việt Nam (chongbomhang.com, ghetbomhang.com, checkscam.vn)
 * kèm Redis Cache 30 phút, Timeout cứng 3.5 giây và cơ chế cô lập lỗi để không bao giờ làm chậm luồng chat/POS.
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
      this.queryChongBomHang(params),
      this.queryGhetBomHang(params),
      this.queryCheckScam(params),
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

  private async queryChongBomHang(params: {
    normalizedPhone: string;
    phoneGlobalHash: string;
    bypassCache?: boolean;
  }): Promise<PublicWebRiskHit> {
    const checkedAt = new Date().toISOString();
    const cacheKey = `trust:public:chongbomhang:${params.phoneGlobalHash}`;
    if (!params.bypassCache) {
      const cached = await this.readCache<PublicWebRiskHit>(cacheKey);
      if (cached) return { ...cached, fromCache: true };
    }

    const startedAt = Date.now();
    const targetUrl = `https://chongbomhang.com/?s=${encodeURIComponent(params.normalizedPhone)}`;
    const html = await this.fetchHtmlSafely(targetUrl);
    const latencyMs = Date.now() - startedAt;

    if (html === null) {
      return {
        providerCode: 'PUBLIC_WEB_CHONGBOMHANG',
        providerName: 'Cộng đồng ChongBomHang.com (Miễn phí)',
        status: 'PROVIDER_ERROR',
        reportedCount: 0,
        reports: [],
        latencyMs,
        fromCache: false,
        message: 'Không thể kết nối chongbomhang.com (timeout hoặc tạm gián đoạn).',
        checkedAt,
      };
    }

    const normalizedHtml = this.stripScriptsAndStyles(html);
    const exactMentions = this.countExactPhoneMentions(normalizedHtml, params.normalizedPhone);
    const hasNoResultPhrase = /không tìm thấy|chưa có dữ liệu|0 kết quả|no results/i.test(
      normalizedHtml,
    );

    if (exactMentions === 0 || hasNoResultPhrase) {
      const noRec: PublicWebRiskHit = {
        providerCode: 'PUBLIC_WEB_CHONGBOMHANG',
        providerName: 'Cộng đồng ChongBomHang.com (Miễn phí)',
        status: 'NO_RECORD',
        reportedCount: 0,
        reports: [],
        latencyMs,
        fromCache: false,
        message: 'Chưa ghi nhận bài tố cáo bom hàng nào trên chongbomhang.com.',
        checkedAt,
      };
      await this.writeCache(cacheKey, noRec);
      return noRec;
    }

    const snippet = this.extractContextSnippetAroundPhone(normalizedHtml, params.normalizedPhone);
    const reports = [
      {
        reportId: `rep_pub_cbh_${params.phoneGlobalHash.slice(0, 12)}`,
        reason: snippet || 'Số điện thoại xuất hiện trong danh sách cảnh báo bom hàng công khai.',
        reasonCode: 'BOM_HANG',
        reasonNote:
          snippet ||
          'Số điện thoại xuất hiện trong danh sách cảnh báo bom hàng trên chongbomhang.com.',
        source: 'PANCAKE_COMMUNITY',
        sourceLabel: 'ChongBomHang.com (Công khai)',
        severity: 'HIGH' as const,
        isCarrierVerified: false,
        verificationLevel: 'SHOP_DECLARED' as const,
        evidenceUrl: targetUrl,
        reportedByName: 'Cộng đồng ChongBomHang.com',
        reportedAt: checkedAt,
      },
    ];

    const hit: PublicWebRiskHit = {
      providerCode: 'PUBLIC_WEB_CHONGBOMHANG',
      providerName: 'Cộng đồng ChongBomHang.com (Miễn phí)',
      status: 'LIVE_VERIFIED',
      reportedCount: Math.min(5, exactMentions),
      reports,
      latencyMs,
      fromCache: false,
      message: `Phát hiện cảnh báo bom hàng công khai trên chongbomhang.com (${Math.min(5, exactMentions)} kết quả khớp SĐT).`,
      checkedAt,
    };
    await this.writeCache(cacheKey, hit);
    return hit;
  }

  private async queryGhetBomHang(params: {
    normalizedPhone: string;
    phoneGlobalHash: string;
    bypassCache?: boolean;
  }): Promise<PublicWebRiskHit> {
    const checkedAt = new Date().toISOString();
    const cacheKey = `trust:public:ghetbomhang:${params.phoneGlobalHash}`;
    if (!params.bypassCache) {
      const cached = await this.readCache<PublicWebRiskHit>(cacheKey);
      if (cached) return { ...cached, fromCache: true };
    }

    const startedAt = Date.now();
    const targetUrl = `https://ghetbomhang.com/?search=${encodeURIComponent(params.normalizedPhone)}`;
    const html = await this.fetchHtmlSafely(targetUrl);
    const latencyMs = Date.now() - startedAt;

    if (html === null) {
      return {
        providerCode: 'PUBLIC_WEB_GHETBOMHANG',
        providerName: 'Cộng đồng GhetBomHang.com (Miễn phí)',
        status: 'PROVIDER_ERROR',
        reportedCount: 0,
        reports: [],
        latencyMs,
        fromCache: false,
        message: 'Không thể kết nối ghetbomhang.com (timeout hoặc tạm gián đoạn).',
        checkedAt,
      };
    }

    const normalizedHtml = this.stripScriptsAndStyles(html);
    const exactMentions = this.countExactPhoneMentions(normalizedHtml, params.normalizedPhone);
    const hasNoResultPhrase = /không tìm thấy|chưa có tố cáo|0 kết quả|chưa bị báo cáo/i.test(
      normalizedHtml,
    );

    if (exactMentions === 0 || hasNoResultPhrase) {
      const noRec: PublicWebRiskHit = {
        providerCode: 'PUBLIC_WEB_GHETBOMHANG',
        providerName: 'Cộng đồng GhetBomHang.com (Miễn phí)',
        status: 'NO_RECORD',
        reportedCount: 0,
        reports: [],
        latencyMs,
        fromCache: false,
        message: 'Chưa ghi nhận tố cáo bom hàng nào trên ghetbomhang.com.',
        checkedAt,
      };
      await this.writeCache(cacheKey, noRec);
      return noRec;
    }

    const snippet = this.extractContextSnippetAroundPhone(normalizedHtml, params.normalizedPhone);
    const reports = [
      {
        reportId: `rep_pub_gbh_${params.phoneGlobalHash.slice(0, 12)}`,
        reason: snippet || 'SĐT có cảnh báo bom hàng trên cổng công khai ghetbomhang.com.',
        reasonCode: 'BOM_HANG',
        reasonNote: snippet || 'SĐT có cảnh báo bom hàng trên ghetbomhang.com.',
        source: 'PANCAKE_COMMUNITY',
        sourceLabel: 'GhetBomHang.com (Công khai)',
        severity: 'HIGH' as const,
        isCarrierVerified: false,
        verificationLevel: 'SHOP_DECLARED' as const,
        evidenceUrl: targetUrl,
        reportedByName: 'Cộng đồng GhetBomHang.com',
        reportedAt: checkedAt,
      },
    ];

    const hit: PublicWebRiskHit = {
      providerCode: 'PUBLIC_WEB_GHETBOMHANG',
      providerName: 'Cộng đồng GhetBomHang.com (Miễn phí)',
      status: 'LIVE_VERIFIED',
      reportedCount: Math.min(5, exactMentions),
      reports,
      latencyMs,
      fromCache: false,
      message: `Phát hiện cảnh báo công khai trên ghetbomhang.com (${Math.min(5, exactMentions)} kết quả khớp SĐT).`,
      checkedAt,
    };
    await this.writeCache(cacheKey, hit);
    return hit;
  }

  private async queryCheckScam(params: {
    normalizedPhone: string;
    phoneGlobalHash: string;
    bypassCache?: boolean;
  }): Promise<PublicWebRiskHit> {
    const checkedAt = new Date().toISOString();
    const cacheKey = `trust:public:checkscam:${params.phoneGlobalHash}`;
    if (!params.bypassCache) {
      const cached = await this.readCache<PublicWebRiskHit>(cacheKey);
      if (cached) return { ...cached, fromCache: true };
    }

    const startedAt = Date.now();
    const targetUrl = `https://checkscam.vn/?s=${encodeURIComponent(params.normalizedPhone)}`;
    const html = await this.fetchHtmlSafely(targetUrl);
    const latencyMs = Date.now() - startedAt;

    if (html === null) {
      return {
        providerCode: 'PUBLIC_WEB_CHECKSCAM',
        providerName: 'Cộng đồng CheckScam.vn (Miễn phí)',
        status: 'PROVIDER_ERROR',
        reportedCount: 0,
        reports: [],
        latencyMs,
        fromCache: false,
        message: 'Không thể kết nối checkscam.vn (timeout hoặc tạm gián đoạn).',
        checkedAt,
      };
    }

    const normalizedHtml = this.stripScriptsAndStyles(html);
    const exactMentions = this.countExactPhoneMentions(normalizedHtml, params.normalizedPhone);
    const hasNoResultPhrase = /không tìm thấy|nothing found|0 kết quả|chưa có cảnh báo/i.test(
      normalizedHtml,
    );

    if (exactMentions === 0 || hasNoResultPhrase) {
      const noRec: PublicWebRiskHit = {
        providerCode: 'PUBLIC_WEB_CHECKSCAM',
        providerName: 'Cộng đồng CheckScam.vn (Miễn phí)',
        status: 'NO_RECORD',
        reportedCount: 0,
        reports: [],
        latencyMs,
        fromCache: false,
        message: 'Chưa ghi nhận cảnh báo lừa đảo / bom hàng trên checkscam.vn.',
        checkedAt,
      };
      await this.writeCache(cacheKey, noRec);
      return noRec;
    }

    const snippet = this.extractContextSnippetAroundPhone(normalizedHtml, params.normalizedPhone);
    const reports = [
      {
        reportId: `rep_pub_cs_${params.phoneGlobalHash.slice(0, 12)}`,
        reason: snippet || 'SĐT xuất hiện trong bài cảnh báo công khai trên checkscam.vn.',
        reasonCode: 'BOOM_AO_SPAM',
        reasonNote: snippet || 'SĐT xuất hiện trong bài cảnh báo công khai trên checkscam.vn.',
        source: 'PANCAKE_COMMUNITY',
        sourceLabel: 'CheckScam.vn (Công khai)',
        severity: 'CRITICAL' as const,
        isCarrierVerified: false,
        verificationLevel: 'SHOP_DECLARED' as const,
        evidenceUrl: targetUrl,
        reportedByName: 'Cộng đồng CheckScam.vn',
        reportedAt: checkedAt,
      },
    ];

    const hit: PublicWebRiskHit = {
      providerCode: 'PUBLIC_WEB_CHECKSCAM',
      providerName: 'Cộng đồng CheckScam.vn (Miễn phí)',
      status: 'LIVE_VERIFIED',
      reportedCount: Math.min(5, exactMentions),
      reports,
      latencyMs,
      fromCache: false,
      message: `Phát hiện cảnh báo công khai trên checkscam.vn (${Math.min(5, exactMentions)} kết quả khớp SĐT).`,
      checkedAt,
    };
    await this.writeCache(cacheKey, hit);
    return hit;
  }

  private async fetchHtmlSafely(url: string): Promise<string | null> {
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
      if (!res.ok) return null;
      return await res.text();
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  private stripScriptsAndStyles(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private countExactPhoneMentions(plainText: string, normalizedPhone: string): number {
    // Bỏ qua chuỗi SĐT xuất hiện trong ô input search lặp lại bằng cách đếm số lần xuất hiện vượt quá 1
    const escaped = normalizedPhone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?<!\\d)${escaped}(?!\\d)`, 'g');
    const matches = plainText.match(regex);
    if (!matches) return 0;
    return Math.max(0, matches.length - 1);
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
