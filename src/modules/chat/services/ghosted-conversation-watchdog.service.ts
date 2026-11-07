import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { ConversationSupportStatusEnum } from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { Repository } from 'typeorm';

@Injectable()
export class GhostedConversationWatchdogService {
  private readonly logger = new Logger(GhostedConversationWatchdogService.name);

  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  /**
   * Công cụ T03 & F03.1:
   * Chạy mỗi 30 giây để phát hiện:
   * 1. Hội thoại "Đã xem nhưng bỏ quên" (Ghosted: first_seen_at <= NOW() - 180s mà chưa trả lời).
   * 2. Hội thoại quá hạn SLA (sla_deadline_at <= NOW() mà chưa trả lời).
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async detectAndFlagGhostedAndSlaBreachedConversations(): Promise<void> {
    try {
      // 1. Quét hội thoại Ghosted (Đã mở xem > 180 giây nhưng chưa phản hồi)
      const newlyGhosted = await this.conversationRepo
        .createQueryBuilder('conv')
        .where('conv.support_status = :status', {
          status: ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
        })
        .andWhere('conv.is_ghosted_by_agent = false')
        .andWhere('conv.first_seen_at IS NOT NULL')
        .andWhere('conv.first_seen_at <= DATE_SUB(NOW(), INTERVAL 180 SECOND)')
        .andWhere(
          '(conv.last_agent_reply_at IS NULL OR conv.last_agent_reply_at < conv.last_customer_message_at)',
        )
        .select([
          'conv.id',
          'conv.shopId',
          'conv.assignedAgentId',
          'conv.firstSeenByAgentId',
          'conv.name',
          'conv.firstSeenAt',
        ])
        .getMany();

      if (newlyGhosted.length > 0) {
        const ghostedIds = newlyGhosted.map((c) => c.id);
        await this.conversationRepo
          .createQueryBuilder()
          .update(ConversationEntity)
          .set({ isGhostedByAgent: true })
          .whereInIds(ghostedIds)
          .execute();

        for (const conv of newlyGhosted) {
          const targetAgentId = conv.assignedAgentId || conv.firstSeenByAgentId;
          const alertPayload = {
            conversationId: conv.id,
            shopId: conv.shopId,
            customerName: conv.name || 'Khách hàng',
            firstSeenAt: conv.firstSeenAt ? conv.firstSeenAt.toISOString() : null,
            assignedAgentId: targetAgentId,
          };

          this.realtimeEmitter.emitToConversation(
            SOCKET_CONFIG.namespaces.CHAT,
            conv.id,
            SOCKET_CONFIG.events.OMNICHANNEL_INBOX.GHOSTED_ALERT,
            alertPayload,
          );

          if (targetAgentId) {
            this.realtimeEmitter.emitToUser(
              SOCKET_CONFIG.namespaces.CHAT,
              targetAgentId,
              SOCKET_CONFIG.events.OMNICHANNEL_INBOX.GHOSTED_ALERT,
              alertPayload,
            );
          }
        }
      }

      // 2. Quét hội thoại vi phạm SLA (sla_deadline_at <= NOW())
      const newlyBreached = await this.conversationRepo
        .createQueryBuilder('conv')
        .where('conv.support_status = :status', {
          status: ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
        })
        .andWhere('conv.is_sla_breached = false')
        .andWhere('conv.sla_deadline_at IS NOT NULL')
        .andWhere('conv.sla_deadline_at <= NOW()')
        .select(['conv.id', 'conv.shopId', 'conv.assignedAgentId', 'conv.name'])
        .getMany();

      if (newlyBreached.length > 0) {
        const breachedIds = newlyBreached.map((c) => c.id);
        await this.conversationRepo
          .createQueryBuilder()
          .update(ConversationEntity)
          .set({ isSlaBreached: true })
          .whereInIds(breachedIds)
          .execute();

        for (const conv of newlyBreached) {
          if (conv.assignedAgentId) {
            this.realtimeEmitter.emitToUser(
              SOCKET_CONFIG.namespaces.CHAT,
              conv.assignedAgentId,
              SOCKET_CONFIG.events.OMNICHANNEL_INBOX.SLA_WARNING_TICK,
              {
                conversationId: conv.id,
                shopId: conv.shopId,
                customerName: conv.name || 'Khách hàng',
                isSlaBreached: true,
              },
            );
          }
        }
      }
    } catch (err) {
      this.logger.warn(`GhostedWatchdog tick warning: ${String(err)}`);
    }
  }
}
