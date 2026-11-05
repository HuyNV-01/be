import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { NotificationResourceTypeEnum, NotificationTypeEnum } from 'src/common/enum';
import { WebhookIntegrationStatusEnum } from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { ChannelIntegrationEntity } from 'src/entity/channel-integration.entity';
import { NotificationEntity } from 'src/entity/notification.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { LessThanOrEqual, Repository } from 'typeorm';

@Injectable()
export class ChannelTokenDoctorService {
  private readonly logger = new Logger(ChannelTokenDoctorService.name);

  constructor(
    @InjectRepository(ChannelIntegrationEntity)
    private readonly channelRepo: Repository<ChannelIntegrationEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    @InjectRepository(NotificationEntity)
    private readonly notificationRepo: Repository<NotificationEntity>,
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

  async runShopChannelsHealthCheck(shopId: string): Promise<{
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
      await this.evaluateSingleChannelHealth(channel);
      if (channel.webhookStatus === WebhookIntegrationStatusEnum.HEALTHY) {
        healthyCount++;
      } else if (channel.webhookStatus === WebhookIntegrationStatusEnum.TOKEN_EXPIRING_SOON) {
        warningCount++;
      } else {
        expiredCount++;
      }
    }

    return {
      totalChecked: channels.length,
      healthyCount,
      warningCount,
      expiredCount,
      channels,
    };
  }

  private async evaluateSingleChannelHealth(channel: ChannelIntegrationEntity): Promise<void> {
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
        channel.tokenExpiresAt = new Date(now + 30 * 86400 * 1000);
        channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
        channel.lastErrorMessage = null;
        await this.channelRepo.save(channel);
        return;
      }
      channel.webhookStatus = WebhookIntegrationStatusEnum.TOKEN_EXPIRED;
    } else if (expiresAtMs - now <= thresholdMs) {
      if (channel.refreshTokenEncrypted) {
        channel.tokenExpiresAt = new Date(now + 30 * 86400 * 1000);
        channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
        channel.lastErrorMessage = null;
        await this.channelRepo.save(channel);
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

    const shop = await this.shopRepo.findOne({ where: { id: channel.shopId } });
    if (!shop) return;

    const dedupeKey = `channel_token_warn:${channel.id}:${channel.webhookStatus}`;
    const existingNotif = await this.notificationRepo.findOne({
      where: { recipientId: shop.ownerId, dedupeKey },
    });

    if (!existingNotif) {
      const notif = this.notificationRepo.create({
        recipientId: shop.ownerId,
        type: NotificationTypeEnum.SYSTEM,
        resourceType: NotificationResourceTypeEnum.SYSTEM,
        resourceId: channel.id,
        dedupeKey,
        title: `Cảnh báo kết nối kênh ${channel.pageName}`,
        content: `Token của kênh ${channel.pageShortCode} sắp hết hạn hoặc cần làm mới.`,
        metadata: {
          actionUrl: '/settings/channels',
          titleKey: 'SettingsChannels.tokenWarningTitle',
          contentKey: 'SettingsChannels.tokenWarningDesc',
          i18nParams: {
            pageName: channel.pageName,
            pageShortCode: channel.pageShortCode,
          },
        },
      });
      const savedNotif = await this.notificationRepo.save(notif);
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        shop.ownerId,
        SOCKET_CONFIG.events.NOTIFICATION.NEW,
        savedNotif,
      );
    }
  }
}
