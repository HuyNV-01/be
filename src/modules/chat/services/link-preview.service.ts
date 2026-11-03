import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import * as dns from 'dns/promises';
import * as net from 'net';
import { MessageLinkPreviewMeta } from 'src/interface/message.interface';

@Injectable()
export class LinkPreviewService {
  private readonly logger = new Logger(LinkPreviewService.name);
  private readonly cache = new Map<string, { data: MessageLinkPreviewMeta; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 1000 * 60 * 30; // 30 phút
  private readonly MAX_HTML_BYTES = 256 * 1024; // Giới hạn đọc tối đa 256KB đầu tiên
  private readonly FETCH_TIMEOUT_MS = 3500;

  /**
   * Kiểm tra địa chỉ IP để phòng chống lỗ hổng SSRF (chặn localhost, LAN, link-local, metadata AWS/Cloud).
   */
  private isPrivateOrReservedIp(ip: string): boolean {
    if (net.isIPv4(ip)) {
      const parts = ip.split('.').map(Number);
      if (parts[0] === 10) return true;
      if (parts[0] === 127) return true;
      if (parts[0] === 0) return true;
      if (parts[0] === 169 && parts[1] === 254) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
      return false;
    }
    if (net.isIPv6(ip)) {
      const normalized = ip.toLowerCase();
      return (
        normalized === '::1' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe80')
      );
    }
    return true;
  }

  /**
   * Trích xuất URL hợp lệ đầu tiên từ nội dung tin nhắn văn bản.
   */
  extractFirstUrl(text: string): string | null {
    if (!text) return null;
    const match = text.match(/https?:\/\/[^\s<>"'`]+/i);
    return match ? match[0] : null;
  }

  /**
   * Thu thập thông tin OpenGraph (og:title, og:description, og:image, og:site_name) an toàn.
   */
  async fetchLinkPreview(rawUrl: string): Promise<MessageLinkPreviewMeta | null> {
    try {
      const parsed = new URL(rawUrl.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }

      const normalizedUrl = parsed.toString();
      const cached = this.cache.get(normalizedUrl);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
      }

      const hostname = parsed.hostname.toLowerCase();
      if (hostname === 'localhost' || hostname.endsWith('.local')) {
        throw new BadRequestException('Blocked internal hostname');
      }

      const lookupResults = await dns.lookup(hostname, { all: true });
      if (
        !lookupResults.length ||
        lookupResults.some((record) => this.isPrivateOrReservedIp(record.address))
      ) {
        throw new BadRequestException('SSRF Protection: Restricted IP address');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS);

      const response = await fetch(normalizedUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'LiquidChatBot/1.0 (+https://liquidchat.app)',
          Accept: 'text/html,application/xhtml+xml',
        },
      }).finally(() => clearTimeout(timer));

      if (!response.ok) return null;

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('text/html')) {
        return null;
      }

      const reader = response.body?.getReader();
      if (!reader) return null;

      const chunks: Uint8Array[] = [];
      let totalRead = 0;
      while (totalRead < this.MAX_HTML_BYTES) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        totalRead += value.byteLength;
      }
      await reader.cancel().catch(() => undefined);

      const html = Buffer.concat(chunks).toString('utf-8');
      const title =
        this.extractMetaTag(html, 'og:title') ||
        this.extractMetaTag(html, 'twitter:title') ||
        this.extractHtmlTitle(html);
      const description =
        this.extractMetaTag(html, 'og:description') ||
        this.extractMetaTag(html, 'description') ||
        this.extractMetaTag(html, 'twitter:description');
      const rawImage =
        this.extractMetaTag(html, 'og:image') || this.extractMetaTag(html, 'twitter:image');
      const siteName = this.extractMetaTag(html, 'og:site_name') || parsed.hostname;

      let resolvedImage: string | undefined;
      if (rawImage) {
        try {
          const imgUrl = new URL(rawImage, normalizedUrl);
          if (imgUrl.protocol === 'http:' || imgUrl.protocol === 'https:') {
            resolvedImage = imgUrl.toString();
          }
        } catch {
          resolvedImage = undefined;
        }
      }

      if (!title && !description && !resolvedImage) {
        return null;
      }

      const result: MessageLinkPreviewMeta = {
        url: normalizedUrl,
        hostname: parsed.hostname,
        title: title ? this.decodeHtmlEntities(title).slice(0, 180) : undefined,
        description: description ? this.decodeHtmlEntities(description).slice(0, 300) : undefined,
        image: resolvedImage,
        siteName: siteName ? this.decodeHtmlEntities(siteName).slice(0, 80) : parsed.hostname,
      };

      this.cache.set(normalizedUrl, {
        data: result,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });

      return result;
    } catch (err) {
      this.logger.debug(`Link preview skipped for ${rawUrl}: ${String(err)}`);
      return null;
    }
  }

  private extractMetaTag(html: string, key: string): string | undefined {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex1 = new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
      'i',
    );
    const regex2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`,
      'i',
    );
    return regex1.exec(html)?.[1] || regex2.exec(html)?.[1];
  }

  private extractHtmlTitle(html: string): string | undefined {
    const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
    return match?.[1]?.trim();
  }

  private decodeHtmlEntities(str: string): string {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }
}
