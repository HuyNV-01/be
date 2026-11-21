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
  trigger: 'ON_APPLY' | 'ON_REMOVE' | 'CUSTOM_EVENT';
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

  public async executeActionList(params: {
    shopId: string;
    conversation: ConversationEntity;
    actions: TagWorkflowActionItem[];
    sourceLabel: string;
    sourceSlug: string;
    trigger: 'ON_APPLY' | 'ON_REMOVE' | 'CUSTOM_EVENT';
    actorUserId: string;
    recursionDepth: number;
    visitedEventKeys?: string[];
  }): Promise<TagWorkflowExecutionSummary['executedActions']> {
    const results: TagWorkflowExecutionSummary['executedActions'] = [];
    const enabledActions = (params.actions || []).filter((a) => a && a.isEnabled !== false);

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
                  source: params.sourceSlug,
                },
              );
              results.push({
                actionId: action.id,
                actionType: action.actionType,
                status: 'EXECUTED',
                detail: `Đã chuyển phụ trách sang nhân sự ${targetUserId}`,
              });
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
                snoozeNote: action.snoozeNote || `Hẹn tự động từ "${params.sourceLabel}"`,
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
                source: params.sourceSlug,
              },
            );
            results.push({
              actionId: action.id,
              actionType: action.actionType,
              status: 'EXECUTED',
              detail: `Đã hẹn chăm sóc lại sau ${mins} phút`,
            });
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
                  customer.blacklistReason = `Gắn tự động từ "${params.sourceLabel}"`;
                }
                await this.customerRepo.save(customer);
                results.push({
                  actionId: action.id,
                  actionType: action.actionType,
                  status: 'EXECUTED',
                  detail: `Đã cập nhật hạng khách hàng sang ${action.customerTier}`,
                });
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
                    note: `Tự động điều chỉnh điểm từ "${params.sourceLabel}"`,
                    actorUserId: params.actorUserId,
                  }),
                );
                results.push({
                  actionId: action.id,
                  actionType: action.actionType,
                  status: 'EXECUTED',
                  detail: `Đã cập nhật ${delta > 0 ? `+${delta}` : delta} điểm thành viên`,
                });
              }
            }
            break;
          }

          case 'SEND_QUICK_REPLY': {
            if (action.quickReplyTemplateId) {
              this.eventEmitter.emit('tag.workflow.send_quick_reply', {
                shopId: params.shopId,
                conversationId: params.conversation.id,
                quickReplyTemplateId: action.quickReplyTemplateId,
                actorUserId: params.actorUserId,
                delaySeconds: Number(action.delaySeconds || 0),
                tagName: params.sourceLabel,
              });
              results.push({
                actionId: action.id,
                actionType: action.actionType,
                status: 'EXECUTED',
                detail: `Đã kích hoạt gửi mẫu câu ${action.quickReplyTemplateId}`,
              });
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
                tagName: params.sourceLabel,
              });
              results.push({
                actionId: action.id,
                actionType: action.actionType,
                status: 'EXECUTED',
                detail: 'Đã chèn ghi chú nội bộ tự động',
              });
            }
            break;
          }

          case 'AUTO_ADD_OR_REMOVE_TAGS': {
            if (
              params.recursionDepth < 2 &&
              ((action.addTagIds && action.addTagIds.length > 0) ||
                (action.removeTagIds && action.removeTagIds.length > 0))
            ) {
              this.eventEmitter.emit('tag.workflow.mutate_related_tags', {
                shopId: params.shopId,
                conversationId: params.conversation.id,
                addTagIds: action.addTagIds || [],
                removeTagIds: action.removeTagIds || [],
                actorUserId: params.actorUserId,
                recursionDepth: params.recursionDepth + 1,
              });
              results.push({
                actionId: action.id,
                actionType: action.actionType,
                status: 'EXECUTED',
                detail: 'Đã kích hoạt đồng bộ Tag liên đới',
              });
            }
            break;
          }

          case 'TRIGGER_CUSTOM_EVENT': {
            const eventKey = action.customEventKey?.trim();
            if (eventKey && !(params.visitedEventKeys || []).includes(eventKey)) {
              this.eventEmitter.emit('custom.tag_event.dispatched', {
                shopId: params.shopId,
                eventKey,
                conversationId: params.conversation.id,
                actorUserId: params.actorUserId,
                source: `TAG_ACTION:${params.sourceSlug}`,
                payload: action.customEventPayload || {},
                recursionDepth: params.recursionDepth + 1,
                visitedEventKeys: [...(params.visitedEventKeys || []), eventKey],
              });
              results.push({
                actionId: action.id,
                actionType: action.actionType,
                status: 'EXECUTED',
                detail: `Đã kích hoạt sự kiện tùy chỉnh "${eventKey}"`,
              });
            }
            break;
          }

          case 'EMIT_SOCKET_ALERT': {
            this.realtimeEmitter.emitToConversation(
              SOCKET_CONFIG.namespaces.CHAT,
              params.conversation.id,
              SOCKET_CONFIG.events.OMNICHANNEL_INBOX.TAGS_UPDATED,
              {
                conversationId: params.conversation.id,
                shopId: params.shopId,
                alertMessage: action.alertMessage || `Đã kích hoạt từ "${params.sourceLabel}"`,
                source: params.sourceSlug,
              },
            );
            results.push({
              actionId: action.id,
              actionType: action.actionType,
              status: 'EXECUTED',
              detail: action.alertMessage || 'Đã phát cảnh báo realtime tới nhân viên trực',
            });
            break;
          }

          case 'CALL_WEBHOOK': {
            if (action.webhookUrl && /^https?:\/\//i.test(action.webhookUrl)) {
              const bodyStr = JSON.stringify({
                event: `tag.${params.trigger.toLowerCase()}`,
                source: params.sourceSlug,
                shopId: params.shopId,
                conversationId: params.conversation.id,
                customerId: params.conversation.customerId,
                customerName: params.conversation.name,
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
                results.push({
                  actionId: action.id,
                  actionType: action.actionType,
                  status: 'EXECUTED',
                  detail: `Đã gửi Webhook tới ${action.webhookUrl}`,
                });
              } catch (whErr) {
                clearTimeout(timer);
                results.push({
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
        results.push({
          actionId: action.id,
          actionType: action.actionType,
          status: 'FAILED',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  public async executeTagWorkflows(params: {
    shopId: string;
    conversation: ConversationEntity;
    tag: CustomTagEntity;
    trigger: 'ON_APPLY' | 'ON_REMOVE';
    actorUserId: string;
    recursionDepth?: number;
    visitedEventKeys?: string[];
  }): Promise<TagWorkflowExecutionSummary> {
    const depth = params.recursionDepth ?? 0;
    const summary: TagWorkflowExecutionSummary = {
      tagId: params.tag.id,
      tagName: params.tag.name,
      trigger: params.trigger,
      executedActions: [],
    };

    if (depth >= 3) {
      return summary;
    }

    if (!this.matchesCondition(params.conversation, params.tag.executionConditionJson)) {
      return summary;
    }

    const actions: TagWorkflowActionItem[] =
      params.trigger === 'ON_APPLY'
        ? Array.isArray(params.tag.onApplyActionsJson)
          ? [...params.tag.onApplyActionsJson]
          : []
        : Array.isArray(params.tag.onRemoveActionsJson)
          ? [...params.tag.onRemoveActionsJson]
          : [];

    // Nếu Tag có liên kết trực tiếp tới các Sự kiện tùy chỉnh (`linkedEventKeysJson`) khi gắn Tag
    if (
      params.trigger === 'ON_APPLY' &&
      Array.isArray(params.tag.linkedEventKeysJson) &&
      params.tag.linkedEventKeysJson.length > 0
    ) {
      for (const evtKey of params.tag.linkedEventKeysJson) {
        const alreadyInActions = actions.some(
          (a) => a.actionType === 'TRIGGER_CUSTOM_EVENT' && a.customEventKey === evtKey,
        );
        if (!alreadyInActions) {
          actions.push({
            id: `linked_evt_${evtKey}`,
            actionType: 'TRIGGER_CUSTOM_EVENT',
            isEnabled: true,
            customEventKey: evtKey,
          });
        }
      }
    }

    const enabledActions = actions.filter((a) => a && a.isEnabled !== false);
    if (enabledActions.length === 0) {
      return summary;
    }

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

    const executed = await this.executeActionList({
      shopId: params.shopId,
      conversation: params.conversation,
      actions: enabledActions,
      sourceLabel: params.tag.name,
      sourceSlug: `TAG_WORKFLOW:${params.tag.slug}`,
      trigger: params.trigger,
      actorUserId: params.actorUserId,
      recursionDepth: depth,
      visitedEventKeys: params.visitedEventKeys,
    });

    summary.executedActions = executed;
    const successCount = executed.filter((item) => item.status === 'EXECUTED').length;

    if (successCount > 0) {
      await this.customTagRepo
        .increment({ id: params.tag.id }, 'automationExecutionCount', successCount)
        .catch(() => null);
    }

    return summary;
  }
}
