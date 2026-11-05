import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import type { Queue } from 'bull';
import Redis from 'ioredis';
import {
  AiHandlingModeEnum,
  ConversationSupportStatusEnum,
  MembershipStatusEnum,
  RoutingStrategyEnum,
  ShiftStatusEnum,
} from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { Repository } from 'typeorm';

@Injectable()
export class ConversationRoutingEngine {
  private readonly logger = new Logger(ConversationRoutingEngine.name);

  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(ShopMemberEntity)
    private readonly shopMemberRepo: Repository<ShopMemberEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopWorkspaceRepo: Repository<ShopWorkspaceEntity>,
    @InjectRedis() private readonly redis: Redis,
    @InjectQueue('conversation_sla_queue')
    private readonly slaQueue: Queue,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  /**
   * F01.4: Định tuyến hội thoại khi có tin nhắn khách hàng mới đổ vào từ bất kỳ kênh nào (FB, Zalo, TikTok, Shopee...)
   * Hỗ trợ 4 chế độ: STICKY_AGENT, LEAST_BUSY, ROUND_ROBIN, AI_FIRST.
   */
  async routeInboundConversation(params: {
    shopId: string;
    conversation: ConversationEntity;
    channelIntegrationId: string;
    excludeUserIds?: string[];
  }): Promise<string | null> {
    const workspace = await this.shopWorkspaceRepo.findOne({
      where: { id: params.shopId },
    });
    if (!workspace) return null;

    if (
      workspace.routingStrategy === RoutingStrategyEnum.AI_FIRST &&
      !params.conversation.hasPhoneCollected &&
      params.conversation.aiHandlingMode === AiHandlingModeEnum.AUTOPILOT
    ) {
      return null;
    }

    const onlineMembers = await this.shopMemberRepo.find({
      where: {
        shopId: params.shopId,
        membershipStatus: MembershipStatusEnum.ACTIVE,
        shiftStatus: ShiftStatusEnum.ONLINE,
      },
    });

    const excludedSet = new Set(params.excludeUserIds || []);

    const eligibleAgents = onlineMembers.filter(
      (m) =>
        !excludedSet.has(m.userId) &&
        (!m.allowedChannelIdsJson ||
          m.allowedChannelIdsJson.length === 0 ||
          m.allowedChannelIdsJson.includes(params.channelIntegrationId)),
    );

    if (eligibleAgents.length === 0) {
      return params.conversation.assignedAgentId || null;
    }

    if (
      params.conversation.assignedAgentId &&
      !excludedSet.has(params.conversation.assignedAgentId)
    ) {
      const existingOnline = eligibleAgents.find(
        (a) => a.userId === params.conversation.assignedAgentId,
      );
      if (existingOnline) {
        await this.scheduleAutoReclaimWatchdog(
          workspace,
          params.conversation.id,
          existingOnline.userId,
          params.channelIntegrationId,
        );
        return existingOnline.userId;
      }
    }

    let selectedUserId: string | null = null;

    if (
      workspace.routingStrategy === RoutingStrategyEnum.LEAST_BUSY ||
      workspace.routingStrategy === RoutingStrategyEnum.STICKY_AGENT
    ) {
      const loadScores = await Promise.all(
        eligibleAgents.map(async (agent) => {
          const score = await this.redis.zscore(
            `routing:active_load:${params.shopId}`,
            agent.userId,
          );
          return {
            userId: agent.userId,
            activeLoad: score ? Number(score) : 0,
            maxCap: agent.maxConcurrentChats || 25,
          };
        }),
      );

      const available = loadScores
        .filter((a) => a.activeLoad < a.maxCap)
        .sort((a, b) => a.activeLoad - b.activeLoad);

      selectedUserId = available.length > 0 ? available[0].userId : eligibleAgents[0].userId;
    } else {
      const pointer = await this.redis.hincrby(
        `routing:rr_pointer:${params.shopId}`,
        params.channelIntegrationId,
        1,
      );
      const index = pointer % eligibleAgents.length;
      selectedUserId = eligibleAgents[index].userId;
    }

    if (selectedUserId) {
      const slaDeadlineAt = new Date(Date.now() + workspace.slaResponseSeconds * 1000);

      await this.conversationRepo.update(params.conversation.id, {
        assignedAgentId: selectedUserId,
        supportStatus: ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
        slaDeadlineAt,
      });

      await this.redis.zincrby(`routing:active_load:${params.shopId}`, 1, selectedUserId);

      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        selectedUserId,
        SOCKET_CONFIG.events.OMNICHANNEL_INBOX.CONVERSATION_ASSIGNED,
        {
          conversationId: params.conversation.id,
          shopId: params.shopId,
          channelIntegrationId: params.channelIntegrationId,
          slaDeadlineAt: slaDeadlineAt.toISOString(),
        },
      );

      await this.scheduleAutoReclaimWatchdog(
        workspace,
        params.conversation.id,
        selectedUserId,
        params.channelIntegrationId,
      );
    }

    return selectedUserId;
  }

  private async scheduleAutoReclaimWatchdog(
    workspace: ShopWorkspaceEntity,
    conversationId: string,
    assignedUserId: string,
    channelIntegrationId: string,
  ): Promise<void> {
    const delayMs = Math.max(1, workspace.autoReclaimMinutes) * 60_000;
    await this.slaQueue.add(
      'check_auto_reclaim_unanswered_lead',
      {
        shopId: workspace.id,
        conversationId,
        assignedUserId,
        channelIntegrationId,
        assignedAtUnix: Date.now(),
      },
      {
        delay: delayMs,
        jobId: `reclaim:${conversationId}:${assignedUserId}:${Date.now()}`,
        removeOnComplete: true,
      },
    );
  }
}
