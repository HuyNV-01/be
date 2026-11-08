import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { ConversationSupportStatusEnum } from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { DatabaseEvolutionService } from 'src/config/databases/database-evolution.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { SnoozeConversationDto } from 'src/dto/chat/omnichannel-inbox.dto';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { LessThanOrEqual, Repository } from 'typeorm';

import { AccountabilityTimelineService } from './accountability-timeline.service';

@Injectable()
export class ConversationSnoozeService {
  private readonly logger = new Logger(ConversationSnoozeService.name);

  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    private readonly accountabilityService: AccountabilityTimelineService,
    private readonly realtimeEmitter: RealtimeEmitterService,
    private readonly databaseEvolutionService: DatabaseEvolutionService,
  ) {}

  /**
   * F03.6: Đặt lịch hẹn nhắc chăm sóc lại (Snooze Conversation)
   */
  async snoozeConversation(params: {
    conversationId: string;
    actorUserId: string;
    dto: SnoozeConversationDto;
  }): Promise<ConversationEntity> {
    const conv = await this.conversationRepo.findOne({
      where: { id: params.conversationId },
    });
    if (!conv) {
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    const wakeAt = new Date(params.dto.snoozedUntilAt);
    if (Number.isNaN(wakeAt.getTime()) || wakeAt.getTime() <= Date.now()) {
      throw new BadRequestException('SNOOZE_TIME_MUST_BE_IN_FUTURE');
    }

    conv.supportStatus = ConversationSupportStatusEnum.SNOOZED;
    conv.snoozedUntilAt = wakeAt;
    conv.snoozeNote = params.dto.snoozeNote?.trim() || null;
    conv.snoozedByUserId = params.actorUserId;
    conv.isGhostedByAgent = false;

    const saved = await this.conversationRepo.save(conv);

    await this.accountabilityService.appendMilestone({
      conversationId: conv.id,
      eventCode: 'CONVERSATION_SNOOZED',
      actorUserId: params.actorUserId,
      note: conv.snoozeNote || `Hẹn nhắc lại lúc ${wakeAt.toISOString()}`,
    });

    const payload = {
      conversationId: conv.id,
      shopId: conv.shopId,
      supportStatus: conv.supportStatus,
      snoozedUntilAt: wakeAt.toISOString(),
      snoozeNote: conv.snoozeNote,
      snoozedByUserId: params.actorUserId,
    };

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      conv.id,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.CONVERSATION_SNOOZED,
      payload,
    );

    if (conv.assignedAgentId) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        conv.assignedAgentId,
        SOCKET_CONFIG.events.OMNICHANNEL_INBOX.CONVERSATION_SNOOZED,
        payload,
      );
    }

    return saved;
  }

  async cancelSnooze(params: {
    conversationId: string;
    actorUserId: string;
  }): Promise<ConversationEntity> {
    const conv = await this.conversationRepo.findOne({
      where: { id: params.conversationId },
    });
    if (!conv) {
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    const now = new Date();
    const noteSnapshot = conv.snoozeNote;
    conv.supportStatus = ConversationSupportStatusEnum.WAITING_AGENT_REPLY;
    conv.snoozedUntilAt = null;
    conv.snoozeNote = null;
    conv.isGhostedByAgent = false;
    conv.firstSeenAt = null;
    const saved = await this.conversationRepo.save(conv);

    await this.accountabilityService.appendMilestone({
      conversationId: conv.id,
      eventCode: 'CONVERSATION_UNSNOOZED',
      actorUserId: params.actorUserId,
      note: noteSnapshot || 'Hủy hẹn giờ Snooze thủ công',
    });

    const wakeupPayload = {
      conversationId: conv.id,
      shopId: conv.shopId,
      customerName: conv.name || 'Khách hàng',
      snoozeNote: noteSnapshot,
      assignedAgentId: conv.assignedAgentId || params.actorUserId,
      wokenAt: now.toISOString(),
    };

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      conv.id,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.SNOOZE_WAKEUP,
      wakeupPayload,
    );

    return saved;
  }

  /**
   * Cronjob chạy mỗi 30 giây để đánh thức các cuộc hội thoại đã đến giờ hẹn chăm sóc
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async wakeUpDueSnoozedConversations(): Promise<void> {
    if (!this.databaseEvolutionService.isReady()) {
      return;
    }

    try {
      const now = new Date();
      const dueConvs = await this.conversationRepo.find({
        where: {
          supportStatus: ConversationSupportStatusEnum.SNOOZED,
          snoozedUntilAt: LessThanOrEqual(now),
        },
        take: 50,
      });

      if (dueConvs.length === 0) return;

      for (const conv of dueConvs) {
        const noteSnapshot = conv.snoozeNote;
        const targetAgent = conv.snoozedByUserId || conv.assignedAgentId;

        conv.supportStatus = ConversationSupportStatusEnum.WAITING_AGENT_REPLY;
        conv.snoozedUntilAt = null;
        conv.isGhostedByAgent = false;
        conv.firstSeenAt = null;
        conv.lastMessageAt = now;
        await this.conversationRepo.save(conv);

        await this.accountabilityService.appendMilestone({
          conversationId: conv.id,
          eventCode: 'CONVERSATION_UNSNOOZED',
          actorUserId: targetAgent || null,
          note: noteSnapshot || 'Đến giờ hẹn chăm sóc lại khách hàng (Snooze Wakeup)',
        });

        const wakeupPayload = {
          conversationId: conv.id,
          shopId: conv.shopId,
          customerName: conv.name || 'Khách hàng',
          snoozeNote: noteSnapshot,
          assignedAgentId: targetAgent,
          wokenAt: now.toISOString(),
        };

        this.realtimeEmitter.emitToConversation(
          SOCKET_CONFIG.namespaces.CHAT,
          conv.id,
          SOCKET_CONFIG.events.OMNICHANNEL_INBOX.SNOOZE_WAKEUP,
          wakeupPayload,
        );

        if (targetAgent) {
          this.realtimeEmitter.emitToUser(
            SOCKET_CONFIG.namespaces.CHAT,
            targetAgent,
            SOCKET_CONFIG.events.OMNICHANNEL_INBOX.SNOOZE_WAKEUP,
            wakeupPayload,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`ConversationSnoozeService wakeup warning: ${String(err)}`);
    }
  }
}
