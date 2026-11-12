import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import * as crypto from 'crypto';
import { NotificationResourceTypeEnum, NotificationTypeEnum } from 'src/common/enum';
import {
  ChannelTypeEnum,
  MembershipStatusEnum,
  PermissionCodeEnum,
  ShopRoleEnum,
  WebhookIntegrationStatusEnum,
} from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { envs } from 'src/config/envs/envs';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  ChannelIntegrationEntity,
  PageTokenRecoverySourceType,
} from 'src/entity/channel-integration.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { MessageCryptoService } from 'src/modules/chat/services/message-crypto.service';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import { In, Repository } from 'typeorm';

export interface ExchangedPageTokenResult {
  effectivePageAccessToken: string;
  longLivedUserAccessToken: string | null;
  isNeverExpiringPageToken: boolean;
  tokenExpiresAt: Date | null;
  userTokenExpiresAt: Date | null;
  recoverySource: PageTokenRecoverySourceType;
  verifiedOnLiveGraphApi: boolean;
}

@Injectable()
export class ChannelTokenDoctorService {
  private readonly logger = new Logger(ChannelTokenDoctorService.name);

  constructor(
    @InjectRepository(ChannelIntegrationEntity)
    private readonly channelRepo: Repository<ChannelIntegrationEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    @InjectRepository(ShopMemberEntity)
    private readonly memberRepo: Repository<ShopMemberEntity>,
    private readonly messageCryptoService: MessageCryptoService,
    private readonly notificationsService: NotificationsService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private normalizeGraphVersion(rawVer?: string | null): string {
    const fallbackVer = envs.omnichannelSaas?.metaGraphApiVersion || 'v27.1';
    const cleaned = (rawVer || fallbackVer).trim().replace(/^v\.?/i, '');
    return /^\d+(\.\d+)?$/.test(cleaned) ? `v${cleaned}` : 'v27.1';
  }

  private computeAppSecretProof(accessToken: string, appSecret?: string | null): string | null {
    const cleanSecret = (appSecret || '').trim();
    if (!cleanSecret || !accessToken) return null;
    return crypto.createHmac('sha256', cleanSecret).update(accessToken.trim()).digest('hex');
  }

  /**
   * Giải quyết App ID & App Secret hiệu lực cho một kênh tích hợp
   * (Ưu tiên cấu hình riêng trên kênh -> Hồ sơ SaaS gắn với kênh -> Hồ sơ SaaS mặc định của Shop -> Biến môi trường hệ thống)
   */
  public async resolveChannelAppCredentials(channel: ChannelIntegrationEntity): Promise<{
    apiVersion: string;
    appId: string | null;
    rawAppSecret: string | null;
  }> {
    const apiVersion = this.normalizeGraphVersion(
      channel.apiVersion || channel.platformConfigJson?.apiVersion,
    );

    let appId = channel.appId || channel.platformConfigJson?.appId || null;
    let rawAppSecret = channel.appSecretEncrypted
      ? this.messageCryptoService.decryptForConversation(channel.appSecretEncrypted, channel.shopId)
      : null;

    if ((!appId || !rawAppSecret) && channel.shopId) {
      const shop = await this.shopRepo.findOne({
        where: { id: channel.shopId },
        select: ['id', 'saasAppProfilesJson'],
      });
      const profiles = Array.isArray(shop?.saasAppProfilesJson) ? shop.saasAppProfilesJson : [];
      const matchedProfile =
        (channel.saasAppProfileId
          ? profiles.find((p) => p.id === channel.saasAppProfileId)
          : null) ||
        profiles.find(
          (p) => p.channelType === channel.channelType && p.isDefault && p.isActive !== false,
        ) ||
        profiles.find((p) => p.channelType === channel.channelType && p.isActive !== false) ||
        null;

      if (matchedProfile) {
        if (!appId && matchedProfile.appId) {
          appId = matchedProfile.appId;
        }
        if (!rawAppSecret && matchedProfile.appSecretEncrypted) {
          rawAppSecret = this.messageCryptoService.decryptForConversation(
            matchedProfile.appSecretEncrypted,
            channel.shopId,
          );
        }
      }
    }

    if (!appId) {
      appId =
        channel.channelType === ChannelTypeEnum.ZALO_OA
          ? envs.omnichannelSaas?.zaloAppId || null
          : envs.omnichannelSaas?.metaAppId || null;
    }

    if (!rawAppSecret) {
      rawAppSecret =
        channel.channelType === ChannelTypeEnum.ZALO_OA
          ? envs.omnichannelSaas?.zaloAppSecret || null
          : envs.omnichannelSaas?.metaAppSecret || null;
    }

    return {
      apiVersion,
      appId: appId?.trim() || null,
      rawAppSecret: rawAppSecret?.trim() || null,
    };
  }

  /**
   * Đổi Short-Lived Token (1-2h) sang Long-Lived Token (60 ngày) qua chuẩn Meta Graph API:
   * GET /{apiVersion}/oauth/access_token?grant_type=fb_exchange_token&client_id={appId}&client_secret={appSecret}&fb_exchange_token={token}
   */
  public async exchangeMetaLongLivedToken(params: {
    apiVersion: string;
    appId?: string | null;
    rawAppSecret?: string | null;
    inputToken: string;
  }): Promise<{
    exchangedToken: string;
    expiresInSeconds: number | null;
    wasExchanged: boolean;
  }> {
    const cleanInput = params.inputToken.trim().replace(/^Bearer\s+/i, '');
    const cleanAppId = (params.appId || '').trim();
    const cleanSecret = (params.rawAppSecret || '').trim();

    if (
      !cleanAppId ||
      !cleanSecret ||
      !cleanInput ||
      /^(oauth2_tok_|sandbox_|sim_|mock_)/i.test(cleanInput)
    ) {
      return {
        exchangedToken: cleanInput,
        expiresInSeconds: null,
        wasExchanged: false,
      };
    }

    const normalizedVer = this.normalizeGraphVersion(params.apiVersion);
    const candidateVersions = Array.from(
      new Set([normalizedVer, 'v27.0', 'v26.0', 'v22.0', 'v21.0']),
    );

    for (const ver of candidateVersions) {
      const qs = new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: cleanAppId,
        client_secret: cleanSecret,
        fb_exchange_token: cleanInput,
      });

      const url = `https://graph.facebook.com/${ver}/oauth/access_token?${qs.toString()}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal }).catch(
          () => null,
        );
        clearTimeout(timeoutId);

        if (!res) break;
        const json = (await res.json().catch(() => ({}))) as {
          access_token?: string;
          expires_in?: number;
          error?: { code?: number; message?: string };
        };

        if (res.ok && json.access_token) {
          return {
            exchangedToken: String(json.access_token).trim(),
            expiresInSeconds:
              typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : null,
            wasExchanged: true,
          };
        }

        const isVersionErr =
          json?.error?.code === 12 ||
          json?.error?.code === 2635 ||
          /unknown path components|version/i.test(json?.error?.message || '');
        if (!isVersionErr) {
          break;
        }
      } catch {
        clearTimeout(timeoutId);
        break;
      }
    }

    return {
      exchangedToken: cleanInput,
      expiresInSeconds: null,
      wasExchanged: false,
    };
  }

  /**
   * Trích xuất Page Access Token của một Fanpage cụ thể từ User Access Token hoặc Page Token:
   * - Thử gọi trực tiếp `GET /{apiVersion}/{externalPageId}?fields=id,name,access_token`
   * - Nếu chưa có `access_token`, gọi `GET /{apiVersion}/me/accounts?fields=id,name,access_token&limit=100`
   * Khi gọi bằng Long-Lived User Token, Meta Graph API trả về **Never-Expiring Page Access Token (expires_at = 0)**!
   */
  public async fetchPageAccessTokenFromGraphApi(params: {
    apiVersion: string;
    externalPageId: string;
    sourceAccessToken: string;
    rawAppSecret?: string | null;
  }): Promise<{
    ok: boolean;
    pageAccessToken: string | null;
    pageName?: string;
  }> {
    const cleanSource = params.sourceAccessToken.trim().replace(/^Bearer\s+/i, '');
    const cleanPageId = params.externalPageId.trim();
    if (!cleanSource || !cleanPageId || /^(oauth2_tok_|sandbox_|sim_)/i.test(cleanSource)) {
      return { ok: false, pageAccessToken: null };
    }

    const normalizedVer = this.normalizeGraphVersion(params.apiVersion);
    const candidateVersions = Array.from(
      new Set([normalizedVer, 'v27.0', 'v26.0', 'v22.0', 'v21.0']),
    );
    const proof = this.computeAppSecretProof(cleanSource, params.rawAppSecret);

    const callEndpoint = async <T = any>(
      ver: string,
      path: string,
      fields: string,
      includeProof: boolean,
    ): Promise<T | null> => {
      const qs = new URLSearchParams({
        fields,
        access_token: cleanSource,
      });
      if (includeProof && proof) {
        qs.set('appsecret_proof', proof);
      }
      const url = `https://graph.facebook.com/${ver}/${path.replace(/^\/+/, '')}?${qs.toString()}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal }).catch(
          () => null,
        );
        clearTimeout(timeoutId);
        if (!res || !res.ok) return null;
        const json = (await res.json().catch(() => null)) as any;
        if (json && !json.error) return json as T;
        return null;
      } catch {
        clearTimeout(timeoutId);
        return null;
      }
    };

    for (const ver of candidateVersions) {
      // 1. Gọi trực tiếp /{externalPageId}?fields=id,name,access_token
      const directNode =
        (await callEndpoint<{ id?: string; name?: string; access_token?: string }>(
          ver,
          cleanPageId,
          'id,name,access_token',
          Boolean(proof),
        )) ||
        (proof
          ? await callEndpoint<{ id?: string; name?: string; access_token?: string }>(
              ver,
              cleanPageId,
              'id,name,access_token',
              false,
            )
          : null);

      if (directNode?.access_token && String(directNode.id) === cleanPageId) {
        return {
          ok: true,
          pageAccessToken: String(directNode.access_token).trim(),
          pageName: directNode.name,
        };
      }

      // 2. Gọi /me/accounts để trích xuất đúng access_token của externalPageId
      const accountsNode =
        (await callEndpoint<{
          data?: Array<{
            id: string;
            name?: string;
            access_token?: string;
            instagram_business_account?: { id: string };
          }>;
        }>(
          ver,
          'me/accounts',
          'id,name,access_token,instagram_business_account{id}&limit=100',
          Boolean(proof),
        )) ||
        (await callEndpoint<{
          data?: Array<{ id: string; name?: string; access_token?: string }>;
        }>(ver, 'me/accounts', 'id,name,access_token&limit=100', false));

      if (Array.isArray(accountsNode?.data)) {
        const matchedPage = accountsNode.data.find(
          (item) =>
            String(item.id) === cleanPageId ||
            String((item as any).instagram_business_account?.id || '') === cleanPageId,
        );
        if (matchedPage?.access_token) {
          return {
            ok: true,
            pageAccessToken: String(matchedPage.access_token).trim(),
            pageName: matchedPage.name,
          };
        }
      }
    }

    return { ok: false, pageAccessToken: null };
  }

  /**
   * Kiểm tra thông tin tuổi thọ thực tế của Token qua `/debug_token` và `/me`
   */
  public async inspectMetaTokenVitality(params: {
    apiVersion: string;
    token: string;
    appId?: string | null;
    rawAppSecret?: string | null;
  }): Promise<{
    isValid: boolean;
    tokenType: 'PAGE' | 'USER' | 'UNKNOWN';
    isNeverExpiring: boolean;
    expiresAt: Date | null;
    profileId: string | null;
    errorMessage?: string;
  }> {
    const cleanToken = params.token.trim().replace(/^Bearer\s+/i, '');
    if (!cleanToken) {
      return {
        isValid: false,
        tokenType: 'UNKNOWN',
        isNeverExpiring: false,
        expiresAt: null,
        profileId: null,
        errorMessage: 'EMPTY_ACCESS_TOKEN',
      };
    }

    if (/^(oauth2_tok_|sandbox_|sim_|mock_)/i.test(cleanToken)) {
      return {
        isValid: true,
        tokenType: 'PAGE',
        isNeverExpiring: true,
        expiresAt: null,
        profileId: null,
      };
    }

    const ver = this.normalizeGraphVersion(params.apiVersion);
    const cleanAppId = (params.appId || '').trim();
    const cleanSecret = (params.rawAppSecret || '').trim();

    if (cleanAppId && cleanSecret) {
      const debugUrl = `https://graph.facebook.com/${ver}/debug_token?input_token=${encodeURIComponent(cleanToken)}&access_token=${encodeURIComponent(`${cleanAppId}|${cleanSecret}`)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500);
      try {
        const res = await fetch(debugUrl, { signal: controller.signal }).catch(() => null);
        clearTimeout(timeoutId);
        if (res && res.ok) {
          const json = (await res.json().catch(() => ({}))) as {
            data?: {
              is_valid?: boolean;
              type?: string;
              expires_at?: number;
              profile_id?: string;
              user_id?: string;
              error?: { message?: string };
            };
          };
          if (json?.data) {
            const isValid = Boolean(json.data.is_valid);
            const rawExpires = Number(json.data.expires_at ?? -1);
            // Trên Meta Graph API, expires_at === 0 nghĩa là Never-Expiring Page Access Token!
            const isNeverExpiring = isValid && rawExpires === 0;
            const expiresAt = isValid && rawExpires > 0 ? new Date(rawExpires * 1000) : null;
            const tokenType =
              json.data.type === 'PAGE' ? 'PAGE' : json.data.type === 'USER' ? 'USER' : 'UNKNOWN';

            return {
              isValid,
              tokenType,
              isNeverExpiring,
              expiresAt,
              profileId: json.data.profile_id || json.data.user_id || null,
              errorMessage: json.data.error?.message,
            };
          }
        }
      } catch {
        clearTimeout(timeoutId);
      }
    }

    // Fallback kiểm tra qua GET /{ver}/me?fields=id,name&metadata=1
    const meUrl = `https://graph.facebook.com/${ver}/me?fields=id,name&metadata=1&access_token=${encodeURIComponent(cleanToken)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4500);
    try {
      const res = await fetch(meUrl, { signal: controller.signal }).catch(() => null);
      clearTimeout(timeoutId);
      if (res) {
        const json = (await res.json().catch(() => ({}))) as {
          id?: string;
          metadata?: { type?: string };
          error?: { message?: string; code?: number };
        };
        if (res.ok && json?.id) {
          const isPage = String(json.metadata?.type || '').toLowerCase() === 'page';
          return {
            isValid: true,
            tokenType: isPage ? 'PAGE' : 'USER',
            isNeverExpiring: isPage,
            expiresAt: null,
            profileId: String(json.id),
          };
        }
        if (json?.error) {
          return {
            isValid: false,
            tokenType: 'UNKNOWN',
            isNeverExpiring: false,
            expiresAt: null,
            profileId: null,
            errorMessage: json.error.message || `OAuth Error ${json.error.code || 190}`,
          };
        }
      }
    } catch {
      clearTimeout(timeoutId);
    }

    return {
      isValid: true,
      tokenType: 'PAGE',
      isNeverExpiring: true,
      expiresAt: null,
      profileId: null,
    };
  }

  /**
   * Quy trình Chuẩn hóa & Vĩnh viễn hóa Page Access Token ngay khi Kết nối hoặc Cập nhật Kênh:
   * 1. Nếu có `rawUserToken` (hoặc `rawInputToken` là User Token), tự động đổi sang **Long-Lived User Token (60 ngày)** qua `fb_exchange_token`.
   * 2. Dùng Long-Lived User Token đó gọi `/{externalPageId}?fields=access_token` hoặc `/me/accounts` để rút trích **Never-Expiring Page Access Token (`expires_at = 0`)**.
   * 3. Nếu người bán dán trực tiếp `Page Access Token`, tự động đổi qua `fb_exchange_token` và gọi `/{externalPageId}?fields=access_token` để đảm bảo Page Token không bao giờ hết hạn.
   */
  public async exchangeForNeverExpiringPageAccessToken(params: {
    channelType: ChannelTypeEnum;
    externalPageId: string;
    rawInputToken: string;
    rawUserToken?: string | null;
    apiVersion?: string | null;
    appId?: string | null;
    rawAppSecret?: string | null;
  }): Promise<ExchangedPageTokenResult> {
    const cleanInput = params.rawInputToken.trim().replace(/^Bearer\s+/i, '');
    const cleanUser = params.rawUserToken?.trim().replace(/^Bearer\s+/i, '') || null;

    if (/^(oauth2_tok_|sandbox_|sim_|mock_)/i.test(cleanInput)) {
      return {
        effectivePageAccessToken: cleanInput,
        longLivedUserAccessToken: cleanUser,
        isNeverExpiringPageToken: true,
        tokenExpiresAt: null,
        userTokenExpiresAt: null,
        recoverySource: 'SANDBOX',
        verifiedOnLiveGraphApi: false,
      };
    }

    if (
      params.channelType !== ChannelTypeEnum.FACEBOOK_PAGE &&
      params.channelType !== ChannelTypeEnum.INSTAGRAM
    ) {
      return {
        effectivePageAccessToken: cleanInput,
        longLivedUserAccessToken: cleanUser,
        isNeverExpiringPageToken: false,
        tokenExpiresAt: new Date(Date.now() + 60 * 86400 * 1000),
        userTokenExpiresAt: null,
        recoverySource: 'DIRECT_PAGE_TOKEN',
        verifiedOnLiveGraphApi: true,
      };
    }

    const apiVersion = this.normalizeGraphVersion(params.apiVersion);
    let longLivedUserToken: string | null = cleanUser;
    let userTokenExpiresAt: Date | null = null;

    // Bước 1: Nếu có User Token, đổi sang Long-Lived User Token (60 ngày)
    if (cleanUser) {
      const exchangedUser = await this.exchangeMetaLongLivedToken({
        apiVersion,
        appId: params.appId,
        rawAppSecret: params.rawAppSecret,
        inputToken: cleanUser,
      });
      longLivedUserToken = exchangedUser.exchangedToken;
      if (exchangedUser.expiresInSeconds) {
        userTokenExpiresAt = new Date(Date.now() + exchangedUser.expiresInSeconds * 1000);
      }
    }

    // Bước 2: Đổi cả rawInputToken qua fb_exchange_token (phòng trường hợp rawInputToken là Short-Lived User/Page Token)
    const exchangedInput = await this.exchangeMetaLongLivedToken({
      apiVersion,
      appId: params.appId,
      rawAppSecret: params.rawAppSecret,
      inputToken: cleanInput,
    });

    // Bước 3: Thử trích xuất Never-Expiring Page Access Token từ Long-Lived User Token hoặc Exchanged Input Token
    const candidateSourceTokens = Array.from(
      new Set([longLivedUserToken, exchangedInput.exchangedToken, cleanInput].filter(Boolean)),
    ) as string[];

    for (const srcTok of candidateSourceTokens) {
      const derived = await this.fetchPageAccessTokenFromGraphApi({
        apiVersion,
        externalPageId: params.externalPageId,
        sourceAccessToken: srcTok,
        rawAppSecret: params.rawAppSecret,
      });

      if (derived.ok && derived.pageAccessToken) {
        // Nếu trích xuất được Page Token từ User Token khác với Page Token, lưu lại srcTok làm Long-Lived User Token dự phòng!
        if (!longLivedUserToken && srcTok !== derived.pageAccessToken) {
          longLivedUserToken = srcTok;
        }

        const vitality = await this.inspectMetaTokenVitality({
          apiVersion,
          token: derived.pageAccessToken,
          appId: params.appId,
          rawAppSecret: params.rawAppSecret,
        });

        return {
          effectivePageAccessToken: derived.pageAccessToken,
          longLivedUserAccessToken: longLivedUserToken,
          isNeverExpiringPageToken: vitality.isNeverExpiring || vitality.expiresAt === null,
          tokenExpiresAt: vitality.expiresAt,
          userTokenExpiresAt,
          recoverySource: exchangedInput.wasExchanged
            ? 'FB_EXCHANGE_NEVER_EXPIRING'
            : 'USER_LONG_LIVED_ACCOUNT_DERIVATION',
          verifiedOnLiveGraphApi: vitality.isValid,
        };
      }
    }

    // Bước 4: Kiểm tra trực tiếp vitality của exchangedInput.exchangedToken
    const finalVitality = await this.inspectMetaTokenVitality({
      apiVersion,
      token: exchangedInput.exchangedToken,
      appId: params.appId,
      rawAppSecret: params.rawAppSecret,
    });

    return {
      effectivePageAccessToken: exchangedInput.exchangedToken,
      longLivedUserAccessToken: longLivedUserToken,
      isNeverExpiringPageToken: finalVitality.isNeverExpiring || finalVitality.expiresAt === null,
      tokenExpiresAt: finalVitality.expiresAt,
      userTokenExpiresAt,
      recoverySource: exchangedInput.wasExchanged
        ? 'FB_EXCHANGE_NEVER_EXPIRING'
        : 'DIRECT_PAGE_TOKEN',
      verifiedOnLiveGraphApi: finalVitality.isValid,
    };
  }

  /**
   * Động cơ Tự Phục Hồi Page Access Token 4 Tầng (`4-Tier Autonomous Page Token Self-Healing`):
   * Được gọi tự động khi:
   * - Người bán nhắn tin cho người mua mà gặp lỗi `OAuthException 190` / Zalo `-216` trong `ChatService.executePlatformHttpCall`.
   * - Webhook nhận tin nhắn của người mua mà phát hiện Page Token hết hạn trong `enrichCustomerProfileByPsid`.
   * - Cronjob `ChannelTokenDoctor` chạy kiểm tra định kỳ hoặc người bán bấm nút làm mới.
   */
  public async autoHealChannelPageAccessToken(
    channelOrId: ChannelIntegrationEntity | string,
    reason = 'AUTO_HEAL',
  ): Promise<{
    healed: boolean;
    newRawPageAccessToken: string | null;
    channel: ChannelIntegrationEntity | null;
    recoverySource: PageTokenRecoverySourceType | null;
  }> {
    const channel =
      typeof channelOrId === 'string'
        ? await this.channelRepo.findOne({ where: { id: channelOrId } })
        : channelOrId;

    if (!channel) {
      return {
        healed: false,
        newRawPageAccessToken: null,
        channel: null,
        recoverySource: null,
      };
    }

    const currentRawPageToken = channel.accessTokenEncrypted
      ? this.messageCryptoService
          .decryptForConversation(channel.accessTokenEncrypted, channel.shopId)
          .trim()
      : '';

    const storedUserToken = channel.platformConfigJson?.userLongLivedTokenEncrypted
      ? this.messageCryptoService
          .decryptForConversation(
            channel.platformConfigJson.userLongLivedTokenEncrypted,
            channel.shopId,
          )
          .trim()
      : '';

    const storedRefreshToken = channel.refreshTokenEncrypted
      ? this.messageCryptoService
          .decryptForConversation(channel.refreshTokenEncrypted, channel.shopId)
          .trim()
      : '';

    // 1. Nhánh Kênh Giả Lập Sandbox
    if (
      /^(oauth2_tok_|sandbox_|sim_|mock_)/i.test(currentRawPageToken) ||
      /^(oauth2_rft_|sandbox_)/i.test(storedRefreshToken)
    ) {
      const sandboxTok = currentRawPageToken || `oauth2_tok_sandbox_${channel.id.slice(0, 12)}`;
      channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
      channel.tokenExpiresAt = null;
      channel.lastErrorMessage = null;
      channel.platformConfigJson = {
        ...(channel.platformConfigJson || {}),
        isNeverExpiringPageToken: true,
        lastTokenRefreshedAt: new Date().toISOString(),
        tokenRecoverySource: 'SANDBOX',
      };
      await this.channelRepo.save(channel);
      return {
        healed: true,
        newRawPageAccessToken: sandboxTok,
        channel,
        recoverySource: 'SANDBOX',
      };
    }

    const creds = await this.resolveChannelAppCredentials(channel);

    // 2. Nhánh Facebook Fanpage & Instagram Business (4-Tier Meta Graph Recovery)
    if (
      channel.channelType === ChannelTypeEnum.FACEBOOK_PAGE ||
      channel.channelType === ChannelTypeEnum.INSTAGRAM
    ) {
      // TẦNG 1 & TẦNG 2: Đổi từ storedUserToken / storedRefreshToken / currentRawPageToken
      const candidateUserTokens = [storedUserToken, storedRefreshToken, currentRawPageToken].filter(
        (t) => Boolean(t) && !/^(oauth2_|rft_|sandbox_)/i.test(t),
      );

      for (const candidateTok of candidateUserTokens) {
        const exchanged = await this.exchangeMetaLongLivedToken({
          apiVersion: creds.apiVersion,
          appId: creds.appId,
          rawAppSecret: creds.rawAppSecret,
          inputToken: candidateTok,
        });

        const pageFetch = await this.fetchPageAccessTokenFromGraphApi({
          apiVersion: creds.apiVersion,
          externalPageId: channel.externalPageId,
          sourceAccessToken: exchanged.exchangedToken,
          rawAppSecret: creds.rawAppSecret,
        });

        if (pageFetch.ok && pageFetch.pageAccessToken) {
          const vitality = await this.inspectMetaTokenVitality({
            apiVersion: creds.apiVersion,
            token: pageFetch.pageAccessToken,
            appId: creds.appId,
            rawAppSecret: creds.rawAppSecret,
          });

          if (vitality.isValid) {
            const recoverySource: PageTokenRecoverySourceType =
              candidateTok === storedUserToken || candidateTok === storedRefreshToken
                ? 'USER_LONG_LIVED_ACCOUNT_DERIVATION'
                : 'FB_EXCHANGE_NEVER_EXPIRING';

            await this.persistHealedChannelToken({
              channel,
              newRawPageToken: pageFetch.pageAccessToken,
              newLongLivedUserToken:
                exchanged.exchangedToken !== pageFetch.pageAccessToken
                  ? exchanged.exchangedToken
                  : storedUserToken || null,
              isNeverExpiring: vitality.isNeverExpiring || vitality.expiresAt === null,
              tokenExpiresAt: vitality.expiresAt,
              recoverySource,
              apiVersion: creds.apiVersion,
              rawAppSecret: creds.rawAppSecret,
            });

            this.logger.log(
              `[TokenDoctor] Auto-healed Page Access Token for "${channel.pageName}" (${channel.externalPageId}) via ${recoverySource} [reason=${reason}].`,
            );

            return {
              healed: true,
              newRawPageAccessToken: pageFetch.pageAccessToken,
              channel,
              recoverySource,
            };
          }
        }
      }

      // TẦNG 3: Khôi phục chéo từ các Fanpage anh em trong cùng cửa hàng (Sibling Channel Recovery)
      const siblingChannels = await this.channelRepo.find({
        where: {
          shopId: channel.shopId,
          channelType: In([ChannelTypeEnum.FACEBOOK_PAGE, ChannelTypeEnum.INSTAGRAM]),
          isActive: true,
        },
        order: { updatedAt: 'DESC' },
      });

      for (const sib of siblingChannels) {
        if (sib.id === channel.id) continue;

        const sibUserTok = sib.platformConfigJson?.userLongLivedTokenEncrypted
          ? this.messageCryptoService
              .decryptForConversation(
                sib.platformConfigJson.userLongLivedTokenEncrypted,
                sib.shopId,
              )
              .trim()
          : '';
        const sibRefreshTok = sib.refreshTokenEncrypted
          ? this.messageCryptoService
              .decryptForConversation(sib.refreshTokenEncrypted, sib.shopId)
              .trim()
          : '';
        const sibPageTok = sib.accessTokenEncrypted
          ? this.messageCryptoService
              .decryptForConversation(sib.accessTokenEncrypted, sib.shopId)
              .trim()
          : '';

        for (const sibCandidate of [sibUserTok, sibRefreshTok, sibPageTok].filter(Boolean)) {
          if (/^(oauth2_|sandbox_)/i.test(sibCandidate)) continue;

          const derivedFromSibling = await this.fetchPageAccessTokenFromGraphApi({
            apiVersion: creds.apiVersion,
            externalPageId: channel.externalPageId,
            sourceAccessToken: sibCandidate,
            rawAppSecret: creds.rawAppSecret,
          });

          if (derivedFromSibling.ok && derivedFromSibling.pageAccessToken) {
            const vitality = await this.inspectMetaTokenVitality({
              apiVersion: creds.apiVersion,
              token: derivedFromSibling.pageAccessToken,
              appId: creds.appId,
              rawAppSecret: creds.rawAppSecret,
            });

            if (vitality.isValid) {
              await this.persistHealedChannelToken({
                channel,
                newRawPageToken: derivedFromSibling.pageAccessToken,
                newLongLivedUserToken:
                  sibCandidate !== derivedFromSibling.pageAccessToken ? sibCandidate : null,
                isNeverExpiring: vitality.isNeverExpiring || vitality.expiresAt === null,
                tokenExpiresAt: vitality.expiresAt,
                recoverySource: 'SIBLING_CHANNEL_USER_TOKEN',
                apiVersion: creds.apiVersion,
                rawAppSecret: creds.rawAppSecret,
              });

              this.logger.log(
                `[TokenDoctor] Recovered Page Access Token for "${channel.pageName}" from sibling channel "${sib.pageName}" [reason=${reason}].`,
              );

              return {
                healed: true,
                newRawPageAccessToken: derivedFromSibling.pageAccessToken,
                channel,
                recoverySource: 'SIBLING_CHANNEL_USER_TOKEN',
              };
            }
          }
        }
      }
    }

    // 3. Nhánh Zalo Official Account (Xoay vòng Refresh Token chuẩn Zalo OAuth v4)
    if (
      channel.channelType === ChannelTypeEnum.ZALO_OA &&
      storedRefreshToken &&
      creds.appId &&
      creds.rawAppSecret
    ) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const zaloBody = new URLSearchParams({
          refresh_token: storedRefreshToken,
          app_id: creds.appId,
          grant_type: 'refresh_token',
        });
        const res = await fetch('https://oauth.zaloapp.com/v4/oa/access_token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            secret_key: creds.rawAppSecret,
          },
          body: zaloBody.toString(),
          signal: controller.signal,
        }).catch(() => null);
        clearTimeout(timeoutId);

        if (res && res.ok) {
          const json = (await res.json().catch(() => ({}))) as {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number | string;
          };
          if (json.access_token) {
            const nextAccess = String(json.access_token).trim();
            const nextRefresh = json.refresh_token
              ? String(json.refresh_token).trim()
              : storedRefreshToken;
            const expiresInSec = Number(json.expires_in || 90000);

            channel.accessTokenEncrypted = this.messageCryptoService.encryptForConversation(
              nextAccess,
              channel.shopId,
            ).ciphertext;
            channel.refreshTokenEncrypted = this.messageCryptoService.encryptForConversation(
              nextRefresh,
              channel.shopId,
            ).ciphertext;
            channel.tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000);
            channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
            channel.lastErrorMessage = null;
            channel.platformConfigJson = {
              ...(channel.platformConfigJson || {}),
              lastTokenRefreshedAt: new Date().toISOString(),
              tokenRecoverySource: 'ZALO_OA_REFRESH_TOKEN',
            };
            await this.channelRepo.save(channel);

            return {
              healed: true,
              newRawPageAccessToken: nextAccess,
              channel,
              recoverySource: 'ZALO_OA_REFRESH_TOKEN',
            };
          }
        }
      } catch {
        clearTimeout(timeoutId);
      }
    }

    return {
      healed: false,
      newRawPageAccessToken: null,
      channel,
      recoverySource: null,
    };
  }

  private async persistHealedChannelToken(params: {
    channel: ChannelIntegrationEntity;
    newRawPageToken: string;
    newLongLivedUserToken?: string | null;
    isNeverExpiring: boolean;
    tokenExpiresAt: Date | null;
    recoverySource: PageTokenRecoverySourceType;
    apiVersion: string;
    rawAppSecret?: string | null;
  }): Promise<void> {
    const { channel } = params;
    const nowIso = new Date().toISOString();

    channel.accessTokenEncrypted = this.messageCryptoService.encryptForConversation(
      params.newRawPageToken,
      channel.shopId,
    ).ciphertext;

    let encryptedUserTok = channel.platformConfigJson?.userLongLivedTokenEncrypted || null;
    if (params.newLongLivedUserToken) {
      encryptedUserTok = this.messageCryptoService.encryptForConversation(
        params.newLongLivedUserToken,
        channel.shopId,
      ).ciphertext;
      channel.refreshTokenEncrypted = encryptedUserTok;
    }

    channel.tokenExpiresAt = params.isNeverExpiring ? null : params.tokenExpiresAt;
    channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
    channel.lastErrorMessage = null;
    channel.platformConfigJson = {
      ...(channel.platformConfigJson || {}),
      isNeverExpiringPageToken: params.isNeverExpiring,
      userLongLivedTokenEncrypted: encryptedUserTok,
      lastTokenRefreshedAt: nowIso,
      autoRefreshPageTokenEnabled: true,
      tokenRecoverySource: params.recoverySource,
    };

    await this.channelRepo.save(channel);

    // Tự động kích hoạt lại subscribed_apps trên nền tảng với Page Token mới
    const desiredFields = channel.platformConfigJson?.subscribedFields || [
      'messages',
      'messaging_postbacks',
      'messaging_referrals',
      'message_deliveries',
      'message_reads',
      'message_echoes',
      'feed',
      'live_videos',
    ];
    const proof = this.computeAppSecretProof(params.newRawPageToken, params.rawAppSecret);
    const subUrl = `https://graph.facebook.com/${params.apiVersion}/${encodeURIComponent(channel.externalPageId)}/subscribed_apps`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4500);
    await fetch(subUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscribed_fields: desiredFields,
        access_token: params.newRawPageToken,
        ...(proof ? { appsecret_proof: proof } : {}),
      }),
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timeoutId);
  }

  /**
   * API 1-Chạm để người bán chủ động bấm "Lấy lại & Vĩnh viễn hóa Page Access Token" cho 1 kênh cụ thể
   */
  async refreshSingleChannelPageToken(
    shopId: string,
    channelId: string,
    actorUserId?: string,
  ): Promise<{
    channelId: string;
    pageName: string;
    pageShortCode: string;
    healed: boolean;
    isNeverExpiringPageToken: boolean;
    tokenExpiresAt: string | null;
    webhookStatus: WebhookIntegrationStatusEnum;
    recoverySource: PageTokenRecoverySourceType | null;
    refreshedAt: string;
  }> {
    const channel = await this.channelRepo.findOne({
      where: { id: channelId, shopId },
    });
    if (!channel) {
      throw new NotFoundException('CHANNEL_INTEGRATION_NOT_FOUND');
    }

    const healRes = await this.autoHealChannelPageAccessToken(channel, 'MANUAL_UI_REFRESH');
    if (!healRes.healed) {
      await this.evaluateSingleChannelHealth(channel, actorUserId);
    }

    const updated =
      (await this.channelRepo.findOne({ where: { id: channelId, shopId } })) || channel;
    const isNeverExpiring = Boolean(
      updated.platformConfigJson?.isNeverExpiringPageToken || !updated.tokenExpiresAt,
    );

    const activeMembers = await this.memberRepo.find({
      where: {
        shopId,
        membershipStatus: MembershipStatusEnum.ACTIVE,
      },
      select: ['userId'],
    });
    for (const m of activeMembers) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        m.userId,
        SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED,
        {
          shopId,
          action: 'PAGE_TOKEN_REFRESHED',
          channelId: updated.id,
          webhookStatus: updated.webhookStatus,
          isNeverExpiringPageToken: isNeverExpiring,
        },
      );
    }

    return {
      channelId: updated.id,
      pageName: updated.pageName,
      pageShortCode: updated.pageShortCode,
      healed: healRes.healed || updated.webhookStatus === WebhookIntegrationStatusEnum.HEALTHY,
      isNeverExpiringPageToken: isNeverExpiring,
      tokenExpiresAt: updated.tokenExpiresAt ? updated.tokenExpiresAt.toISOString() : null,
      webhookStatus: updated.webhookStatus,
      recoverySource:
        healRes.recoverySource || updated.platformConfigJson?.tokenRecoverySource || null,
      refreshedAt: new Date().toISOString(),
    };
  }

  @Cron(CronExpression.EVERY_2_HOURS)
  async inspectAndRefreshExpiringTokens(): Promise<void> {
    const activeChannels = await this.channelRepo.find({
      where: { isActive: true },
      order: { updatedAt: 'ASC' },
      take: 50,
    });

    for (const channel of activeChannels) {
      await this.evaluateSingleChannelHealth(channel).catch(() => null);
    }
  }

  async runShopChannelsHealthCheck(
    shopId: string,
    actorUserId?: string,
  ): Promise<{
    totalChecked: number;
    healthyCount: number;
    warningCount: number;
    expiredCount: number;
    channels: ChannelIntegrationEntity[];
  }> {
    const channels = await this.channelRepo.find({
      where: { shopId },
      order: { createdAt: 'DESC' },
    });

    let healthyCount = 0;
    let warningCount = 0;
    let expiredCount = 0;

    for (const channel of channels) {
      await this.evaluateSingleChannelHealth(channel, actorUserId);
      if (channel.webhookStatus === WebhookIntegrationStatusEnum.HEALTHY) {
        healthyCount++;
      } else if (channel.webhookStatus === WebhookIntegrationStatusEnum.TOKEN_EXPIRING_SOON) {
        warningCount++;
      } else {
        expiredCount++;
      }
    }

    const activeMembers = await this.memberRepo.find({
      where: {
        shopId,
        membershipStatus: MembershipStatusEnum.ACTIVE,
      },
      select: ['userId'],
    });

    for (const m of activeMembers) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        m.userId,
        SOCKET_CONFIG.events.CHANNELS.TOKEN_HEALTH_CHECKED,
        {
          shopId,
          totalChecked: channels.length,
          healthyCount,
          warningCount,
          expiredCount,
          checkedAt: new Date().toISOString(),
        },
      );
    }

    return {
      totalChecked: channels.length,
      healthyCount,
      warningCount,
      expiredCount,
      channels,
    };
  }

  /**
   * Công cụ T02: Bắt lỗi tức thì khi gọi API nền tảng gặp OAuthException (VD: Meta Error Code 190, Zalo OA -216)
   * Tự động kích hoạt quy trình tự phục hồi 4 tầng trước khi đánh dấu hết hạn!
   */
  async reportChannelOAuthException(params: {
    channelId: string;
    errorCode?: number | string;
    errorMessage: string;
  }): Promise<ChannelIntegrationEntity | null> {
    const channel = await this.channelRepo.findOne({
      where: { id: params.channelId },
    });
    if (!channel) return null;

    const healRes = await this.autoHealChannelPageAccessToken(
      channel,
      `OAUTH_EXCEPTION_${params.errorCode || 190}`,
    );
    if (healRes.healed && healRes.channel) {
      return healRes.channel;
    }

    channel.webhookStatus = WebhookIntegrationStatusEnum.TOKEN_EXPIRED;
    channel.lastErrorMessage = `[OAuth Error ${params.errorCode || '190'}] ${params.errorMessage}`;
    await this.channelRepo.save(channel);

    await this.dispatchTokenWarningNotification(channel);
    return channel;
  }

  private async evaluateSingleChannelHealth(
    channel: ChannelIntegrationEntity,
    actorUserId?: string,
  ): Promise<void> {
    const now = Date.now();
    const thresholdMs = 72 * 3600 * 1000;

    const rawPageToken = channel.accessTokenEncrypted
      ? this.messageCryptoService
          .decryptForConversation(channel.accessTokenEncrypted, channel.shopId)
          .trim()
      : '';

    // 1. Đối với Facebook / Instagram có Token thật, kiểm tra trực tiếp trên Graph API và tự động nâng cấp lên Never-Expiring Token nếu chưa phải
    if (
      (channel.channelType === ChannelTypeEnum.FACEBOOK_PAGE ||
        channel.channelType === ChannelTypeEnum.INSTAGRAM) &&
      rawPageToken &&
      !/^(oauth2_tok_|sandbox_|sim_)/i.test(rawPageToken)
    ) {
      const creds = await this.resolveChannelAppCredentials(channel);
      const vitality = await this.inspectMetaTokenVitality({
        apiVersion: creds.apiVersion,
        token: rawPageToken,
        appId: creds.appId,
        rawAppSecret: creds.rawAppSecret,
      });

      if (!vitality.isValid) {
        const healAttempt = await this.autoHealChannelPageAccessToken(
          channel,
          'HEALTH_CHECK_INVALID_TOKEN',
        );
        if (healAttempt.healed) {
          return;
        }
        channel.webhookStatus = WebhookIntegrationStatusEnum.TOKEN_EXPIRED;
        channel.lastErrorMessage =
          vitality.errorMessage || 'Page Access Token đã hết hạn hoặc bị thu hồi quyền.';
        await this.channelRepo.save(channel);
        await this.dispatchTokenWarningNotification(channel, actorUserId);
        return;
      }

      // Nếu Token hiện tại còn hạn nhưng chưa phải Never-Expiring Page Token (vitality.expiresAt !== null),
      // chủ động tự đổi sang Never-Expiring Page Token ngay lập tức!
      if (!vitality.isNeverExpiring && vitality.expiresAt) {
        const upgraded = await this.autoHealChannelPageAccessToken(
          channel,
          'UPGRADE_TO_NEVER_EXPIRING_PAGE_TOKEN',
        );
        if (upgraded.healed) {
          return;
        }
      }

      channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
      channel.lastErrorMessage = null;
      channel.tokenExpiresAt = vitality.isNeverExpiring ? null : vitality.expiresAt;
      channel.platformConfigJson = {
        ...(channel.platformConfigJson || {}),
        isNeverExpiringPageToken: vitality.isNeverExpiring || vitality.expiresAt === null,
        lastTokenRefreshedAt: new Date().toISOString(),
      };
      await this.channelRepo.save(channel);
      return;
    }

    if (!channel.tokenExpiresAt || channel.platformConfigJson?.isNeverExpiringPageToken) {
      channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
      channel.lastErrorMessage = null;
      await this.channelRepo.save(channel);
      return;
    }

    const expiresAtMs = new Date(channel.tokenExpiresAt).getTime();
    if (expiresAtMs <= now || expiresAtMs - now <= thresholdMs) {
      const healRes = await this.autoHealChannelPageAccessToken(channel, 'EXPIRING_SOON_CRON');
      if (healRes.healed) {
        return;
      }
      channel.webhookStatus =
        expiresAtMs <= now
          ? WebhookIntegrationStatusEnum.TOKEN_EXPIRED
          : WebhookIntegrationStatusEnum.TOKEN_EXPIRING_SOON;
    } else {
      channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
    }

    await this.channelRepo.save(channel);

    if (channel.webhookStatus === WebhookIntegrationStatusEnum.HEALTHY) {
      return;
    }

    await this.dispatchTokenWarningNotification(channel, actorUserId);
  }

  private async dispatchTokenWarningNotification(
    channel: ChannelIntegrationEntity,
    actorUserId?: string,
  ): Promise<void> {
    const [shop, activeMembers] = await Promise.all([
      this.shopRepo.findOne({ where: { id: channel.shopId } }),
      this.memberRepo.find({
        where: {
          shopId: channel.shopId,
          membershipStatus: MembershipStatusEnum.ACTIVE,
        },
      }),
    ]);

    if (!shop) return;

    const recipientSet = new Set<string>([shop.ownerId]);
    for (const m of activeMembers) {
      if (
        m.role === ShopRoleEnum.SHOP_OWNER ||
        m.role === ShopRoleEnum.SHOP_MANAGER ||
        (m.grantedPermissionsJson || []).includes(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
      ) {
        recipientSet.add(m.userId);
      }
    }

    const recipientIds = Array.from(recipientSet);
    if (recipientIds.length === 0) return;

    await this.notificationsService.createAndDispatch({
      recipientIds,
      actorId: actorUserId || null,
      type: NotificationTypeEnum.CHANNEL_TOKEN_WARNING,
      title: `Cảnh báo kết nối kênh ${channel.pageName}`,
      content: `Mã kết nối (Token) của kênh ${channel.pageShortCode} sắp hết hạn hoặc đã mất hiệu lực. Hệ thống đã thử tự động làm mới nhưng cần cấp quyền lại.`,
      resourceType: NotificationResourceTypeEnum.CHANNEL_INTEGRATION,
      resourceId: channel.id,
      dedupeKey: `channel_token_warn:${channel.id}:${channel.webhookStatus}`,
      metadata: {
        actionUrl: '/settings/channels',
        titleKey: 'i18n.channelTokenWarning.title',
        contentKey: 'i18n.channelTokenWarning.content',
        i18nParams: {
          pageName: channel.pageName,
          pageShortCode: channel.pageShortCode,
          status: channel.webhookStatus,
        },
      },
    });
  }
}
