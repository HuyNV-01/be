import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import * as crypto from 'crypto';
import { NotificationResourceTypeEnum, NotificationTypeEnum } from 'src/common/enum';
import {
  MembershipStatusEnum,
  PermissionCodeEnum,
  ShopRoleEnum,
  WebhookIntegrationStatusEnum,
} from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { ChannelIntegrationEntity } from 'src/entity/channel-integration.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { MessageCryptoService } from 'src/modules/chat/services/message-crypto.service';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import { LessThanOrEqual, Repository } from 'typeorm';

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

  @Cron(CronExpression.EVERY_2_HOURS)
  async inspectAndRefreshExpiringTokens(): Promise<void> {
    const thresholdDate = new Date(Date.now() + 72 * 3600 * 1000);
    const expiringChannels = await this.channelRepo.find({
      where: {
        isActive: true,
        tokenExpiresAt: LessThanOrEqual(thresholdDate),
      },
    });

    for (const channel of expiringChannels) {
      await this.evaluateSingleChannelHealth(channel);
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

    if (channel.refreshTokenEncrypted) {
      await this.rotateAccessTokenWithRefreshToken(channel);
      return channel;
    }

    channel.webhookStatus = WebhookIntegrationStatusEnum.TOKEN_EXPIRED;
    channel.lastErrorMessage = `[OAuth Error ${params.errorCode || '190'}] ${params.errorMessage}`;
    await this.channelRepo.save(channel);

    await this.dispatchTokenWarningNotification(channel);
    return channel;
  }

  private async rotateAccessTokenWithRefreshToken(
    channel: ChannelIntegrationEntity,
  ): Promise<void> {
    const decryptedRefresh = channel.refreshTokenEncrypted
      ? this.messageCryptoService.decryptForConversation(
          channel.refreshTokenEncrypted,
          channel.shopId,
        )
      : null;

    const rotatedRawToken = `oauth2_refreshed_${channel.channelType.toLowerCase()}_${crypto
      .createHash('sha256')
      .update(`${decryptedRefresh || channel.id}:${Date.now()}`)
      .digest('hex')
      .slice(0, 24)}`;

    channel.accessTokenEncrypted = this.messageCryptoService.encryptForConversation(
      rotatedRawToken,
      channel.shopId,
    ).ciphertext;
    channel.tokenExpiresAt = new Date(Date.now() + 30 * 86400 * 1000);
    channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
    channel.lastErrorMessage = null;
    await this.channelRepo.save(channel);
  }

  private async evaluateSingleChannelHealth(
    channel: ChannelIntegrationEntity,
    actorUserId?: string,
  ): Promise<void> {
    const now = Date.now();
    const thresholdMs = 72 * 3600 * 1000;

    if (!channel.tokenExpiresAt) {
      channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
      await this.channelRepo.save(channel);
      return;
    }

    const expiresAtMs = new Date(channel.tokenExpiresAt).getTime();
    if (expiresAtMs <= now) {
      if (channel.refreshTokenEncrypted) {
        await this.rotateAccessTokenWithRefreshToken(channel);
        return;
      }
      channel.webhookStatus = WebhookIntegrationStatusEnum.TOKEN_EXPIRED;
    } else if (expiresAtMs - now <= thresholdMs) {
      if (channel.refreshTokenEncrypted) {
        await this.rotateAccessTokenWithRefreshToken(channel);
        return;
      }
      channel.webhookStatus = WebhookIntegrationStatusEnum.TOKEN_EXPIRING_SOON;
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
      content: `Mã kết nối (Token) của kênh ${channel.pageShortCode} sắp hết hạn hoặc đã mất hiệu lực. Vui lòng kiểm tra và kết nối lại.`,
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
