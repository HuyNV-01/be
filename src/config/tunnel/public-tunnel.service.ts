import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ChannelTypeEnum } from 'src/common/enum/permission.enum';
import { envs } from 'src/config/envs/envs';
import { INgrokDiscoveredTunnel, ITunnelStatusSnapshot } from 'src/config/tunnel/tunnel.interface';

import {
  buildStandardWebhookCallbackUrl,
  isLocalhostUrl,
  normalizePublicBaseUrl,
  resolveProviderFromUrl,
  tunnelOriginRegistry,
} from './tunnel.config';

interface NgrokApiTunnelsResponse {
  tunnels?: Array<{
    name?: string;
    public_url?: string;
    proto?: string;
    config?: {
      addr?: string;
    };
  }>;
}

/**
 * Dịch vụ hạ tầng cấp hệ thống (System-Level Public Tunnel & Domain Resolver).
 * Hoàn toàn tách biệt khỏi nghiệp vụ người dùng:
 * - Tự động phân giải Public Domain của dự án từ biến môi trường (`NGROK_DOMAIN`, `PUBLIC_WEBHOOK_BASE_URL`, `PUBLIC_FRONTEND_URL`)
 *   hoặc tự động phát hiện từ tiến trình Ngrok Agent trên máy chủ (`http://127.0.0.1:4040/api/tunnels`).
 * - Khi dự án chuyển từ Ngrok sang Cloudflare Tunnel hoặc Domain thật (Nginx/Cloudflare),
 *   chỉ cần thay đổi file `.env` mà không phải chỉnh sửa bất kỳ logic nghiệp vụ nào.
 */
@Injectable()
export class PublicTunnelService implements OnModuleInit {
  private readonly logger = new Logger(PublicTunnelService.name);
  private cachedNgrokDiscovery: {
    data: INgrokDiscoveredTunnel;
    expiresAt: number;
  } | null = null;

  async onModuleInit(): Promise<void> {
    if (envs.tunnel.publicWebhookBaseUrl) {
      tunnelOriginRegistry.setActivePublicBaseUrl(envs.tunnel.publicWebhookBaseUrl);
      this.logger.log(
        `Public Tunnel Gateway active via ENV [${envs.tunnel.provider}]: ${envs.tunnel.publicWebhookBaseUrl}`,
      );
      return;
    }

    if (envs.tunnel.autoDetectLocalAgent) {
      const discovered = await this.discoverLocalNgrokTunnel(true).catch(() => null);
      if (discovered?.detected && discovered.publicUrl) {
        this.logger.log(
          `Auto-detected active Ngrok Tunnel Agent: ${discovered.publicUrl} -> ${discovered.configAddr || 'localhost'}`,
        );
      } else {
        this.logger.log(
          `System running on Localhost (${envs.appUrl}). Set NGROK_DOMAIN in .env or run 'npm run tunnel:ngrok' to expose project to the internet.`,
        );
      }
    }
  }

  /**
   * Tự động dò tìm tiến trình Ngrok Agent trên máy chủ (`127.0.0.1:4040` hoặc `host.docker.internal:4040`)
   * trong trường hợp lập trình viên chạy lệnh `ngrok http` mà chưa điền cố định `NGROK_DOMAIN` trong `.env`.
   */
  async discoverLocalNgrokTunnel(forceRefresh = false): Promise<INgrokDiscoveredTunnel> {
    if (
      !forceRefresh &&
      this.cachedNgrokDiscovery &&
      this.cachedNgrokDiscovery.expiresAt > Date.now()
    ) {
      return this.cachedNgrokDiscovery.data;
    }

    const inspectCandidates = Array.from(
      new Set([
        envs.tunnel.ngrokInspectUrl,
        'http://127.0.0.1:4040',
        'http://localhost:4040',
        'http://host.docker.internal:4040',
      ]),
    );

    for (const baseInspectUrl of inspectCandidates) {
      const apiUrl = `${baseInspectUrl.replace(/\/+$/, '')}/api/tunnels`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);

      try {
        const res = await fetch(apiUrl, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        }).catch(() => null);
        clearTimeout(timer);

        if (!res || !res.ok) {
          continue;
        }

        const body = (await res.json().catch(() => ({}))) as NgrokApiTunnelsResponse;
        const tunnels = Array.isArray(body?.tunnels) ? body.tunnels : [];
        if (tunnels.length === 0) {
          continue;
        }

        const preferredHttps =
          tunnels.find(
            (t) =>
              t.public_url?.startsWith('https://') &&
              t.config?.addr &&
              String(t.config.addr).includes(String(envs.port)),
          ) ||
          tunnels.find((t) => t.public_url?.startsWith('https://')) ||
          tunnels[0];

        const normalizedUrl = normalizePublicBaseUrl(preferredHttps?.public_url);
        if (normalizedUrl) {
          tunnelOriginRegistry.setActivePublicBaseUrl(normalizedUrl);
          const result: INgrokDiscoveredTunnel = {
            detected: true,
            publicUrl: normalizedUrl,
            tunnelName: preferredHttps?.name || 'ngrok_http',
            proto: preferredHttps?.proto || 'https',
            configAddr: preferredHttps?.config?.addr || null,
            inspectUrl: baseInspectUrl,
            errorMessage: null,
          };
          this.cachedNgrokDiscovery = {
            data: result,
            expiresAt: Date.now() + 15000,
          };
          return result;
        }
      } catch {
        clearTimeout(timer);
      }
    }

    const fallbackResult: INgrokDiscoveredTunnel = {
      detected: false,
      publicUrl: null,
      tunnelName: null,
      proto: null,
      configAddr: null,
      inspectUrl: envs.tunnel.ngrokInspectUrl,
      errorMessage: null,
    };

    this.cachedNgrokDiscovery = {
      data: fallbackResult,
      expiresAt: Date.now() + 10000,
    };
    return fallbackResult;
  }

  /**
   * Trả về địa chỉ Public Base URL của Backend đồng bộ từ cấu hình hệ thống:
   * 1. `PUBLIC_WEBHOOK_BASE_URL` / `NGROK_DOMAIN` trong `.env`
   * 2. Địa chỉ Tunnel tự động phát hiện từ Ngrok Agent 4040 hoặc `X-Forwarded-Host`
   * 3. Fallback an toàn về `APP_URL` (`http://localhost:3000`)
   */
  getEffectivePublicBaseUrlSync(): string {
    if (envs.tunnel.publicWebhookBaseUrl) {
      return envs.tunnel.publicWebhookBaseUrl;
    }

    const activeDetected = tunnelOriginRegistry.getActivePublicBaseUrl();
    if (activeDetected && !isLocalhostUrl(activeDetected)) {
      return activeDetected;
    }

    return normalizePublicBaseUrl(envs.appUrl) || 'http://localhost:3000';
  }

  /**
   * Trả về địa chỉ Public Base URL của Backend (bất đồng bộ, có kết hợp tự động kiểm tra Ngrok 4040 nếu cần).
   */
  async getEffectivePublicBaseUrl(): Promise<string> {
    const syncResolved = this.getEffectivePublicBaseUrlSync();
    if (!isLocalhostUrl(syncResolved)) {
      return syncResolved;
    }

    if (envs.tunnel.autoDetectLocalAgent) {
      const discovered = await this.discoverLocalNgrokTunnel(false);
      if (discovered.detected && discovered.publicUrl) {
        return discovered.publicUrl;
      }
    }

    return syncResolved;
  }

  /**
   * Trả về địa chỉ Frontend hiệu lực (ưu tiên `PUBLIC_FRONTEND_URL` nếu có, ngược lại dùng `FE_URL`).
   */
  getEffectiveFrontendUrlSync(): string {
    if (envs.tunnel.publicFrontendUrl) {
      return envs.tunnel.publicFrontendUrl;
    }

    const activeFe = tunnelOriginRegistry.getActiveFrontendUrl();
    if (activeFe) {
      return activeFe;
    }

    return normalizePublicBaseUrl(envs.feUrl) || 'http://localhost:3003';
  }

  /**
   * Xây dựng URL nhận sự kiện Webhook chuẩn SaaS (`/api/webhooks/omnichannel/:channelType`)
   * theo tên miền công khai của hệ thống.
   */
  buildWebhookCallbackUrl(channelType: ChannelTypeEnum | string): string {
    const baseUrl = this.getEffectivePublicBaseUrlSync();
    return buildStandardWebhookCallbackUrl(baseUrl, channelType);
  }

  /**
   * Phân giải thông minh URL Webhook:
   * Nếu trong DB đang lưu URL cũ của `localhost` (do khởi tạo dự án lúc chưa bật Ngrok)
   * hoặc thiếu tiền tố `/api/webhooks/omnichannel`, tự động trả về URL theo tên miền công khai hiện tại của hệ thống.
   */
  resolveDynamicWebhookCallbackUrl(
    channelType: ChannelTypeEnum | string,
    storedCallbackUrl?: string | null,
  ): string {
    const liveWebhookUrl = this.buildWebhookCallbackUrl(channelType);
    if (!storedCallbackUrl || !storedCallbackUrl.trim()) {
      return liveWebhookUrl;
    }

    const activeBaseUrl = this.getEffectivePublicBaseUrlSync();
    const storedNormalizedBase = normalizePublicBaseUrl(storedCallbackUrl);

    if (
      !storedNormalizedBase ||
      isLocalhostUrl(storedNormalizedBase) ||
      !isLocalhostUrl(activeBaseUrl)
    ) {
      return liveWebhookUrl;
    }

    return buildStandardWebhookCallbackUrl(storedNormalizedBase, channelType);
  }

  async getTunnelStatusSnapshot(forceRefreshAgent = false): Promise<ITunnelStatusSnapshot> {
    const ngrokAgentStatus = await this.discoverLocalNgrokTunnel(forceRefreshAgent);
    const effectivePublicBaseUrl = await this.getEffectivePublicBaseUrl();
    const effectiveFrontendUrl = this.getEffectiveFrontendUrlSync();
    const isLocalhostMode = isLocalhostUrl(effectivePublicBaseUrl);
    const provider = resolveProviderFromUrl(effectivePublicBaseUrl, envs.tunnel.provider);

    const platforms: ChannelTypeEnum[] = [
      ChannelTypeEnum.FACEBOOK_PAGE,
      ChannelTypeEnum.INSTAGRAM,
      ChannelTypeEnum.ZALO_OA,
      ChannelTypeEnum.TIKTOK_SHOP,
      ChannelTypeEnum.SHOPEE,
      ChannelTypeEnum.LAZADA,
      ChannelTypeEnum.WEBSITE_LIVECHAT,
      ChannelTypeEnum.INTERNAL,
    ];

    const sampleWebhookUrls = {} as Record<ChannelTypeEnum, string>;
    for (const plat of platforms) {
      sampleWebhookUrls[plat] = buildStandardWebhookCallbackUrl(effectivePublicBaseUrl, plat);
    }

    return {
      provider,
      isPublicTunnelActive: !isLocalhostMode,
      isLocalhostMode,
      effectivePublicBaseUrl,
      effectiveFrontendUrl,
      configuredEnvBaseUrl: envs.tunnel.publicWebhookBaseUrl,
      configuredNgrokDomain: envs.tunnel.ngrokDomain,
      autoDetectedTunnelUrl: ngrokAgentStatus.publicUrl,
      ngrokAgentStatus,
      sampleWebhookUrls,
    };
  }
}
