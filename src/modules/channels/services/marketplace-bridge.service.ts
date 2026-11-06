import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  ChannelTypeEnum,
  ConversationSupportStatusEnum,
  ConversationTypeEnum,
  MembershipStatusEnum,
  NotificationResourceTypeEnum,
  NotificationTypeEnum,
  ShopRoleEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { ChannelIntegrationEntity } from 'src/entity/channel-integration.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
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

@Injectable()
export class MarketplaceBridgeService {
  private readonly logger = new Logger(MarketplaceBridgeService.name);

  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    @InjectRepository(ShopMemberEntity)
    private readonly memberRepo: Repository<ShopMemberEntity>,
    @InjectRedis() private readonly redis: Redis,
    private readonly routingEngine: ConversationRoutingEngine,
    private readonly notificationsService: NotificationsService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

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

    let reservedStockItemsCount = 0;
    if (shouldAutoReserve && items.length > 0) {
      const reserveKey = `marketplace:stock_reserve:${shopId}:${orderSn}`;
      await this.redis.set(
        reserveKey,
        JSON.stringify({
          orderSn,
          channelType: channel.channelType,
          channelIntegrationId: channel.id,
          orderStatus,
          items,
          reservedAt: new Date().toISOString(),
        }),
        'EX',
        7 * 86400,
      );
      reservedStockItemsCount = items.reduce((acc, it) => acc + Number(it.quantity || 1), 0);
    }

    const externalThreadId = `mkt_${channel.channelType.toLowerCase()}_${buyerUsername || orderSn}`;
    const summaryLine =
      params.inquiryText ||
      `[Đơn sàn ${channel.pageShortCode} #${orderSn}] ${items.map((i) => `${i.itemName} x${i.quantity}`).join(', ') || 'Đơn hàng mới'} — ${Number(totalAmount || 0).toLocaleString('vi-VN')}đ`;

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
}
