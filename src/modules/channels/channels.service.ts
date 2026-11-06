import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import * as crypto from 'crypto';
import {
  ChannelTypeEnum,
  ConversationSupportStatusEnum,
  ConversationTypeEnum,
  GroupRoleEnum,
  MembershipStatusEnum,
  MessageStatusEnum,
  MessageTypeEnum,
  NotificationResourceTypeEnum,
  NotificationTypeEnum,
  ShopRoleEnum,
  WebhookIntegrationStatusEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  ConnectChannelOAuthDto,
  MergedInboxQueryDto,
  UpdateChannelIntegrationDto,
  WebhookLogQueryDto,
} from 'src/dto/channels/channels.dto';
import { ChannelIntegrationEntity } from 'src/entity/channel-integration.entity';
import { ChannelWebhookLogEntity } from 'src/entity/channel-webhook-log.entity';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { MessageDirectionEnum, MessageEntity } from 'src/entity/message.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { MessageCryptoService } from 'src/modules/chat/services/message-crypto.service';
import { DataScopeQueryHelper } from 'src/modules/iam/helpers/data-scope-query.helper';
import { EffectiveMemberContext } from 'src/modules/iam/iam.service';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import { In, Repository } from 'typeorm';

import { ConversationRoutingEngine } from './routing/conversation-routing.engine';
import { MarketplaceBridgeService } from './services/marketplace-bridge.service';

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    @InjectRepository(ChannelIntegrationEntity)
    private readonly channelRepo: Repository<ChannelIntegrationEntity>,
    @InjectRepository(ChannelWebhookLogEntity)
    private readonly webhookLogRepo: Repository<ChannelWebhookLogEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(ConversationParticipantEntity)
    private readonly participantRepo: Repository<ConversationParticipantEntity>,
    @InjectRepository(MessageEntity)
    private readonly messageRepo: Repository<MessageEntity>,
    @InjectRepository(ShopMemberEntity)
    private readonly memberRepo: Repository<ShopMemberEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    private readonly messageCryptoService: MessageCryptoService,
    private readonly routingEngine: ConversationRoutingEngine,
    private readonly marketplaceBridge: MarketplaceBridgeService,
    private readonly notificationsService: NotificationsService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private async broadcastChannelEventToShop(
    shopId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<string[]> {
    const activeMembers = await this.memberRepo.find({
      where: {
        shopId,
        membershipStatus: MembershipStatusEnum.ACTIVE,
      },
      select: ['userId', 'role'],
    });

    const userIds = Array.from(new Set(activeMembers.map((m) => m.userId)));
    for (const uid of userIds) {
      this.realtimeEmitter.emitToUser(SOCKET_CONFIG.namespaces.CHAT, uid, eventName, payload);
    }

    return activeMembers
      .filter((m) => m.role === ShopRoleEnum.SHOP_OWNER || m.role === ShopRoleEnum.SHOP_MANAGER)
      .map((m) => m.userId);
  }

  private async ensureConversationParticipants(
    conversationId: string,
    userIds: string[],
  ): Promise<void> {
    const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
    const now = new Date();
    for (const userId of uniqueIds) {
      const existing = await this.participantRepo.findOne({
        where: { conversationId, userId },
      });
      if (!existing) {
        const part = this.participantRepo.create({
          conversationId,
          userId,
          role: GroupRoleEnum.MEMBER,
          isAdmin: false,
          isHidden: false,
          joinedAt: now,
        });
        await this.participantRepo.save(part).catch(() => undefined);
      } else if (existing.isHidden) {
        await this.participantRepo.update(existing.id, { isHidden: false }).catch(() => undefined);
      }
    }
  }

  async connectOrUpdateChannelOAuth(
    shopId: string,
    dto: ConnectChannelOAuthDto,
    actorUserId?: string,
  ): Promise<ChannelIntegrationEntity> {
    const resolvedShortCode = dto.pageShortCode.trim().toUpperCase();
    const resolvedExternalPageId = (
      dto.externalPageId ||
      (dto.oauthCode
        ? `${dto.channelType.toLowerCase()}_${crypto
            .createHash('sha256')
            .update(dto.oauthCode)
            .digest('hex')
            .slice(0, 12)}`
        : `${dto.channelType.toLowerCase()}_${Date.now()}`)
    ).trim();

    const resolvedPageName = (dto.pageName || `${dto.channelType} — ${resolvedShortCode}`).trim();

    const rawAccessToken = (
      dto.accessToken || `oauth2_tok_${dto.oauthCode || crypto.randomBytes(16).toString('hex')}`
    ).trim();

    const rawRefreshToken =
      dto.refreshToken?.trim() || (dto.oauthCode ? `oauth2_rft_${dto.oauthCode.trim()}` : null);

    let channel = await this.channelRepo.findOne({
      where: {
        shopId,
        channelType: dto.channelType,
        externalPageId: resolvedExternalPageId,
      },
    });

    const accessTokenEncrypted = this.messageCryptoService.encryptForConversation(
      rawAccessToken,
      shopId,
    ).ciphertext;

    const refreshTokenEncrypted = rawRefreshToken
      ? this.messageCryptoService.encryptForConversation(rawRefreshToken, shopId).ciphertext
      : null;

    const webhookVerifySecretEncrypted = dto.webhookVerifySecret
      ? this.messageCryptoService.encryptForConversation(dto.webhookVerifySecret.trim(), shopId)
          .ciphertext
      : null;

    const capiAccessTokenEncrypted = dto.capiAccessToken
      ? this.messageCryptoService.encryptForConversation(dto.capiAccessToken.trim(), shopId)
          .ciphertext
      : null;

    const defaultExpiry = dto.tokenExpiresAt
      ? new Date(dto.tokenExpiresAt)
      : new Date(Date.now() + 60 * 86400 * 1000);

    if (channel) {
      channel.pageName = resolvedPageName;
      channel.pageShortCode = resolvedShortCode;
      channel.externalShopId = dto.externalShopId || channel.externalShopId;
      channel.avatarUrl = dto.avatarUrl || channel.avatarUrl;
      channel.accessTokenEncrypted = accessTokenEncrypted;
      if (refreshTokenEncrypted) {
        channel.refreshTokenEncrypted = refreshTokenEncrypted;
      }
      if (webhookVerifySecretEncrypted) {
        channel.webhookVerifySecretEncrypted = webhookVerifySecretEncrypted;
      }
      if (dto.metaDatasetId !== undefined) {
        channel.metaDatasetId = dto.metaDatasetId;
      }
      if (capiAccessTokenEncrypted) {
        channel.capiAccessTokenEncrypted = capiAccessTokenEncrypted;
      }
      channel.tokenExpiresAt = defaultExpiry;
      channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
      channel.isActive = true;
      channel.lastErrorMessage = null;
    } else {
      channel = this.channelRepo.create({
        shopId,
        channelType: dto.channelType,
        externalPageId: resolvedExternalPageId,
        externalShopId: dto.externalShopId || null,
        pageName: resolvedPageName,
        pageShortCode: resolvedShortCode,
        avatarUrl: dto.avatarUrl || null,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        webhookVerifySecretEncrypted,
        metaDatasetId: dto.metaDatasetId || null,
        capiAccessTokenEncrypted,
        tokenExpiresAt: defaultExpiry,
        webhookStatus: WebhookIntegrationStatusEnum.HEALTHY,
        isActive: true,
      });
    }

    const saved = await this.channelRepo.save(channel);

    const [shop, managerIds] = await Promise.all([
      this.shopRepo.findOne({ where: { id: shopId } }),
      this.broadcastChannelEventToShop(shopId, SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED, {
        shopId,
        action: 'CONNECTED',
        channelId: saved.id,
        channelType: saved.channelType,
        pageName: saved.pageName,
        pageShortCode: saved.pageShortCode,
        webhookStatus: saved.webhookStatus,
      }),
    ]);

    if (shop && managerIds.length > 0) {
      const recipientIds = actorUserId
        ? managerIds.filter((uid) => uid !== actorUserId)
        : managerIds;
      if (recipientIds.length > 0) {
        await this.notificationsService.createAndDispatch({
          recipientIds,
          actorId: actorUserId || null,
          type: NotificationTypeEnum.CHANNEL_CONNECTED,
          title: `Đã kết nối kênh ${saved.pageName}`,
          content: `Kênh ${saved.pageShortCode} (${saved.channelType}) vừa được tích hợp vào cửa hàng ${shop.name}.`,
          resourceType: NotificationResourceTypeEnum.CHANNEL_INTEGRATION,
          resourceId: saved.id,
          dedupeKey: `channel_connected:${saved.id}`,
          metadata: {
            actionUrl: '/settings/channels',
            titleKey: 'i18n.channelConnected.title',
            contentKey: 'i18n.channelConnected.content',
            i18nParams: {
              pageName: saved.pageName,
              pageShortCode: saved.pageShortCode,
              channelType: saved.channelType,
              shopName: shop.name,
            },
          },
        });
      }
    }

    return saved;
  }

  async updateChannelIntegration(
    shopId: string,
    channelId: string,
    dto: UpdateChannelIntegrationDto,
  ): Promise<ChannelIntegrationEntity> {
    const channel = await this.channelRepo.findOne({
      where: { id: channelId, shopId },
    });
    if (!channel) {
      throw new NotFoundException('CHANNEL_INTEGRATION_NOT_FOUND');
    }

    if (dto.pageName !== undefined) {
      channel.pageName = dto.pageName.trim();
    }
    if (dto.pageShortCode !== undefined) {
      channel.pageShortCode = dto.pageShortCode.trim().toUpperCase();
    }
    if (dto.avatarUrl !== undefined) {
      channel.avatarUrl = dto.avatarUrl.trim() || null;
    }
    if (dto.accessToken) {
      channel.accessTokenEncrypted = this.messageCryptoService.encryptForConversation(
        dto.accessToken.trim(),
        shopId,
      ).ciphertext;
      channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
      channel.tokenExpiresAt = new Date(Date.now() + 60 * 86400 * 1000);
      channel.lastErrorMessage = null;
    }
    if (dto.refreshToken) {
      channel.refreshTokenEncrypted = this.messageCryptoService.encryptForConversation(
        dto.refreshToken.trim(),
        shopId,
      ).ciphertext;
    }
    if (dto.webhookVerifySecret) {
      channel.webhookVerifySecretEncrypted = this.messageCryptoService.encryptForConversation(
        dto.webhookVerifySecret.trim(),
        shopId,
      ).ciphertext;
    }
    if (dto.metaDatasetId !== undefined) {
      channel.metaDatasetId = dto.metaDatasetId.trim() || null;
    }
    if (dto.capiAccessToken) {
      channel.capiAccessTokenEncrypted = this.messageCryptoService.encryptForConversation(
        dto.capiAccessToken.trim(),
        shopId,
      ).ciphertext;
    }
    if (dto.isActive !== undefined) {
      channel.isActive = dto.isActive;
    }

    const saved = await this.channelRepo.save(channel);

    await this.broadcastChannelEventToShop(
      shopId,
      SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED,
      {
        shopId,
        action: 'UPDATED',
        channelId: saved.id,
        channelType: saved.channelType,
        pageName: saved.pageName,
        pageShortCode: saved.pageShortCode,
        webhookStatus: saved.webhookStatus,
      },
    );

    return saved;
  }

  async removeChannelIntegration(
    shopId: string,
    channelId: string,
  ): Promise<{ id: string; deleted: boolean }> {
    const channel = await this.channelRepo.findOne({
      where: { id: channelId, shopId },
    });
    if (!channel) {
      throw new NotFoundException('CHANNEL_INTEGRATION_NOT_FOUND');
    }
    await this.channelRepo.softRemove(channel);

    await this.broadcastChannelEventToShop(
      shopId,
      SOCKET_CONFIG.events.CHANNELS.INTEGRATION_REMOVED,
      {
        shopId,
        channelId,
        pageShortCode: channel.pageShortCode,
        pageName: channel.pageName,
      },
    );

    return { id: channelId, deleted: true };
  }

  async listShopChannels(
    shopId: string,
    memberCtx: EffectiveMemberContext,
  ): Promise<
    Array<
      ChannelIntegrationEntity & {
        unreadCount: number;
      }
    >
  > {
    const whereClause: Record<string, unknown> = { shopId };
    if (memberCtx.allowedChannelIds && memberCtx.allowedChannelIds.length > 0) {
      whereClause.id = In(memberCtx.allowedChannelIds);
    }

    const channels = await this.channelRepo.find({
      where: whereClause,
      order: { createdAt: 'ASC' },
    });

    const unreadCountsRaw = await this.conversationRepo
      .createQueryBuilder('c')
      .select('c.channel_integration_id', 'channelIntegrationId')
      .addSelect('COUNT(c.id)', 'cnt')
      .where('c.shop_id = :shopId', { shopId })
      .andWhere('c.support_status = :waitingStatus', {
        waitingStatus: ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
      })
      .groupBy('c.channel_integration_id')
      .getRawMany<{ channelIntegrationId: string; cnt: string }>();

    const countMap = new Map<string, number>();
    for (const row of unreadCountsRaw) {
      if (row.channelIntegrationId) {
        countMap.set(row.channelIntegrationId, Number(row.cnt || 0));
      }
    }

    return channels.map((ch) =>
      Object.assign(ch, {
        unreadCount: countMap.get(ch.id) || 0,
      }),
    );
  }

  async getMergedInboxConversations(
    shopId: string,
    memberCtx: EffectiveMemberContext,
    query: MergedInboxQueryDto,
  ): Promise<{
    items: Array<
      ConversationEntity & {
        pageShortCode?: string;
        pageName?: string;
        channelAvatarUrl?: string | null;
      }
    >;
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 30)));

    const qb = this.conversationRepo.createQueryBuilder('c');
    DataScopeQueryHelper.applyAgentDataScope(qb, 'c', memberCtx);

    const requestedChannelIds = Array.isArray(query.channelIds)
      ? query.channelIds
      : typeof query.channelIds === 'string' && query.channelIds.trim().length > 0
        ? query.channelIds
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        : [];

    if (requestedChannelIds.length > 0) {
      qb.andWhere('c.channel_integration_id IN (:...requestedChannelIds)', {
        requestedChannelIds,
      });
    }

    if (query.supportStatus) {
      qb.andWhere('c.support_status = :supportStatus', {
        supportStatus: query.supportStatus,
      });
    }

    if (query.search && query.search.trim().length > 0) {
      qb.andWhere('(c.name LIKE :kw OR c.external_thread_id LIKE :kw)', {
        kw: `%${query.search.trim()}%`,
      });
    }

    qb.orderBy('c.lastMessageAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rawItems, total] = await qb.getManyAndCount();

    const channelIds = Array.from(
      new Set(rawItems.map((c) => c.channelIntegrationId).filter(Boolean) as string[]),
    );
    const channels =
      channelIds.length > 0 ? await this.channelRepo.find({ where: { id: In(channelIds) } }) : [];
    const channelMap = new Map<string, ChannelIntegrationEntity>();
    for (const ch of channels) {
      channelMap.set(ch.id, ch);
    }

    const items = rawItems.map((conv) => {
      const decryptedLastMessage = conv.lastMessage
        ? this.messageCryptoService.decryptForConversation(conv.lastMessage, conv.id)
        : null;
      const ch = conv.channelIntegrationId ? channelMap.get(conv.channelIntegrationId) : undefined;
      return Object.assign(conv, {
        lastMessage: decryptedLastMessage || conv.lastMessage,
        pageShortCode: ch?.pageShortCode || conv.channelType,
        pageName: ch?.pageName || conv.channelType,
        channelAvatarUrl: ch?.avatarUrl || null,
      });
    });

    return { items, total, page, limit };
  }

  async getWebhookLogs(
    shopId: string,
    query: WebhookLogQueryDto,
  ): Promise<{
    items: ChannelWebhookLogEntity[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));

    const qb = this.webhookLogRepo
      .createQueryBuilder('log')
      .where('(log.shop_id = :shopId OR log.shop_id IS NULL)', { shopId });

    if (query.channelType) {
      qb.andWhere('log.channel_type = :channelType', {
        channelType: query.channelType,
      });
    }

    if (query.processingStatus) {
      qb.andWhere('log.processing_status = :processingStatus', {
        processingStatus: query.processingStatus,
      });
    }

    qb.orderBy('log.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, limit };
  }

  async notifyWebhookLogUpdated(
    shopId: string | null,
    log: Partial<ChannelWebhookLogEntity>,
  ): Promise<void> {
    if (!shopId) return;
    await this.broadcastChannelEventToShop(
      shopId,
      SOCKET_CONFIG.events.CHANNELS.WEBHOOK_LOG_UPDATED,
      {
        shopId,
        logId: log.id,
        channelType: log.channelType,
        eventType: log.eventType,
        processingStatus: log.processingStatus,
        replayedCount: log.replayedCount || 0,
      },
    );
  }

  async resolveChannelByWebhookPayload(
    channelType: ChannelTypeEnum,
    payload: Record<string, unknown>,
  ): Promise<ChannelIntegrationEntity | null> {
    const externalPageId = String(
      payload?.pageId ||
        payload?.externalPageId ||
        payload?.recipientId ||
        payload?.shop_id ||
        (Array.isArray(payload?.entry) && (payload.entry[0] as any)?.id) ||
        '',
    ).trim();

    if (!externalPageId) {
      return null;
    }

    return this.channelRepo.findOne({
      where: { channelType, externalPageId },
    });
  }

  async dispatchInboundWebhookPayload(params: {
    logId: string;
    channelType: ChannelTypeEnum;
    headers: Record<string, string>;
    payload: Record<string, unknown>;
  }): Promise<{
    shopId: string | null;
    channelIntegrationId: string | null;
    conversationId: string | null;
    assignedAgentId: string | null;
  }> {
    const { channelType, payload } = params;

    const channel = await this.resolveChannelByWebhookPayload(channelType, payload);

    if (!channel) {
      return {
        shopId: null,
        channelIntegrationId: null,
        conversationId: null,
        assignedAgentId: null,
      };
    }

    channel.lastWebhookReceivedAt = new Date();
    channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
    await this.channelRepo.save(channel);

    const isMarketplaceChannel =
      channelType === ChannelTypeEnum.SHOPEE ||
      channelType === ChannelTypeEnum.TIKTOK_SHOP ||
      channelType === ChannelTypeEnum.LAZADA;

    if (
      isMarketplaceChannel &&
      (payload.order_sn || payload.orderSn || payload.event === 'ORDER_CREATED')
    ) {
      const orderSn = String(payload.order_sn || payload.orderSn || `ORD-${Date.now()}`);
      const buyerUsername = String(
        payload.buyer_username || payload.senderName || `Khách ${channel.pageShortCode}`,
      );
      const totalAmount = Number(payload.total_amount || payload.totalAmount || 350000);
      const rawItems = Array.isArray(payload.items) ? payload.items : [];
      const items =
        rawItems.length > 0
          ? rawItems.map((it: any, idx: number) => ({
              externalItemId: String(it.externalItemId || it.item_id || `ITEM-${idx + 1}`),
              skuCode: String(it.skuCode || it.model_sku || `SKU-${idx + 1}`),
              itemName: String(it.itemName || it.item_name || 'Sản phẩm sàn TMĐT'),
              quantity: Number(it.quantity || 1),
              unitPrice: Number(it.unitPrice || totalAmount),
            }))
          : [
              {
                externalItemId: `ITEM-${orderSn.slice(-4)}`,
                skuCode: `SKU-${channel.pageShortCode}`,
                itemName: `Đơn hàng sàn ${channel.pageName}`,
                quantity: 1,
                unitPrice: totalAmount,
              },
            ];

      const syncResult = await this.marketplaceBridge.syncMarketplaceOrderAndConversation({
        shopId: channel.shopId,
        channel,
        orderSn,
        buyerUsername,
        orderStatus: String(payload.order_status || 'READY_TO_SHIP'),
        totalAmount,
        items,
        inquiryText: payload.messageText ? String(payload.messageText) : undefined,
      });

      await this.broadcastChannelEventToShop(
        channel.shopId,
        SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED,
        {
          shopId: channel.shopId,
          action: 'WEBHOOK_INBOUND',
          channelId: channel.id,
        },
      );

      return {
        shopId: channel.shopId,
        channelIntegrationId: channel.id,
        conversationId: syncResult.conversationId,
        assignedAgentId: syncResult.assignedAgentId,
      };
    }

    const externalThreadId = String(
      payload.threadId ||
        payload.senderId ||
        payload.conversation_id ||
        payload.order_sn ||
        `thread_${channel.externalPageId}_default`,
    );

    const customerName = String(
      payload.senderName ||
        payload.buyer_username ||
        `Khách ${channel.pageShortCode} #${externalThreadId.slice(-4)}`,
    );

    const messageText = String(
      payload.messageText ||
        payload.text ||
        (payload.order_sn
          ? `[Đơn sàn ${channelType} #${String(payload.order_sn)}]`
          : 'Khách hàng vừa gửi tin nhắn mới'),
    );

    let conversation = await this.conversationRepo.findOne({
      where: {
        shopId: channel.shopId,
        channelIntegrationId: channel.id,
        externalThreadId,
      },
    });

    const now = new Date();

    if (!conversation) {
      conversation = this.conversationRepo.create({
        type: ConversationTypeEnum.DIRECT,
        shopId: channel.shopId,
        channelType: channel.channelType,
        channelIntegrationId: channel.id,
        externalThreadId,
        name: customerName,
        lastMessage: messageText,
        lastMessageAt: now,
        lastCustomerMessageAt: now,
        supportStatus: ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
        sourceAdId: payload.adId ? String(payload.adId) : null,
        sourcePostId: payload.postId ? String(payload.postId) : null,
        ctwaClickId: payload.ctwaClid ? String(payload.ctwaClid) : null,
        activeTagIdsJson: [],
      });
    } else {
      conversation.lastMessage = messageText;
      conversation.lastMessageAt = now;
      conversation.lastCustomerMessageAt = now;
      conversation.supportStatus = ConversationSupportStatusEnum.WAITING_AGENT_REPLY;
      if (payload.adId) {
        conversation.sourceAdId = String(payload.adId);
      }
      if (payload.ctwaClid) {
        conversation.ctwaClickId = String(payload.ctwaClid);
      }
    }

    const savedConversation = await this.conversationRepo.save(conversation);

    // Mã hóa lastMessage bằng MessageCryptoService để đồng bộ với ChatService.getUserInbox
    const encryptedMsg = this.messageCryptoService.encryptForConversation(
      messageText,
      savedConversation.id,
    );

    await this.conversationRepo.update(savedConversation.id, {
      lastMessage: encryptedMsg.ciphertext,
      lastMessageType: MessageTypeEnum.TEXT,
      lastMessageAt: now,
    });

    const assignedAgentId = await this.routingEngine.routeInboundConversation({
      shopId: channel.shopId,
      conversation: savedConversation,
      channelIntegrationId: channel.id,
    });

    const [shop, activeMembers] = await Promise.all([
      this.shopRepo.findOne({ where: { id: channel.shopId } }),
      this.memberRepo.find({
        where: {
          shopId: channel.shopId,
          membershipStatus: MembershipStatusEnum.ACTIVE,
        },
        select: ['userId', 'role'],
      }),
    ]);

    const participantUserIds = activeMembers
      .filter(
        (m) =>
          m.role === ShopRoleEnum.SHOP_OWNER ||
          m.role === ShopRoleEnum.SHOP_MANAGER ||
          m.userId === assignedAgentId,
      )
      .map((m) => m.userId);
    if (shop?.ownerId) {
      participantUserIds.push(shop.ownerId);
    }
    if (assignedAgentId) {
      participantUserIds.push(assignedAgentId);
    }

    await this.ensureConversationParticipants(savedConversation.id, participantUserIds);

    const inboundSenderId = `ext:${channel.channelType.toLowerCase()}:${externalThreadId.slice(0, 18)}`;
    const inboundMessage = this.messageRepo.create({
      conversationId: savedConversation.id,
      senderId: inboundSenderId,
      shopId: channel.shopId,
      direction: MessageDirectionEnum.INBOUND,
      externalMessageId: payload.messageId ? String(payload.messageId) : `wh_${params.logId}`,
      content: encryptedMsg.ciphertext,
      type: MessageTypeEnum.TEXT,
      status: MessageStatusEnum.SENT,
      readBy: [],
      deliveredTo: participantUserIds,
      isPinned: false,
      metadata: {
        isEncrypted: encryptedMsg.isEncrypted,
        encryptionAlg: encryptedMsg.algorithm,
        channelType: channel.channelType,
        pageShortCode: channel.pageShortCode,
        pageName: channel.pageName,
        externalCustomerName: customerName,
      } as any,
      createdAt: now,
      updatedAt: now,
    });
    const savedMsg = await this.messageRepo.save(inboundMessage);

    for (const uid of new Set(participantUserIds)) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        uid,
        SOCKET_CONFIG.events.CHAT.NEW_MESSAGE,
        {
          ...savedMsg,
          content: messageText,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          sender: {
            id: inboundSenderId,
            name: customerName,
            avatar: channel.avatarUrl || null,
          },
        },
      );
    }

    await this.broadcastChannelEventToShop(
      channel.shopId,
      SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED,
      {
        shopId: channel.shopId,
        action: 'WEBHOOK_INBOUND',
        channelId: channel.id,
      },
    );

    return {
      shopId: channel.shopId,
      channelIntegrationId: channel.id,
      conversationId: savedConversation.id,
      assignedAgentId,
    };
  }
}
