import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { GroupRoleEnum } from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { TransferConversationDto } from 'src/dto/chat/omnichannel-inbox.dto';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { AccountabilityMilestoneItem, ConversationEntity } from 'src/entity/conversation.entity';
import { UserEntity } from 'src/entity/user.entity';
import { Repository } from 'typeorm';

@Injectable()
export class AccountabilityTimelineService {
  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(ConversationParticipantEntity)
    private readonly participantRepo: Repository<ConversationParticipantEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  /**
   * F03.9: Ghi nhận bất biến từng cột mốc trách nhiệm (Accountability Timeline) trên cuộc hội thoại
   */
  async appendMilestone(params: {
    conversationId: string;
    eventCode: AccountabilityMilestoneItem['eventCode'];
    actorUserId?: string | null;
    targetUserId?: string | null;
    note?: string | null;
  }): Promise<AccountabilityMilestoneItem[]> {
    const conv = await this.conversationRepo.findOne({
      where: { id: params.conversationId },
    });
    if (!conv) return [];

    const userIdsToFetch = [params.actorUserId, params.targetUserId].filter((id): id is string =>
      Boolean(id),
    );
    const users = userIdsToFetch.length > 0 ? await this.userRepo.findByIds(userIdsToFetch) : [];
    const userMap = new Map(users.map((u) => [u.id, u.name || u.email]));

    const currentTimeline: AccountabilityMilestoneItem[] = Array.isArray(
      conv.accountabilityTimelineJson,
    )
      ? [...conv.accountabilityTimelineJson]
      : [];

    const now = new Date();
    const elapsedSecondsFromInbound = conv.lastCustomerMessageAt
      ? Math.max(
          0,
          Math.round((now.getTime() - new Date(conv.lastCustomerMessageAt).getTime()) / 1000),
        )
      : null;

    const milestone: AccountabilityMilestoneItem = {
      eventCode: params.eventCode,
      actorUserId: params.actorUserId || null,
      actorName: params.actorUserId ? userMap.get(params.actorUserId) || null : null,
      targetUserId: params.targetUserId || null,
      targetUserName: params.targetUserId ? userMap.get(params.targetUserId) || null : null,
      note: params.note || null,
      elapsedSecondsFromInbound,
      timestamp: now.toISOString(),
    };

    currentTimeline.push(milestone);

    await this.conversationRepo.update(conv.id, {
      accountabilityTimelineJson: currentTimeline,
    });

    return currentTimeline;
  }

  /**
   * F03.8: Chuyển giao cuộc hội thoại cho đồng nghiệp kèm ghi chú bàn giao
   */
  async transferConversation(params: {
    conversationId: string;
    actorUserId: string;
    dto: TransferConversationDto;
  }): Promise<{
    conversation: ConversationEntity;
    timeline: AccountabilityMilestoneItem[];
  }> {
    const conv = await this.conversationRepo.findOne({
      where: { id: params.conversationId },
    });
    if (!conv) {
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    conv.assignedAgentId = params.dto.targetAgentId;
    const saved = await this.conversationRepo.save(conv);

    // Đảm bảo nhân sự nhận bàn giao có trong danh sách participant để đọc/trả lời ngay
    const existingPart = await this.participantRepo.findOne({
      where: {
        conversationId: conv.id,
        userId: params.dto.targetAgentId,
      },
    });
    if (!existingPart) {
      await this.participantRepo.save(
        this.participantRepo.create({
          conversationId: conv.id,
          userId: params.dto.targetAgentId,
          role: GroupRoleEnum.MEMBER,
          isAdmin: false,
          isHidden: false,
          joinedAt: new Date(),
        }),
      );
    }

    const timeline = await this.appendMilestone({
      conversationId: conv.id,
      eventCode: 'CONVERSATION_TRANSFERRED',
      actorUserId: params.actorUserId,
      targetUserId: params.dto.targetAgentId,
      note: params.dto.transferNote || null,
    });

    const payload = {
      conversationId: conv.id,
      shopId: conv.shopId,
      fromAgentId: params.actorUserId,
      toAgentId: params.dto.targetAgentId,
      transferNote: params.dto.transferNote || null,
      timeline,
    };

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      conv.id,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.CONVERSATION_TRANSFERRED,
      payload,
    );

    this.realtimeEmitter.emitToUser(
      SOCKET_CONFIG.namespaces.CHAT,
      params.dto.targetAgentId,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.CONVERSATION_ASSIGNED,
      {
        conversationId: conv.id,
        conversationName: conv.name || 'Khách hàng',
        lastMessage: params.dto.transferNote || 'Nhận bàn giao hội thoại từ đồng nghiệp',
        shopId: conv.shopId || '',
        channelIntegrationId: conv.channelIntegrationId || '',
        pageShortCode: conv.channelType,
        slaDeadlineAt: conv.slaDeadlineAt
          ? conv.slaDeadlineAt.toISOString()
          : new Date(Date.now() + 180_000).toISOString(),
        slaResponseSeconds: 180,
      },
    );

    return { conversation: saved, timeline };
  }
}
