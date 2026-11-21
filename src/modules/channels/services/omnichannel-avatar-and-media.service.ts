import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { ChannelTypeEnum } from 'src/common/enum';
import { envs } from 'src/config/envs/envs';
import { ChannelIntegrationEntity } from 'src/entity/channel-integration.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { MessageCryptoService } from 'src/modules/chat/services/message-crypto.service';
import { Repository } from 'typeorm';

export interface ResolvedBuyerProfileResult {
  name: string;
  avatarUrl: string;
  rawCdnAvatarUrl: string | null;
  hasRealAvatar: boolean;
  sourceLayer:
    | 'REDIS_CACHE'
    | 'META_PSID_PROFILE'
    | 'META_CONVERSATION_THREAD'
    | 'META_PSID_PICTURE_EDGE'
    | 'META_USER_PICTURE_DIRECT'
    | 'ZALO_OA_USER_DETAIL'
    | 'PLATFORM_PAYLOAD_URL'
    | 'INITIALS_SVG_FALLBACK';
}

export interface ProxiedBinaryMediaResult {
  buffer: Buffer;
  contentType: string;
  cacheControl: string;
  isFallbackAvatar?: boolean;
}

@Injectable()
export class OmnichannelAvatarAndMediaService {
  private readonly logger = new Logger(OmnichannelAvatarAndMediaService.name);

  constructor(
    @InjectRepository(ChannelIntegrationEntity)
    private readonly channelRepo: Repository<ChannelIntegrationEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRedis()
    private readonly redis: Redis,
    private readonly messageCryptoService: MessageCryptoService,
  ) {}

  private computeAppSecretProof(accessToken: string, appSecret?: string | null): string | null {
    const cleanToken = (accessToken || '').trim();
    const cleanSecret = (appSecret || '').trim();
    if (!cleanToken || !cleanSecret) return null;
    return crypto.createHmac('sha256', cleanSecret).update(cleanToken).digest('hex');
  }

  private normalizeGraphVersion(rawVersion?: string | null): string {
    const v = String(rawVersion || '').trim();
    if (/^v\d+\.\d+$/.test(v)) {
      const major = Number(v.slice(1).split('.')[0]);
      if (major >= 19 && major <= 25) return v;
    }
    return 'v22.0';
  }

  /**
   * Trả về đường dẫn tương đối ổn định để không bị chết ảnh mỗi khi đổi domain Tunnel/Ngrok.
   */
  public buildStableAvatarProxyPath(
    shopId: string,
    channelId: string,
    externalCustomerPsid: string,
  ): string {
    return `/api/channels/public-avatar/${encodeURIComponent(shopId)}/${encodeURIComponent(channelId)}/${encodeURIComponent(externalCustomerPsid)}`;
  }

  /**
   * Đăng ký URL media đính kèm (ảnh/sticker/video/audio từ Meta/IG/Zalo/Shopee/TikTok) vào Redis
   * để trình duyệt tải qua Proxy nội bộ, tránh lỗi hết hạn chữ ký `oe`/`oh` và chặn `Referer`.
   */
  public async registerProxiedMediaUrl(params: {
    shopId: string;
    channelId: string;
    sourceUrl: string;
    mimeType?: string;
    fileName?: string;
    externalMessageId?: string;
  }): Promise<string> {
    if (!params.sourceUrl || params.sourceUrl.startsWith('meta-like-sticker://')) {
      return params.sourceUrl;
    }
    if (params.sourceUrl.includes('/channels/public-media/')) {
      return params.sourceUrl;
    }

    const tokenHash = crypto
      .createHash('sha256')
      .update(`${params.shopId}:${params.channelId}:${params.sourceUrl}`)
      .digest('hex')
      .slice(0, 32);

    const metaKey = `omni_media_meta:${tokenHash}`;
    await this.redis
      .set(
        metaKey,
        JSON.stringify({
          shopId: params.shopId,
          channelId: params.channelId,
          sourceUrl: params.sourceUrl,
          mimeType: params.mimeType || 'application/octet-stream',
          fileName: params.fileName || 'attachment',
          externalMessageId: params.externalMessageId || null,
        }),
        'EX',
        7 * 86400,
      )
      .catch(() => null);

    return `/api/channels/public-media/${encodeURIComponent(params.shopId)}/${encodeURIComponent(params.channelId)}/${tokenHash}`;
  }

  public isExpiredMetaOrThirdPartyUrl(url?: string | null): boolean {
    if (!url || !url.trim()) return true;
    const trimmed = url.trim();
    if (trimmed.includes('api.dicebear.com')) return true;
    if (trimmed.includes('/channels/public-avatar/')) return false;

    try {
      const parsed = new URL(trimmed);
      const extParam = parsed.searchParams.get('ext');
      if (extParam) {
        const extSec = Number(extParam);
        if (Number.isFinite(extSec) && extSec > 0 && extSec * 1000 <= Date.now() + 60_000) {
          return true;
        }
      }
      const oeHex = parsed.searchParams.get('oe');
      if (oeHex && /^[0-9a-fA-F]+$/.test(oeHex)) {
        const oeSec = parseInt(oeHex, 16);
        if (Number.isFinite(oeSec) && oeSec > 0 && oeSec * 1000 <= Date.now() + 60_000) {
          return true;
        }
      }
    } catch {
      return true;
    }
    return false;
  }

  /**
   * Sinh ảnh đại diện SVG sắc nét dựa trên tên khách hàng (HTTP 200 OK thay vì 404 vỡ ảnh)
   * khi Meta Business Suite tạm ẩn `profile_pic` ở tin nhắn CTWA đầu tiên.
   */
  public buildInitialsSvgBuffer(displayName: string, seedFallback: string): Buffer {
    const clean = (displayName || seedFallback || 'KH').trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    const initials =
      parts.length >= 2
        ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
        : clean.slice(0, 2).toUpperCase();

    const palette = [
      ['#2563EB', '#4F46E5'],
      ['#059669', '#0D9488'],
      ['#D97706', '#EA580C'],
      ['#7C3AED', '#9333EA'],
      ['#DB2777', '#E11D48'],
      ['#0284C7', '#0369A1'],
    ];
    let hash = 0;
    for (let i = 0; i < clean.length; i++) {
      hash = (hash * 31 + clean.charCodeAt(i)) >>> 0;
    }
    const [c1, c2] = palette[hash % palette.length];
    const safeInitials = initials.replace(/[<>&"']/g, '');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="64" fill="url(#g)"/>
  <text x="64" y="68" text-anchor="middle" dominant-baseline="central" font-family="Inter,Arial,sans-serif" font-size="46" font-weight="700" fill="#FFFFFF">${safeInitials}</text>
</svg>`;
    return Buffer.from(svg, 'utf-8');
  }

  private async fetchGraphJson<T = any>(params: {
    apiVersion: string;
    path: string;
    queryParams?: Record<string, string>;
    accessToken: string;
    appSecret?: string | null;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; data: T | null; errorCode?: number; errorMessage?: string }> {
    const cleanToken = params.accessToken.trim().replace(/^Bearer\s+/i, '');
    const proof = this.computeAppSecretProof(cleanToken, params.appSecret);
    const timeoutMs = params.timeoutMs || 7000;

    const runAttempt = async (withProof: boolean) => {
      const qs = new URLSearchParams(params.queryParams || {});
      qs.set('access_token', cleanToken);
      if (withProof && proof) {
        qs.set('appsecret_proof', proof);
      }
      const url = `https://graph.facebook.com/${params.apiVersion}/${params.path.replace(/^\/+/, '')}?${qs.toString()}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal });
        clearTimeout(timer);
        const json = (await res.json().catch(() => ({}))) as any;
        if (res.ok && !json?.error) {
          return { ok: true as const, data: json as T };
        }
        return {
          ok: false as const,
          data: null,
          errorCode: Number(json?.error?.code || res.status),
          errorMessage: String(json?.error?.message || `HTTP ${res.status}`),
        };
      } catch (err) {
        clearTimeout(timer);
        return {
          ok: false as const,
          data: null,
          errorCode: 0,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
    };

    const first = await runAttempt(Boolean(proof));
    if (first.ok) return first;
    if (proof && first.errorMessage?.toLowerCase().includes('appsecret_proof')) {
      return runAttempt(false);
    }
    return first;
  }

  private async downloadImageBinary(
    targetUrl: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PancakeSellerOS/1.0)',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          ...(extraHeaders || {}),
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      if (!contentType.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 120) return null;
      return { buffer: buf, contentType };
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  /**
   * Pipeline 6 tầng lấy Tên thật & Avatar người mua cho TOÀN BỘ KÊNH:
   * - Facebook Page thường & Page chạy Quảng cáo (CTWA / Business Suite)
   * - Instagram Business
   * - Zalo OA (`GET https://openapi.zalo.me/v3.0/oa/user/detail`)
   * - Shopee / TikTok Shop / Lazada / Website Livechat (lưu & proxy URL ảnh từ payload)
   */
  public async resolveBuyerProfileAcrossChannels(params: {
    channel: ChannelIntegrationEntity;
    externalCustomerPsid: string | null;
    fallbackName: string;
    initialAvatarUrl?: string | null;
    forceRefresh?: boolean;
  }): Promise<ResolvedBuyerProfileResult> {
    const { channel, externalCustomerPsid, fallbackName, initialAvatarUrl, forceRefresh } = params;
    const stableProxyUrl = externalCustomerPsid
      ? this.buildStableAvatarProxyPath(channel.shopId, channel.id, externalCustomerPsid)
      : initialAvatarUrl || '';

    if (!externalCustomerPsid) {
      return {
        name: fallbackName,
        avatarUrl: initialAvatarUrl || '',
        rawCdnAvatarUrl: initialAvatarUrl || null,
        hasRealAvatar: Boolean(initialAvatarUrl),
        sourceLayer: initialAvatarUrl ? 'PLATFORM_PAYLOAD_URL' : 'INITIALS_SVG_FALLBACK',
      };
    }

    const profileCacheKey = `psid_profile_v2:${channel.id}:${externalCustomerPsid}`;
    const rawAvatarCacheKey = `psid_avatar_raw:${channel.id}:${externalCustomerPsid}`;

    if (!forceRefresh) {
      try {
        const cachedRaw = await this.redis.get(profileCacheKey);
        if (cachedRaw) {
          const parsed = JSON.parse(cachedRaw) as ResolvedBuyerProfileResult;
          if (parsed?.hasRealAvatar && !this.isExpiredMetaOrThirdPartyUrl(parsed.rawCdnAvatarUrl)) {
            return {
              ...parsed,
              name:
                !fallbackName.includes('#') && parsed.name.includes('#')
                  ? fallbackName
                  : parsed.name,
              avatarUrl: stableProxyUrl,
              sourceLayer: 'REDIS_CACHE',
            };
          }
        }
      } catch {
        // Tiếp tục truy vấn nguồn gốc khi Redis lỗi
      }
    }

    const rawToken = channel.accessTokenEncrypted
      ? this.messageCryptoService.decryptForConversation(
          channel.accessTokenEncrypted,
          channel.shopId,
        )
      : '';
    const rawAppSecret = channel.appSecretEncrypted
      ? this.messageCryptoService.decryptForConversation(channel.appSecretEncrypted, channel.shopId)
      : envs.omnichannelSaas.metaAppSecret || null;

    const isRealToken = Boolean(
      rawToken && !rawToken.startsWith('oauth2_tok_') && !rawToken.startsWith('sandbox_'),
    );

    let resolvedName = fallbackName;
    let resolvedRawUrl: string | null =
      initialAvatarUrl && !this.isExpiredMetaOrThirdPartyUrl(initialAvatarUrl)
        ? initialAvatarUrl
        : null;
    let sourceLayer: ResolvedBuyerProfileResult['sourceLayer'] = resolvedRawUrl
      ? 'PLATFORM_PAYLOAD_URL'
      : 'INITIALS_SVG_FALLBACK';

    // =========================================================================
    // NHÁNH 1: FACEBOOK FANPAGE (BAO GỒM PAGE CHẠY ADS / META BUSINESS SUITE) & INSTAGRAM
    // =========================================================================
    if (
      isRealToken &&
      (channel.channelType === ChannelTypeEnum.FACEBOOK_PAGE ||
        channel.channelType === ChannelTypeEnum.INSTAGRAM)
    ) {
      const apiVer = this.normalizeGraphVersion(channel.apiVersion);

      // Tầng 1: GET /{PSID}?fields=name,first_name,last_name,profile_pic
      const t1 = await this.fetchGraphJson<{
        name?: string;
        first_name?: string;
        last_name?: string;
        username?: string;
        profile_pic?: string;
      }>({
        apiVersion: apiVer,
        path: externalCustomerPsid,
        queryParams: {
          fields:
            channel.channelType === ChannelTypeEnum.INSTAGRAM
              ? 'name,username,profile_pic'
              : 'name,first_name,last_name,profile_pic',
        },
        accessToken: rawToken,
        appSecret: rawAppSecret,
      });

      if (t1.ok && t1.data) {
        const candidateName =
          t1.data.name ||
          [t1.data.first_name, t1.data.last_name].filter(Boolean).join(' ') ||
          t1.data.username;
        if (candidateName) resolvedName = candidateName;
        if (t1.data.profile_pic && !this.isExpiredMetaOrThirdPartyUrl(t1.data.profile_pic)) {
          resolvedRawUrl = t1.data.profile_pic;
          sourceLayer = 'META_PSID_PROFILE';
        }
      }

      // Tầng 2: Sửa lỗi Error #100 trên Page Business Suite / Ads — KHÔNG gọi `messages.from.picture`
      // mà tra cứu chuẩn `platform=messenger|instagram` + `participants` rồi đối chiếu `/{PSID}/picture`
      if ((resolvedName.includes('#') || !resolvedRawUrl) && channel.externalPageId) {
        const t2 = await this.fetchGraphJson<{
          data?: Array<{
            id?: string;
            participants?: { data?: Array<{ id?: string; name?: string; username?: string }> };
            senders?: { data?: Array<{ id?: string; name?: string; username?: string }> };
          }>;
        }>({
          apiVersion: apiVer,
          path: `${channel.externalPageId}/conversations`,
          queryParams: {
            platform: channel.channelType === ChannelTypeEnum.INSTAGRAM ? 'instagram' : 'messenger',
            user_id: externalCustomerPsid,
            fields:
              channel.channelType === ChannelTypeEnum.INSTAGRAM
                ? 'id,participants{id,name,username}'
                : 'id,participants{id,name},senders{id,name}',
            limit: '1',
          },
          accessToken: rawToken,
          appSecret: rawAppSecret,
        });

        const threadNode = t2.ok ? t2.data?.data?.[0] : null;
        if (threadNode) {
          const pool = [
            ...(threadNode.participants?.data || []),
            ...(threadNode.senders?.data || []),
          ];
          const buyer = pool.find(
            (p) =>
              p?.id &&
              (String(p.id) === externalCustomerPsid || String(p.id) !== channel.externalPageId),
          );
          if (buyer && (buyer.name || buyer.username) && resolvedName.includes('#')) {
            resolvedName = String(buyer.name || buyer.username);
          }
        }
      }

      // Tầng 3: GET /{PSID}/picture?type=large&redirect=false (có kèm appsecret_proof)
      if (!resolvedRawUrl) {
        const t3 = await this.fetchGraphJson<{
          data?: { url?: string; is_silhouette?: boolean };
        }>({
          apiVersion: apiVer,
          path: `${externalCustomerPsid}/picture`,
          queryParams: {
            type: 'large',
            redirect: 'false',
          },
          accessToken: rawToken,
          appSecret: rawAppSecret,
        });

        if (t3.ok && t3.data?.data?.url && !t3.data.data.is_silhouette) {
          resolvedRawUrl = t3.data.data.url;
          sourceLayer = 'META_PSID_PICTURE_EDGE';
        }
      }

      // Tầng 4 (Đặc trị Page Ads / Business Suite): Thử tải trực tiếp redirect binary `/{PSID}/picture`
      // với đầy đủ `access_token` + `appsecret_proof` trên Server (tránh lỗi JSON `is_silhouette` sai lệch ở 1 số cluster Meta)
      if (!resolvedRawUrl && channel.channelType === ChannelTypeEnum.FACEBOOK_PAGE) {
        const proof = this.computeAppSecretProof(rawToken, rawAppSecret);
        const qs = new URLSearchParams({
          type: 'large',
          access_token: rawToken,
          ...(proof ? { appsecret_proof: proof } : {}),
        });
        const directUrl = `https://graph.facebook.com/${apiVer}/${encodeURIComponent(externalCustomerPsid)}/picture?${qs.toString()}`;
        const directImg = await this.downloadImageBinary(directUrl);
        if (directImg) {
          await this.redis
            .set(
              `psid_avatar_bin:${channel.id}:${externalCustomerPsid}`,
              JSON.stringify({
                contentType: directImg.contentType,
                base64: directImg.buffer.toString('base64'),
              }),
              'EX',
              21600,
            )
            .catch(() => null);
          resolvedRawUrl = directUrl;
          sourceLayer = 'META_USER_PICTURE_DIRECT';
        }
      }
    }

    // =========================================================================
    // NHÁNH 2: ZALO OFFICIAL ACCOUNT (`GET https://openapi.zalo.me/v3.0/oa/user/detail`)
    // =========================================================================
    if (isRealToken && channel.channelType === ChannelTypeEnum.ZALO_OA) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      try {
        const zaloUrl = `https://openapi.zalo.me/v3.0/oa/user/detail?data=${encodeURIComponent(
          JSON.stringify({ user_id: externalCustomerPsid }),
        )}`;
        const res = await fetch(zaloUrl, {
          method: 'GET',
          headers: { access_token: rawToken },
          signal: controller.signal,
        });
        clearTimeout(timer);
        const json = (await res.json().catch(() => ({}))) as any;
        if (res.ok && Number(json?.error) === 0 && json?.data) {
          if (json.data.display_name) {
            resolvedName = String(json.data.display_name);
          }
          const zaloAvatar =
            json.data.avatars?.['240'] || json.data.avatars?.['120'] || json.data.avatar;
          if (zaloAvatar && typeof zaloAvatar === 'string') {
            resolvedRawUrl = zaloAvatar;
            sourceLayer = 'ZALO_OA_USER_DETAIL';
          }
        }
      } catch (err) {
        clearTimeout(timer);
        this.logger.debug(`Zalo OA user detail warning: ${String(err)}`);
      }
    }

    // =========================================================================
    // NHÁNH 3: SHOPEE / TIKTOK SHOP / LAZADA / WEBSITE LIVECHAT
    // Lưu URL ảnh gốc từ webhook vào Redis để phục vụ qua Proxy nội bộ (chống CORS/Referer)
    // =========================================================================
    const hasRealAvatar = Boolean(resolvedRawUrl && !resolvedRawUrl.includes('api.dicebear.com'));
    if (hasRealAvatar && resolvedRawUrl) {
      await this.redis.set(rawAvatarCacheKey, resolvedRawUrl, 'EX', 21600).catch(() => null);
      const result: ResolvedBuyerProfileResult = {
        name: resolvedName,
        avatarUrl: stableProxyUrl,
        rawCdnAvatarUrl: resolvedRawUrl,
        hasRealAvatar: true,
        sourceLayer,
      };
      await this.redis.set(profileCacheKey, JSON.stringify(result), 'EX', 21600).catch(() => null);
      return result;
    }

    // Chưa lấy được ảnh thật (VD: khách CTWA Ads vừa nhắn tin đầu tiên) → cache ngắn 90s để tự thử lại ở tin tiếp theo
    const fallbackResult: ResolvedBuyerProfileResult = {
      name: resolvedName,
      avatarUrl: stableProxyUrl,
      rawCdnAvatarUrl: null,
      hasRealAvatar: false,
      sourceLayer: 'INITIALS_SVG_FALLBACK',
    };
    await this.redis
      .set(profileCacheKey, JSON.stringify(fallbackResult), 'EX', 90)
      .catch(() => null);
    return fallbackResult;
  }

  /**
   * Phục vụ Avatar Proxy (`GET /api/channels/public-avatar/:shopId/:channelId/:psid`):
   * Luôn trả HTTP 200 OK (ảnh thật từ Redis/CDN hoặc SVG Initials sạch khi nền tảng tạm ẩn),
   * không bao giờ trả 404 làm vỡ giao diện danh sách chat.
   */
  public async getCustomerAvatarBinaryForProxy(params: {
    shopId: string;
    channelId: string;
    externalCustomerPsid: string;
  }): Promise<ProxiedBinaryMediaResult> {
    const binCacheKey = `psid_avatar_bin:${params.channelId}:${params.externalCustomerPsid}`;
    const rawUrlCacheKey = `psid_avatar_raw:${params.channelId}:${params.externalCustomerPsid}`;

    try {
      const cachedBin = await this.redis.get(binCacheKey);
      if (cachedBin) {
        const parsed = JSON.parse(cachedBin) as { contentType: string; base64: string };
        if (parsed?.base64) {
          return {
            buffer: Buffer.from(parsed.base64, 'base64'),
            contentType: parsed.contentType || 'image/jpeg',
            cacheControl: 'public, max-age=21600, stale-while-revalidate=86400',
          };
        }
      }
    } catch {
      // Bỏ qua lỗi đọc Redis
    }

    const channel = await this.channelRepo.findOne({
      where: { id: params.channelId, shopId: params.shopId },
    });

    const conv = await this.conversationRepo.findOne({
      where: {
        shopId: params.shopId,
        channelIntegrationId: params.channelId,
        externalThreadId: `inbox_${params.externalCustomerPsid}`,
      },
      select: ['id', 'name'],
    });
    const fallbackDisplayName = conv?.name || channel?.pageShortCode || 'KH';

    if (!channel) {
      return {
        buffer: this.buildInitialsSvgBuffer(fallbackDisplayName, params.externalCustomerPsid),
        contentType: 'image/svg+xml',
        cacheControl: 'public, max-age=120',
        isFallbackAvatar: true,
      };
    }

    let rawCdnUrl = await this.redis.get(rawUrlCacheKey).catch(() => null);
    if (!rawCdnUrl || this.isExpiredMetaOrThirdPartyUrl(rawCdnUrl)) {
      const refreshed = await this.resolveBuyerProfileAcrossChannels({
        channel,
        externalCustomerPsid: params.externalCustomerPsid,
        fallbackName: fallbackDisplayName,
        forceRefresh: true,
      });
      rawCdnUrl = refreshed.rawCdnAvatarUrl;

      // Kiểm tra lại binary cache vì Tầng 4 có thể vừa tải trực tiếp vào Redis
      const binAfterT4 = await this.redis.get(binCacheKey).catch(() => null);
      if (binAfterT4) {
        const parsed = JSON.parse(binAfterT4) as { contentType: string; base64: string };
        if (parsed?.base64) {
          return {
            buffer: Buffer.from(parsed.base64, 'base64'),
            contentType: parsed.contentType || 'image/jpeg',
            cacheControl: 'public, max-age=21600, stale-while-revalidate=86400',
          };
        }
      }
    }

    if (rawCdnUrl && !rawCdnUrl.includes('api.dicebear.com')) {
      const downloaded = await this.downloadImageBinary(rawCdnUrl);
      if (downloaded) {
        await this.redis
          .set(
            binCacheKey,
            JSON.stringify({
              contentType: downloaded.contentType,
              base64: downloaded.buffer.toString('base64'),
            }),
            'EX',
            21600,
          )
          .catch(() => null);
        return {
          buffer: downloaded.buffer,
          contentType: downloaded.contentType,
          cacheControl: 'public, max-age=21600, stale-while-revalidate=86400',
        };
      }
    }

    // Trả về SVG initials với cache ngắn 120s để trình duyệt tự thử lại sau khi khách Ads tương tác tiếp
    return {
      buffer: this.buildInitialsSvgBuffer(fallbackDisplayName, params.externalCustomerPsid),
      contentType: 'image/svg+xml',
      cacheControl: 'public, max-age=120',
      isFallbackAvatar: true,
    };
  }

  /**
   * Phục vụ Media Attachment Proxy (`GET /api/channels/public-media/:shopId/:channelId/:mediaToken`):
   * Cache binary ảnh/sticker/GIF/audio/file từ nền tảng ngoài (chống hết hạn chữ ký Meta CDN).
   */
  public async getAttachmentBinaryForProxy(params: {
    shopId: string;
    channelId: string;
    mediaToken: string;
  }): Promise<ProxiedBinaryMediaResult | null> {
    const metaKey = `omni_media_meta:${params.mediaToken}`;
    const binKey = `omni_media_bin:${params.mediaToken}`;

    const cachedBin = await this.redis.get(binKey).catch(() => null);
    if (cachedBin) {
      const parsed = JSON.parse(cachedBin) as { contentType: string; base64: string };
      if (parsed?.base64) {
        return {
          buffer: Buffer.from(parsed.base64, 'base64'),
          contentType: parsed.contentType || 'application/octet-stream',
          cacheControl: 'public, max-age=86400, immutable',
        };
      }
    }

    const metaRaw = await this.redis.get(metaKey).catch(() => null);
    if (!metaRaw) return null;

    const meta = JSON.parse(metaRaw) as {
      shopId: string;
      channelId: string;
      sourceUrl: string;
      mimeType: string;
    };
    if (meta.shopId !== params.shopId || meta.channelId !== params.channelId) {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(meta.sourceUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PancakeSellerOS/1.0)' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;

      const contentType = (
        res.headers.get('content-type') ||
        meta.mimeType ||
        'application/octet-stream'
      )
        .split(';')[0]
        .trim();
      const buffer = Buffer.from(await res.arrayBuffer());

      // Chỉ cache binary <= 4MB vào Redis để bảo vệ RAM
      if (buffer.length > 0 && buffer.length <= 4 * 1024 * 1024) {
        await this.redis
          .set(
            binKey,
            JSON.stringify({ contentType, base64: buffer.toString('base64') }),
            'EX',
            86400,
          )
          .catch(() => null);
      }

      return {
        buffer,
        contentType,
        cacheControl: 'public, max-age=86400',
      };
    } catch {
      clearTimeout(timer);
      return null;
    }
  }
}
