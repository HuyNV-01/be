import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import {
  ConversationSupportStatusEnum,
  CustomerTierEnum,
  CustomerWalletLedgerTypeEnum,
  CustomerWalletTransactionTypeEnum,
  MembershipStatusEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { ConversationEntity } from 'src/entity/conversation.entity';
import {
  CustomTagEntity,
  TagWorkflowActionItem,
  TagWorkflowExecutionCondition,
} from 'src/entity/custom-tag.entity';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { CustomerWalletLedgerEntity } from 'src/entity/customer-wallet-ledger.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { Repository } from 'typeorm';

export interface TagWorkflowExecutionSummary {
  tagId: string;
  tagName: string;
  trigger: 'ON_APPLY' | 'ON_REMOVE';
  executedActions: Array<{
    actionId: string;
    actionType: string;
    status: 'EXECUTED' | 'SKIPPED' | 'FAILED';
    detail?: string;
  }>;
}

@Injectable()
export class TagActionWorkflowExecutor {
  private readonly logger = new Logger(TagActionWorkflowExecutor.name);

  constructor(
    @InjectRepository(CustomTagEntity)
    private readonly customTagRepo: Repository<CustomTagEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(CustomerWalletLedgerEntity)
    private readonly walletLedgerRepo: Repository<CustomerWalletLedgerEntity>,
    @InjectRepository(ShopMemberEntity)
    private readonly shopMemberRepo: Repository<ShopMemberEntity>,
    @InjectRedis()
    private readonly redis: Redis,
    private readonly eventEmitter: EventEmitter2,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private matchesCondition(
    conversation: ConversationEntity,
    condition: TagWorkflowExecutionCondition | null | undefined,
  ): boolean {
    if (!condition) return true;
    if (
      Array.isArray(condition.channelTypes) &&
      condition.channelTypes.length > 0 &&
      conversation.channelType &&
      !condition.channelTypes.includes(conversation.channelType)
    ) {
      return false;
    }
    if (
      Array.isArray(condition.interactionTypes) &&
      condition.interactionTypes.length > 0 &&
      conversation.interactionType &&
      !condition.interactionTypes.includes(conversation.interactionType as any)
    ) {
      return false;
    }
    if (condition.onlyWhenCustomerHasPhone && !conversation.hasPhoneCollected) {
      return false;
    }
    return true;
  }

  public async executeTagWorkflows(params: {
    shopId: string;
    conversation: ConversationEntity;
    tag: CustomTagEntity;
    trigger: 'ON_APPLY' | 'ON_REMOVE';
    actorUserId: string;
    recursionDepth?: number;
  }): Promise<TagWorkflowExecutionSummary> {
    const depth = params.recursionDepth ?? 0;
    const summary: TagWorkflowExecutionSummary = {
      tagId: params.tag.id,
      tagName: params.tag.name,
      trigger: params.trigger,
      executedActions: [],
    };

    // Chống vòng lặp vô hạn khi Tag A tự gắn Tag B rồi Tag B lại gắn Tag A
    if (depth >= 2) {
      return summary;
    }

    const actions: TagWorkflowActionItem[] =
      params.trigger === 'ON_APPLY'
        ? Array.isArray(params.tag.onApplyActionsJson)
          ? params.tag.onApplyActionsJson
          : []
        : Array.isArray(params.tag.onRemoveActionsJson)
          ? params.tag.onRemoveActionsJson
          : [];

    const enabledActions = actions.filter((a) => a && a.isEnabled !== false);
    if (enabledActions.length === 0) {
      return summary;
    }

    if (!this.matchesCondition(params.conversation, params.tag.executionConditionJson)) {
      return summary;
    }

    // Kiểm tra cooldown chống gửi lặp nếu nhân viên bấm nhầm gắn/gỡ liên tục
    const cooldownMinutes = Number(
      params.tag.executionConditionJson?.cooldownMinutesPerConversation || 0,
    );
    if (cooldownMinutes > 0) {
      const cooldownKey = `tag_wf_cd:${params.tag.id}:${params.conversation.id}:${params.trigger}`;
      const acquired = await this.redis.set(cooldownKey, '1', 'EX', cooldownMinutes * 60, 'NX');
      if (!acquired) {
        summary.executedActions.push({
          actionId: 'cooldown_guard',
          actionType: 'COOLDOWN',
          status: 'SKIPPED',
          detail: `Đang trong thời gian chống lặp ${cooldownMinutes} phút`,
        });
        return summary;
      }
    }

    let executedCount = 0;

    for (const action of enabledActions) {
      try {
        switch (action.actionType) {
          case 'ASSIGN_AGENT_OR_TEAM': {
            let targetUserId = action.targetAgentUserId || null;
            if (!targetUserId && action.targetTeamCode) {
              const teamMember = await this.shopMemberRepo.findOne({
                where: {
                  shopId: params.shopId,
                  teamCode: action.targetTeamCode,
                  membershipStatus: MembershipStatusEnum.ACTIVE,
                },
                order: { updatedAt: 'ASC' },
              });
              targetUserId = teamMember?.userId || null;
            }
            if (targetUserId) {
              await this.conversationRepo.update(
                { id: params.conversation.id, shopId: params.shopId },
                { assignedAgentId: targetUserId },
              );
              this.realtimeEmitter.emitToConversation(
                SOCKET_CONFIG.namespaces.CHAT,
                params.conversation.id,
                SOCKET_CONFIG.events.OMNICHANNEL_INBOX.CONVERSATION_ASSIGNED,
                {
                  conversationId: params.conversation.id,
                  shopId: params.shopId,
                  assignedAgentId: targetUserId,
                  source: `TAG_WORKFLOW:${params.tag.slug}`,
                },
              );
              summary.executedActions.push({
                actionId: action.id,
                actionType: action.actionType,
                status: 'EXECUTED',
                detail: `Đã chuyển phụ trách sang nhân sự ${targetUserId}`,
              });
              executedCount += 1;
            }
            break;
          }

          case 'SET_SNOOZE': {
            const mins = Math.max(5, Number(action.snoozeMinutes || 60));
            const wakeAt = new Date(Date.now() + mins * 60_000);
            await this.conversationRepo.update(
              { id: params.conversation.id, shopId: params.shopId },
              {
                supportStatus: ConversationSupportStatusEnum.SNOOZED,
                snoozedUntilAt: wakeAt,
                snoozeNote: action.snoozeNote || `Hẹn tự động từ Tag "${params.tag.name}"`,
                snoozedByUserId: params.actorUserId,
              },
            );
            this.realtimeEmitter.emitToConversation(
              SOCKET_CONFIG.namespaces.CHAT,
              params.conversation.id,
              SOCKET_CONFIG.events.OMNICHANNEL_INBOX.CONVERSATION_SNOOZED,
              {
                conversationId: params.conversation.id,
                snoozedUntilAt: wakeAt.toISOString(),
                source: `TAG_WORKFLOW:${params.tag.slug}`,
              },
            );
            summary.executedActions.push({
              actionId: action.id,
              actionType: action.actionType,
              status: 'EXECUTED',
              detail: `Đã hẹn chăm sóc lại sau ${mins} phút`,
            });
            executedCount += 1;
            break;
          }

          case 'UPDATE_CUSTOMER_TIER': {
            if (params.conversation.customerId && action.customerTier) {
              const customer = await this.customerRepo.findOne({
                where: { id: params.conversation.customerId, shopId: params.shopId },
              });
              if (customer) {
                customer.tier = action.customerTier as CustomerTierEnum;
                if (action.customerTier === 'BLACKLIST') {
                  customer.isBlacklisted = true;
                  customer.blacklistReason = `Gắn tự động từ Tag "${params.tag.name}"`;
                }
                await this.customerRepo.save(customer);
                summary.executedActions.push({
                  actionId: action.id,
                  actionType: action.actionType,
                  status: 'EXECUTED',
                  detail: `Đã cập nhật hạng khách hàng sang ${action.customerTier}`,
                });
                executedCount += 1;
              }
            }
            break;
          }

          case 'ADD_LOYALTY_POINTS': {
            const delta = Math.trunc(Number(action.loyaltyPointsDelta || 0));
            if (params.conversation.customerId && delta !== 0) {
              const customer = await this.customerRepo.findOne({
                where: { id: params.conversation.customerId, shopId: params.shopId },
              });
              if (customer) {
                customer.loyaltyPointsBalance = Math.max(
                  0,
                  Number(customer.loyaltyPointsBalance || 0) + delta,
                );
                await this.customerRepo.save(customer);
                await this.walletLedgerRepo.save(
                  this.walletLedgerRepo.create({
                    shopId: params.shopId,
                    customerId: customer.id,
                    ledgerType: CustomerWalletLedgerTypeEnum.LOYALTY_POINT,
                    transactionType: CustomerWalletTransactionTypeEnum.MANUAL_ADJUST,
                    deltaAmount: delta,
                    balanceAfter: customer.loyaltyPointsBalance,
                    note: `Tự động điều chỉnh điểm từ Tag "${params.tag.name}"`,
                    actorUserId: params.actorUserId,
                  }),
                );
                summary.executedActions.push({
                  actionId: action.id,
                  actionType: action.actionType,
                  status: 'EXECUTED',
                  detail: `Đã cập nhật ${delta > 0 ? `+${delta}` : delta} điểm thành viên`,
                });
                executedCount += 1;
              }
            }
            break;
          }

          case 'SEND_QUICK_REPLY': {
            if (action.quickReplyTemplateId) {
              // Ủy thác qua EventEmitter2 để tránh circular dependency với ChatService
              this.eventEmitter.emit('tag.workflow.send_quick_reply', {
                shopId: params.shopId,
                conversationId: params.conversation.id,
                quickReplyTemplateId: action.quickReplyTemplateId,
                actorUserId: params.actorUserId,
                delaySeconds: Number(action.delaySeconds || 0),
                tagName: params.tag.name,
              });
              summary.executedActions.push({
                actionId: action.id,
                actionType: action.actionType,
                status: 'EXECUTED',
                detail: `Đã kích hoạt gửi mẫu câu ${action.quickReplyTemplateId}`,
              });
              executedCount += 1;
            }
            break;
          }

          case 'ADD_INTERNAL_NOTE': {
            if (action.internalNoteText?.trim()) {
              this.eventEmitter.emit('tag.workflow.add_internal_note', {
                shopId: params.shopId,
                conversationId: params.conversation.id,
                noteText: action.internalNoteText.trim(),
                actorUserId: params.actorUserId,
                tagName: params.tag.name,
              });
              summary.executedActions.push({
                actionId: action.id,
                actionType: action.actionType,
                status: 'EXECUTED',
                detail: 'Đã chèn ghi chú nội bộ tự động',
              });
              executedCount += 1;
            }
            break;
          }

          case 'CALL_WEBHOOK': {
            if (action.webhookUrl && /^https?:\/\//i.test(action.webhookUrl)) {
              const bodyStr = JSON.stringify({
                event: `tag.${params.trigger.toLowerCase()}`,
                shopId: params.shopId,
                conversationId: params.conversation.id,
                customerId: params.conversation.customerId,
                customerName: params.conversation.name,
                tagId: params.tag.id,
                tagSlug: params.tag.slug,
                tagName: params.tag.name,
                occurredAt: new Date().toISOString(),
              });
              const signature = action.webhookSecret
                ? crypto.createHmac('sha256', action.webhookSecret).update(bodyStr).digest('hex')
                : undefined;

              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 8000);
              try {
                await fetch(action.webhookUrl, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(signature ? { 'X-SellerOS-Signature': signature } : {}),
                  },
                  body: bodyStr,
                  signal: controller.signal,
                });
                clearTimeout(timer);
                summary.executedActions.push({
                  actionId: action.id,
                  actionType: action.actionType,
                  status: 'EXECUTED',
                  detail: `Đã gửi Webhook tới ${action.webhookUrl}`,
                });
                executedCount += 1;
              } catch (whErr) {
                clearTimeout(timer);
                summary.executedActions.push({
                  actionId: action.id,
                  actionType: action.actionType,
                  status: 'FAILED',
                  detail: whErr instanceof Error ? whErr.message : String(whErr),
                });
              }
            }
            break;
          }

          default:
            break;
        }
      } catch (err) {
        this.logger.warn(
          `TagActionWorkflowExecutor error on ${action.actionType}: ${err instanceof Error ? err.message : String(err)}`,
        );
        summary.executedActions.push({
          actionId: action.id,
          actionType: action.actionType,
          status: 'FAILED',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (executedCount > 0) {
      await this.customTagRepo
        .increment({ id: params.tag.id }, 'automationExecutionCount', executedCount)
        .catch(() => null);
    }

    return summary;
  }
}
