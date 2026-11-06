import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import type { Job } from 'bull';
import Redis from 'ioredis';
import { NotificationResourceTypeEnum, NotificationTypeEnum } from 'src/common/enum';
import { ConversationSupportStatusEnum } from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import { Repository } from 'typeorm';

import { ConversationRoutingEngine } from '../routing/conversation-routing.engine';

interface AutoReclaimJobPayload {
  shopId: string;
  conversationId: string;
  assignedUserId: string;
  channelIntegrationId: string;
  assignedAtUnix: number;
}

@Processor('conversation_sla_queue')
export class ConversationSlaProcessor {
  private readonly logger = new Logger(ConversationSlaProcessor.name);

  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRedis() private readonly redis: Redis,
    private readonly routingEngine: ConversationRoutingEngine,
    private readonly realtimeEmitter: RealtimeEmitterService,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Process('check_auto_reclaim_unanswered_lead')
  async handleAutoReclaimUnansweredLead(job: Job<AutoReclaimJobPayload>): Promise<void> {
    const { shopId, conversationId, assignedUserId, channelIntegrationId, assignedAtUnix } =
      job.data;

    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId, shopId },
    });

    if (!conversation) return;

    if (
      conversation.assignedAgentId !== assignedUserId ||
      conversation.supportStatus !== ConversationSupportStatusEnum.WAITING_AGENT_REPLY
    ) {
      return;
    }

    const repliedAfterAssign =
      conversation.lastAgentReplyAt && conversation.lastAgentReplyAt.getTime() >= assignedAtUnix;

    if (repliedAfterAssign) {
      return;
    }

    await this.redis.zincrby(`routing:active_load:${shopId}`, -1, assignedUserId);
    await this.redis.hincrby(`sla:reclaimed_penalty:${shopId}`, assignedUserId, 1);

    const customerName = conversation.name || 'Khách hàng';

    this.realtimeEmitter.emitToUser(
      SOCKET_CONFIG.namespaces.CHAT,
      assignedUserId,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.CONVERSATION_RECLAIMED,
      {
        conversationId,
        conversationName: customerName,
        shopId,
        previousAgentId: assignedUserId,
        reason: 'SLA_AUTO_RECLAIM_TIMEOUT',
      },
    );

    await this.notificationsService.createAndDispatch({
      recipientIds: [assignedUserId],
      actorId: null,
      type: NotificationTypeEnum.INBOX_SLA_RECLAIMED,
      title: `Thu hồi tự động hội thoại quá hạn SLA`,
      content: `Hội thoại với "${customerName}" đã được hệ thống thu hồi và chuyển cho đồng nghiệp khác do quá thời gian cam kết phản hồi.`,
      resourceType: NotificationResourceTypeEnum.CONVERSATION,
      resourceId: conversationId,
      dedupeKey: `sla_reclaim:${conversationId}:${assignedUserId}:${Date.now()}`,
      metadata: {
        conversationId,
        conversationName: customerName,
        actionUrl: '/chat',
        titleKey: 'i18n.inboxSlaReclaimed.title',
        contentKey: 'i18n.inboxSlaReclaimed.content',
        i18nParams: {
          customerName,
        },
      },
    });

    conversation.assignedAgentId = null;
    await this.conversationRepo.save(conversation);

    await this.routingEngine.routeInboundConversation({
      shopId,
      conversation,
      channelIntegrationId: channelIntegrationId || conversation.channelIntegrationId || '',
      excludeUserIds: [assignedUserId],
    });
  }
}
