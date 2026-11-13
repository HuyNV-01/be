import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

import { TunnelProviderEnum } from 'src/config/tunnel/tunnel.interface';

export const DEFAULT_TUNNEL_DOMAIN_SUFFIXES = [
  '.ngrok-free.app',
  '.ngrok-free.dev',
  '.ngrok.io',
  '.ngrok.app',
  '.trycloudflare.com',
  '.loca.lt',
  '.ts.net',
];

export const TUNNEL_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'Accept',
  'Origin',
  'X-Requested-With',
  'x-shop-id',
  'x-refresh-token',
  'x-tunnel-provider',
  'ngrok-skip-browser-warning',
  'cf-access-client-id',
  'cf-access-client-secret',
];

class DynamicTunnelOriginRegistry {
  private readonly dynamicOrigins = new Set<string>();
  private activePublicBaseUrl: string | null = null;
  private activeFrontendUrl: string | null = null;

  registerOrigin(rawUrl?: string | null): void {
    const normalized = normalizePublicBaseUrl(rawUrl);
    if (!normalized) return;
    try {
      const parsed = new URL(normalized);
      this.dynamicOrigins.add(parsed.origin.toLowerCase());
    } catch {
      // Bỏ qua URL không hợp lệ
    }
  }

  setActivePublicBaseUrl(rawUrl?: string | null): void {
    const normalized = normalizePublicBaseUrl(rawUrl);
    this.activePublicBaseUrl = normalized;
    if (normalized) {
      this.registerOrigin(normalized);
    }
  }

  getActivePublicBaseUrl(): string | null {
    return this.activePublicBaseUrl;
  }

  setActiveFrontendUrl(rawUrl?: string | null): void {
    const normalized = normalizePublicBaseUrl(rawUrl);
    this.activeFrontendUrl = normalized;
    if (normalized) {
      this.registerOrigin(normalized);
    }
  }

  getActiveFrontendUrl(): string | null {
    return this.activeFrontendUrl;
  }

  hasOrigin(origin: string): boolean {
    return this.dynamicOrigins.has(origin.toLowerCase().replace(/\/+$/, ''));
  }

  getAllOrigins(): string[] {
    return Array.from(this.dynamicOrigins);
  }
}

export const tunnelOriginRegistry = new DynamicTunnelOriginRegistry();

export function normalizePublicBaseUrl(rawInput?: string | null): string | null {
  if (!rawInput) return null;
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    const isLocal =
      candidate.startsWith('localhost') ||
      candidate.startsWith('127.0.0.1') ||
      candidate.startsWith('0.0.0.0') ||
      /^192\.168\.\d+\.\d+/.test(candidate) ||
      /^10\.\d+\.\d+\.\d+/.test(candidate);
    candidate = `${isLocal ? 'http' : 'https'}://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    const cleanPath = parsed.pathname
      .replace(/\/api\/?$/i, '')
      .replace(/\/webhooks\/omnichannel.*$/i, '')
      .replace(/\/+$/, '');
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return null;
  }
}

/**
 * Kiểm tra một URL có phải là địa chỉ nội bộ (localhost / loopback) hay không.
 */
export function isLocalhostUrl(rawUrl?: string | null): boolean {
  if (!rawUrl) return true;
  try {
    const normalized = normalizePublicBaseUrl(rawUrl);
    if (!normalized) return true;
    const { hostname } = new URL(normalized);
    const lower = hostname.toLowerCase();
    return (
      lower === 'localhost' ||
      lower === '127.0.0.1' ||
      lower === '0.0.0.0' ||
      lower === '::1' ||
      lower.endsWith('.local')
    );
  } catch {
    return true;
  }
}

/**
 * Xây dựng URL nhận sự kiện Webhook chuẩn SaaS (`/api/webhooks/omnichannel/:channelType`)
 * đảm bảo luôn có tiền tố `/api` khớp với `app.setGlobalPrefix('api')` trong `main.ts`
 * và không bao giờ bị trùng lặp `/api/api`.
 */
export function buildStandardWebhookCallbackUrl(baseOrigin: string, channelType: string): string {
  const normalizedBase = normalizePublicBaseUrl(baseOrigin) || 'http://localhost:3000';
  const cleanChannel = String(channelType || 'facebook_page')
    .trim()
    .toLowerCase();
  return `${normalizedBase}/api/webhooks/omnichannel/${cleanChannel}`;
}

/**
 * Khởi tạo bộ kiểm tra CORS đa nguồn (Multi-Origin & Dynamic Tunnel Validator)
 * dùng chung cho cả HTTP REST API (`main.ts`) và WebSocket (`SOCKET_CONFIG`).
 */
export function createDynamicCorsOriginValidator(params: {
  feUrl: string;
  appUrl: string;
  publicWebhookBaseUrl?: string | null;
  publicFrontendUrl?: string | null;
  extraAllowedOrigins?: string[];
  allowedDomainSuffixes?: string[];
  allowWildcardTunnelOrigin?: boolean;
}): CorsOptions['origin'] {
  const staticOrigins = new Set<string>();

  const registerStatic = (url?: string | null) => {
    const norm = normalizePublicBaseUrl(url);
    if (!norm) return;
    try {
      const u = new URL(norm);
      staticOrigins.add(u.origin.toLowerCase());
      tunnelOriginRegistry.registerOrigin(u.origin);
    } catch {
      // Bỏ qua URL lỗi
    }
  };

  registerStatic(params.feUrl);
  registerStatic(params.appUrl);
  registerStatic(params.publicWebhookBaseUrl);
  registerStatic(params.publicFrontendUrl);
  registerStatic('http://localhost:3000');
  registerStatic('http://localhost:3003');
  registerStatic('http://127.0.0.1:3000');
  registerStatic('http://127.0.0.1:3003');

  for (const extra of params.extraAllowedOrigins || []) {
    registerStatic(extra);
  }

  const suffixes = (
    params.allowedDomainSuffixes && params.allowedDomainSuffixes.length > 0
      ? params.allowedDomainSuffixes
      : DEFAULT_TUNNEL_DOMAIN_SUFFIXES
  ).map((s) => s.toLowerCase().trim());

  const allowWildcard = params.allowWildcardTunnelOrigin ?? true;

  return (
    requestOrigin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => {
    if (!requestOrigin) {
      return callback(null, true);
    }

    const cleanOrigin = requestOrigin.trim().toLowerCase().replace(/\/+$/, '');
    if (staticOrigins.has(cleanOrigin) || tunnelOriginRegistry.hasOrigin(cleanOrigin)) {
      return callback(null, true);
    }

    if (allowWildcard) {
      try {
        const parsed = new URL(cleanOrigin);
        const host = parsed.hostname.toLowerCase();
        if (
          suffixes.some((suffix) => host.endsWith(suffix) || host === suffix.replace(/^\./, ''))
        ) {
          tunnelOriginRegistry.registerOrigin(cleanOrigin);
          return callback(null, true);
        }
      } catch {
        // Không phải URL hợp lệ
      }
    }

    return callback(null, false);
  };
}

export function resolveProviderFromUrl(
  url?: string | null,
  explicitProvider?: string | null,
): TunnelProviderEnum {
  if (
    explicitProvider &&
    Object.values(TunnelProviderEnum).includes(explicitProvider.toUpperCase() as TunnelProviderEnum)
  ) {
    const candidate = explicitProvider.toUpperCase() as TunnelProviderEnum;
    if (candidate !== TunnelProviderEnum.NONE) {
      return candidate;
    }
  }

  const normalized = normalizePublicBaseUrl(url);
  if (!normalized || isLocalhostUrl(normalized)) {
    return TunnelProviderEnum.NONE;
  }

  const lower = normalized.toLowerCase();
  if (lower.includes('ngrok')) {
    return TunnelProviderEnum.NGROK;
  }
  if (lower.includes('trycloudflare.com') || lower.includes('cloudflare')) {
    return TunnelProviderEnum.CLOUDFLARE_TUNNEL;
  }
  return TunnelProviderEnum.CUSTOM_DOMAIN;
}
