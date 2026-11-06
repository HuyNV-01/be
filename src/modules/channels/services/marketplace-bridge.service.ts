import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
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
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { ChannelIntegrationEntity } from 'src/entity/channel-integration.entity';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { MessageDirectionEnum, MessageEntity } from 'src/entity/message.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { MessageCryptoService } from 'src/modules/chat/services/message-crypto.service';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import { Repository } from 'typeorm';

import { ConversationRoutingEngine } from '../routing/conversation-routing.engine';

export interface MarketplaceOrderItemPayload {
  externalItemId: string;
  skuCode?: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
}

export interface SyncMarketplaceEventParams {
  shopId: string;
  channel: ChannelIntegrationEntity;
  orderSn: string;
  buyerUsername: string;
  orderStatus: string;
  totalAmount: number;
  items: MarketplaceOrderItemPayload[];
  inquiryText?: string;
}

export interface MarketplaceStockReservationRecord {
  orderSn: string;
  channelType: ChannelTypeEnum;
  channelIntegrationId: string;
  pageShortCode: string;
  buyerUsername: string;
  orderStatus: string;
  totalAmount: number;
  items: Array<MarketplaceOrderItemPayload & { mappedVariantId: string }>;
  reservedAt: string;
  conversationId?: string;
}

@Injectable()
export class MarketplaceBridgeService {
  private readonly logger = new Logger(MarketplaceBridgeService.name);

  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(ConversationParticipantEntity)
    private readonly participantRepo: Repository<ConversationParticipantEntity>,
    @InjectRepository(MessageEntity)
    private readonly messageRepo: Repository<MessageEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    @InjectRepository(ShopMemberEntity)
    private readonly memberRepo: Repository<ShopMemberEntity>,
    @InjectRedis() private readonly redis: Redis,
    private readonly messageCryptoService: MessageCryptoService,
    private readonly routingEngine: ConversationRoutingEngine,
    private readonly notificationsService: NotificationsService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private async ensureParticipants(conversationId: string, userIds: string[]): Promise<void> {
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

  async syncMarketplaceOrderAndConversation(params: SyncMarketplaceEventParams): Promise<{
    conversationId: string;
    assignedAgentId: string | null;
    reservedStockItemsCount: number;
    orderSn: string;
  }> {
    const { shopId, channel, orderSn, buyerUsername, orderStatus, totalAmount, items } = params;

    const shop = await this.shopRepo.findOne({ where: { id: shopId } });
    const shouldAutoReserve =
      shop?.marketplaceSyncConfigJson?.autoReserveStockOnMarketplaceOrder ?? true;

    const mappedItems = await Promise.all(
      items.map(async (item) => {
        const mappedVariantId =
          (await this.redis.hget(
            `marketplace:sku_map:${shopId}`,
            item.skuCode || item.externalItemId,
          )) || `var_${(item.skuCode || item.externalItemId).toLowerCase()}`;
        return {
          ...item,
          mappedVariantId,
        };
      }),
    );

    let reservedStockItemsCount = 0;
    if (shouldAutoReserve && mappedItems.length > 0) {
      reservedStockItemsCount = mappedItems.reduce((acc, it) => acc + Number(it.quantity || 1), 0);
    }

    const externalThreadId = `mkt_${channel.channelType.toLowerCase()}_${buyerUsername || orderSn}`;
    const summaryLine =
      params.inquiryText ||
      `[Đơn sàn ${channel.pageShortCode} #${orderSn}] ${mappedItems.map((i) => `${i.itemName} x${i.quantity}`).join(', ') || 'Đơn hàng mới'} — ${Number(totalAmount || 0).toLocaleString('vi-VN')}đ`;

    let conversation = await this.conversationRepo.findOne({
      where: {
        shopId,
        channelIntegrationId: channel.id,
        externalThreadId,
      },
    });

    const now = new Date();
    if (!conversation) {
      conversation = this.conversationRepo.create({
        type: ConversationTypeEnum.DIRECT,
        shopId,
        channelType: channel.channelType as ChannelTypeEnum,
        channelIntegrationId: channel.id,
        externalThreadId,
        name: `${buyerUsername} (${channel.pageShortCode})`,
        lastMessage: summaryLine,
        lastMessageAt: now,
        lastCustomerMessageAt: now,
        hasOrderCreated: true,
        supportStatus: ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
        activeTagIdsJson: [],
      });
    } else {
      conversation.lastMessage = summaryLine;
      conversation.lastMessageAt = now;
      conversation.lastCustomerMessageAt = now;
      conversation.hasOrderCreated = true;
      conversation.supportStatus = ConversationSupportStatusEnum.WAITING_AGENT_REPLY;
    }

    const savedConversation = await this.conversationRepo.save(conversation);

    // Mã hóa nội dung tin nhắn và cập nhật lastMessage chuẩn AES-256-GCM tương thích ChatService
    const encryptedMsg = this.messageCryptoService.encryptForConversation(
      summaryLine,
      savedConversation.id,
    );

    await this.conversationRepo.update(savedConversation.id, {
      lastMessage: encryptedMsg.ciphertext,
      lastMessageType: MessageTypeEnum.TEXT,
      lastMessageAt: now,
    });

    const assignedAgentId = await this.routingEngine.routeInboundConversation({
      shopId,
      conversation: savedConversation,
      channelIntegrationId: channel.id,
    });

    const activeMembers = await this.memberRepo.find({
      where: {
        shopId,
        membershipStatus: MembershipStatusEnum.ACTIVE,
      },
      select: ['userId', 'role'],
    });

    const managerAndAssignedIds = activeMembers
      .filter(
        (m) =>
          m.role === ShopRoleEnum.SHOP_OWNER ||
          m.role === ShopRoleEnum.SHOP_MANAGER ||
          m.userId === assignedAgentId,
      )
      .map((m) => m.userId);
    if (shop?.ownerId) {
      managerAndAssignedIds.push(shop.ownerId);
    }
    if (assignedAgentId) {
      managerAndAssignedIds.push(assignedAgentId);
    }

    await this.ensureParticipants(savedConversation.id, managerAndAssignedIds);

    const inboundSenderId = `ext:${channel.channelType.toLowerCase()}:${orderSn.slice(0, 18)}`;
    const inboundMessage = this.messageRepo.create({
      conversationId: savedConversation.id,
      senderId: inboundSenderId,
      shopId,
      direction: MessageDirectionEnum.INBOUND,
      externalMessageId: `mkt_order_${orderSn}`,
      content: encryptedMsg.ciphertext,
      type: MessageTypeEnum.TEXT,
      status: MessageStatusEnum.SENT,
      readBy: [],
      deliveredTo: managerAndAssignedIds,
      isPinned: false,
      metadata: {
        isEncrypted: encryptedMsg.isEncrypted,
        encryptionAlg: encryptedMsg.algorithm,
        marketplaceOrder: {
          orderSn,
          buyerUsername,
          orderStatus,
          totalAmount,
          reservedStockItemsCount,
          items: mappedItems,
          channelType: channel.channelType,
          pageShortCode: channel.pageShortCode,
        },
      } as any,
      createdAt: now,
      updatedAt: now,
    });
    const savedMsg = await this.messageRepo.save(inboundMessage);

    if (shouldAutoReserve && mappedItems.length > 0) {
      const reserveKey = `marketplace:stock_reserve:${shopId}:${orderSn}`;
      const record: MarketplaceStockReservationRecord = {
        orderSn,
        channelType: channel.channelType,
        channelIntegrationId: channel.id,
        pageShortCode: channel.pageShortCode,
        buyerUsername,
        orderStatus,
        totalAmount,
        items: mappedItems,
        reservedAt: now.toISOString(),
        conversationId: savedConversation.id,
      };
      await this.redis.set(reserveKey, JSON.stringify(record), 'EX', 7 * 86400);
      await this.redis.lpush(`marketplace:reserve_index:${shopId}`, reserveKey);
      await this.redis.ltrim(`marketplace:reserve_index:${shopId}`, 0, 99);
    }

    for (const m of activeMembers) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        m.userId,
        SOCKET_CONFIG.events.CHANNELS.MARKETPLACE_ORDER_SYNCED,
        {
          shopId,
          channelIntegrationId: channel.id,
          channelType: channel.channelType,
          pageShortCode: channel.pageShortCode,
          orderSn,
          buyerUsername,
          totalAmount,
          reservedStockItemsCount,
          conversationId: savedConversation.id,
          assignedAgentId,
        },
      );

      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        m.userId,
        SOCKET_CONFIG.events.CHAT.NEW_MESSAGE,
        {
          ...savedMsg,
          content: summaryLine,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          sender: {
            id: inboundSenderId,
            name: `${buyerUsername} (${channel.pageShortCode})`,
            avatar: channel.avatarUrl || null,
          },
        },
      );
    }

    const notifyTargets = new Set<string>();
    if (assignedAgentId) {
      notifyTargets.add(assignedAgentId);
    }
    for (const m of activeMembers) {
      if (
        m.role === ShopRoleEnum.SHOP_OWNER ||
        m.role === ShopRoleEnum.SHOP_MANAGER ||
        m.role === ShopRoleEnum.WAREHOUSE_PACKER
      ) {
        notifyTargets.add(m.userId);
      }
    }

    if (notifyTargets.size > 0) {
      await this.notificationsService.createAndDispatch({
        recipientIds: Array.from(notifyTargets),
        actorId: null,
        type: NotificationTypeEnum.MARKETPLACE_ORDER_SYNCED,
        title: `Đơn hàng sàn ${channel.pageShortCode} #${orderSn}`,
        content: `Khách ${buyerUsername} vừa đặt đơn #${orderSn} (${Number(totalAmount || 0).toLocaleString('vi-VN')}đ). Đã tự động giữ chỗ ${reservedStockItemsCount} sản phẩm tồn kho.`,
        resourceType: NotificationResourceTypeEnum.CONVERSATION,
        resourceId: savedConversation.id,
        dedupeKey: `mkt_order:${shopId}:${orderSn}`,
        metadata: {
          conversationId: savedConversation.id,
          actionUrl: `/chat/${savedConversation.id}`,
          titleKey: 'i18n.marketplaceOrderSynced.title',
          contentKey: 'i18n.marketplaceOrderSynced.content',
          i18nParams: {
            pageShortCode: channel.pageShortCode,
            orderSn,
            buyerUsername,
            totalFormatted: `${Number(totalAmount || 0).toLocaleString('vi-VN')}đ`,
            reservedQty: reservedStockItemsCount,
          },
        },
      });
    }

    return {
      conversationId: savedConversation.id,
      assignedAgentId,
      reservedStockItemsCount,
      orderSn,
    };
  }

  async getMarketplaceStockReservations(
    shopId: string,
  ): Promise<MarketplaceStockReservationRecord[]> {
    const keys = await this.redis.lrange(`marketplace:reserve_index:${shopId}`, 0, 49);
    if (!keys || keys.length === 0) return [];

    const uniqueKeys = Array.from(new Set(keys));
    const rawValues = await this.redis.mget(...uniqueKeys);

    const records: MarketplaceStockReservationRecord[] = [];
    for (const raw of rawValues) {
      if (!raw) continue;
      try {
        records.push(JSON.parse(raw) as MarketplaceStockReservationRecord);
      } catch {}
    }
    return records;
  }
}
