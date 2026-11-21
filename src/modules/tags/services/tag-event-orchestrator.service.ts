import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  CreateTagEventDefinitionDto,
  FireTagEventDto,
  UpdateTagEventDefinitionDto,
} from 'src/dto/tags/tags.dto';
import { ConversationEntity } from 'src/entity/conversation.entity';
import {
  TagEventDefinitionEntity,
  TagEventMatchConditions,
} from 'src/entity/tag-event-definition.entity';
import { Repository } from 'typeorm';

import { ConversationTaggingService } from './conversation-tagging.service';
import { TagActionWorkflowExecutor } from './tag-action-workflow.executor';

export interface DispatchedCustomEventPayload {
  shopId: string;
  eventKey?: string;
  systemEventTopic?: string;
  conversationId: string;
  messageContent?: string;
  actorUserId?: string;
  source?: string;
  payload?: Record<string, unknown>;
  recursionDepth?: number;
  visitedEventKeys?: string[];
}

@Injectable()
export class TagEventOrchestratorService {
  private readonly logger = new Logger(TagEventOrchestratorService.name);

  constructor(
    @InjectRepository(TagEventDefinitionEntity)
    private readonly eventDefRepo: Repository<TagEventDefinitionEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRedis()
    private readonly redis: Redis,
    private readonly conversationTaggingService: ConversationTaggingService,
    private readonly tagActionWorkflowExecutor: TagActionWorkflowExecutor,
  ) {}

  private normalizeEventKey(raw: string): string {
    return raw
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 72);
  }

  public async ensureDefaultSystemEvents(shopId: string): Promise<TagEventDefinitionEntity[]> {
    const count = await this.eventDefRepo.count({
      where: { shopId },
      withDeleted: true,
    });
    if (count > 0) {
      return this.eventDefRepo.find({
        where: { shopId, isActive: true },
        order: { isSystemEvent: 'DESC', createdAt: 'ASC' },
      });
    }

    const defaults: Array<Partial<TagEventDefinitionEntity>> = [
      {
        shopId,
        eventKey: 'ner_phone_extracted',
        name: 'Bóc tách được SĐT khách hàng',
        description:
          'Tự động phát hiện khi khách để lại số điện thoại hợp lệ trong tin nhắn/bình luận',
        category: 'SYSTEM_BUILT_IN',
        direction: 'EVENT_TO_TAG',
        isSystemEvent: true,
        systemEventTopic: 'ner.phone.extracted',
        linkedTagBindingsJson: [],
        outboundActionsJson: [],
      },
      {
        shopId,
        eventKey: 'ner_address_extracted',
        name: 'Bóc tách được địa chỉ giao hàng',
        description: 'Tự động phát hiện khi khách gửi địa chỉ nhận hàng 3 cấp',
        category: 'SYSTEM_BUILT_IN',
        direction: 'EVENT_TO_TAG',
        isSystemEvent: true,
        systemEventTopic: 'ner.address.extracted',
        linkedTagBindingsJson: [],
        outboundActionsJson: [],
      },
      {
        shopId,
        eventKey: 'pos_order_confirmed',
        name: 'Đơn hàng POS được xác nhận',
        description: 'Kích hoạt ngay khi đơn hàng chuyển sang trạng thái Đã xác nhận',
        category: 'ORDER_COMMERCE',
        direction: 'BIDIRECTIONAL',
        isSystemEvent: true,
        systemEventTopic: 'pos.order.created',
        linkedTagBindingsJson: [],
        outboundActionsJson: [],
      },
      {
        shopId,
        eventKey: 'vietqr_payment_confirmed',
        name: 'Thanh toán VietQR thành công',
        description: 'Kích hoạt khi Webhook ngân hàng xác nhận đã nhận đủ tiền chuyển khoản',
        category: 'PAYMENT_FINANCE',
        direction: 'BIDIRECTIONAL',
        isSystemEvent: true,
        systemEventTopic: 'payment.vietqr.confirmed',
        linkedTagBindingsJson: [],
        outboundActionsJson: [],
      },
      {
        shopId,
        eventKey: 'carrier_delivery_failed',
        name: 'Đơn vị vận chuyển báo giao thất bại',
        description: 'Kích hoạt để tự động gắn Tag cứu đơn gấp & gửi tin nhắn hẹn giao lại',
        category: 'ORDER_COMMERCE',
        direction: 'BIDIRECTIONAL',
        isSystemEvent: true,
        systemEventTopic: 'carrier.delivery.failed',
        linkedTagBindingsJson: [],
        outboundActionsJson: [],
      },
      {
        shopId,
        eventKey: 'wholesale_keyword_inquiry',
        name: 'Khách hỏi giá sỉ / Cộng tác viên',
        description: 'Khớp từ khóa hỏi nhập sỉ, buôn, CTV trên mọi kênh bán hàng',
        category: 'INBOUND_MESSAGE',
        direction: 'BIDIRECTIONAL',
        isSystemEvent: false,
        systemEventTopic: 'chat.message.inbound',
        matchConditionsJson: {
          keywords: ['giá sỉ', 'nhập sỉ', 'mua buôn', 'cộng tác viên', 'ctv'],
          keywordMatchMode: 'ANY',
        },
        linkedTagBindingsJson: [],
        outboundActionsJson: [],
      },
    ];

    const created = this.eventDefRepo.create(defaults);
    return this.eventDefRepo.save(created);
  }

  public async listEvents(shopId: string): Promise<TagEventDefinitionEntity[]> {
    await this.ensureDefaultSystemEvents(shopId);
    return this.eventDefRepo.find({
      where: { shopId, isActive: true },
      order: { isSystemEvent: 'DESC', createdAt: 'ASC' },
    });
  }

  public async createEvent(
    shopId: string,
    dto: CreateTagEventDefinitionDto,
  ): Promise<TagEventDefinitionEntity> {
    const eventKey = this.normalizeEventKey(dto.eventKey);
    if (!eventKey) {
      throw new BadRequestException('INVALID_TAG_EVENT_KEY');
    }

    const existing = await this.eventDefRepo.findOne({
      where: { shopId, eventKey },
      withDeleted: true,
    });
    if (existing && existing.isActive && !existing.deletedAt) {
      throw new BadRequestException('TAG_EVENT_KEY_ALREADY_EXISTS');
    }

    const resolvedTopic = dto.systemEventTopic?.trim() || `custom.event.${eventKey}`;

    if (existing) {
      if (existing.deletedAt) {
        await this.eventDefRepo.restore(existing.id);
      }
      existing.deletedAt = null;
      existing.deletedBy = null;
      existing.isActive = true;
      existing.name = dto.name.trim();
      existing.description = dto.description?.trim() || null;
      existing.category = dto.category || 'CUSTOM_MANUAL';
      existing.direction = dto.direction || 'BIDIRECTIONAL';
      existing.systemEventTopic = resolvedTopic;
      existing.matchConditionsJson = dto.matchConditionsJson || null;
      existing.linkedTagBindingsJson = dto.linkedTagBindingsJson || [];
      existing.outboundActionsJson = dto.outboundActionsJson || [];
      existing.cooldownSeconds = dto.cooldownSeconds ?? 0;
      return this.eventDefRepo.save(existing);
    }

    const entity = this.eventDefRepo.create({
      shopId,
      eventKey,
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      category: dto.category || 'CUSTOM_MANUAL',
      direction: dto.direction || 'BIDIRECTIONAL',
      isSystemEvent: false,
      systemEventTopic: resolvedTopic,
      matchConditionsJson: dto.matchConditionsJson || null,
      linkedTagBindingsJson: dto.linkedTagBindingsJson || [],
      outboundActionsJson: dto.outboundActionsJson || [],
      cooldownSeconds: dto.cooldownSeconds ?? 0,
      isActive: true,
    });

    return this.eventDefRepo.save(entity);
  }

  public async updateEvent(
    shopId: string,
    eventId: string,
    dto: UpdateTagEventDefinitionDto,
  ): Promise<TagEventDefinitionEntity> {
    const eventDef = await this.eventDefRepo.findOne({
      where: { id: eventId, shopId },
    });
    if (!eventDef) {
      throw new NotFoundException('TAG_EVENT_DEFINITION_NOT_FOUND');
    }

    if (dto.name !== undefined) eventDef.name = dto.name.trim();
    if (dto.description !== undefined) eventDef.description = dto.description?.trim() || null;
    if (dto.category !== undefined) eventDef.category = dto.category;
    if (dto.direction !== undefined) eventDef.direction = dto.direction;
    if (dto.systemEventTopic !== undefined && !eventDef.isSystemEvent) {
      eventDef.systemEventTopic =
        dto.systemEventTopic?.trim() || `custom.event.${eventDef.eventKey}`;
    }
    if (dto.matchConditionsJson !== undefined) {
      eventDef.matchConditionsJson = dto.matchConditionsJson;
    }
    if (dto.linkedTagBindingsJson !== undefined) {
      eventDef.linkedTagBindingsJson = dto.linkedTagBindingsJson;
    }
    if (dto.outboundActionsJson !== undefined) {
      eventDef.outboundActionsJson = dto.outboundActionsJson;
    }
    if (dto.cooldownSeconds !== undefined) {
      eventDef.cooldownSeconds = dto.cooldownSeconds;
    }
    if (dto.isActive !== undefined && !eventDef.isSystemEvent) {
      eventDef.isActive = dto.isActive;
    }

    return this.eventDefRepo.save(eventDef);
  }

  public async deleteEvent(
    shopId: string,
    eventId: string,
  ): Promise<{ id: string; deleted: boolean }> {
    const eventDef = await this.eventDefRepo.findOne({
      where: { id: eventId, shopId },
    });
    if (!eventDef) {
      throw new NotFoundException('TAG_EVENT_DEFINITION_NOT_FOUND');
    }
    if (eventDef.isSystemEvent) {
      throw new BadRequestException('CANNOT_DELETE_SYSTEM_TAG_EVENT');
    }

    eventDef.isActive = false;
    await this.eventDefRepo.save(eventDef);
    return { id: eventId, deleted: true };
  }

  private matchesEventConditions(
    conditions: TagEventMatchConditions | null | undefined,
    conversation: ConversationEntity,
    messageContent?: string,
    payload?: Record<string, unknown>,
  ): boolean {
    if (!conditions) return true;

    if (
      Array.isArray(conditions.channelTypes) &&
      conditions.channelTypes.length > 0 &&
      conversation.channelType &&
      !conditions.channelTypes.includes(conversation.channelType)
    ) {
      return false;
    }

    if (
      Array.isArray(conditions.interactionTypes) &&
      conditions.interactionTypes.length > 0 &&
      conversation.interactionType &&
      !conditions.interactionTypes.includes(conversation.interactionType as any)
    ) {
      return false;
    }

    if (conditions.onlyWhenCustomerHasPhone && !conversation.hasPhoneCollected) {
      return false;
    }

    if (conditions.minOrderAmount !== undefined && conditions.minOrderAmount !== null) {
      const amount = Number(payload?.orderAmount ?? payload?.totalPayableAmount ?? 0);
      if (amount < Number(conditions.minOrderAmount)) {
        return false;
      }
    }

    if (Array.isArray(conditions.keywords) && conditions.keywords.length > 0) {
      const text = (messageContent || '').toLowerCase();
      if (!text) return false;

      const mode = conditions.keywordMatchMode || 'ANY';
      if (mode === 'ALL') {
        const allMatched = conditions.keywords.every((kw) => text.includes(kw.toLowerCase()));
        if (!allMatched) return false;
      } else if (mode === 'REGEX') {
        const regexMatched = conditions.keywords.some((pattern) => {
          try {
            return new RegExp(pattern, 'i').test(messageContent || '');
          } catch {
            return false;
          }
        });
        if (!regexMatched) return false;
      } else {
        const anyMatched = conditions.keywords.some((kw) => text.includes(kw.toLowerCase()));
        if (!anyMatched) return false;
      }
    }

    if (Array.isArray(conditions.payloadMatchers) && conditions.payloadMatchers.length > 0) {
      const sourceObj = payload || {};
      for (const matcher of conditions.payloadMatchers) {
        const actual = sourceObj[matcher.field];
        const expected = matcher.value;
        switch (matcher.operator) {
          case 'EQUALS':
            if (String(actual ?? '') !== String(expected)) return false;
            break;
          case 'NOT_EQUALS':
            if (String(actual ?? '') === String(expected)) return false;
            break;
          case 'CONTAINS':
            if (
              !String(actual ?? '')
                .toLowerCase()
                .includes(String(expected).toLowerCase())
            ) {
              return false;
            }
            break;
          case 'GT':
            if (!(Number(actual) > Number(expected))) return false;
            break;
          case 'GTE':
            if (!(Number(actual) >= Number(expected))) return false;
            break;
          case 'LT':
            if (!(Number(actual) < Number(expected))) return false;
            break;
          case 'LTE':
            if (!(Number(actual) <= Number(expected))) return false;
            break;
          default:
            break;
        }
      }
    }

    return true;
  }

  public async dispatchEvent(params: DispatchedCustomEventPayload): Promise<{
    matchedEventsCount: number;
    appliedTagIds: string[];
    removedTagIds: string[];
    executedActionsCount: number;
  }> {
    const depth = params.recursionDepth ?? 0;
    const visited = new Set<string>(params.visitedEventKeys || []);

    if (depth >= 3 || !params.shopId || !params.conversationId) {
      return {
        matchedEventsCount: 0,
        appliedTagIds: [],
        removedTagIds: [],
        executedActionsCount: 0,
      };
    }

    const conversation = await this.conversationRepo.findOne({
      where: { id: params.conversationId, shopId: params.shopId },
    });
    if (!conversation) {
      return {
        matchedEventsCount: 0,
        appliedTagIds: [],
        removedTagIds: [],
        executedActionsCount: 0,
      };
    }

    const candidateEvents = await this.eventDefRepo.find({
      where: params.eventKey
        ? { shopId: params.shopId, eventKey: params.eventKey, isActive: true }
        : { shopId: params.shopId, systemEventTopic: params.systemEventTopic, isActive: true },
    });

    const appliedTagIds: string[] = [];
    const removedTagIds: string[] = [];
    let executedActionsCount = 0;
    let matchedEventsCount = 0;

    for (const evt of candidateEvents) {
      if (visited.has(evt.eventKey) && params.source?.startsWith('TAG_ACTION:')) {
        // Đã chạy trong chuỗi này, bỏ qua để tránh vòng lặp
        continue;
      }

      const isTriggeredByTag = Boolean(params.source?.startsWith('TAG_ACTION:'));
      if (isTriggeredByTag && evt.direction === 'EVENT_TO_TAG') {
        continue;
      }

      if (
        !isTriggeredByTag &&
        !this.matchesEventConditions(
          evt.matchConditionsJson,
          conversation,
          params.messageContent,
          params.payload,
        )
      ) {
        continue;
      }

      if (evt.cooldownSeconds > 0) {
        const cdKey = `tag_evt_cd:${evt.id}:${conversation.id}`;
        const acquired = await this.redis.set(cdKey, '1', 'EX', evt.cooldownSeconds, 'NX');
        if (!acquired) continue;
      }

      matchedEventsCount += 1;
      const nextVisited = Array.from(new Set([...visited, evt.eventKey]));

      // Chiều 1 (EVENT_TO_TAG / BIDIRECTIONAL): Tự động gắn hoặc gỡ các Tag đã kết nối
      if (
        !isTriggeredByTag &&
        (evt.direction === 'EVENT_TO_TAG' || evt.direction === 'BIDIRECTIONAL') &&
        Array.isArray(evt.linkedTagBindingsJson) &&
        evt.linkedTagBindingsJson.length > 0
      ) {
        const sortedBindings = evt.linkedTagBindingsJson
          .slice()
          .sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));

        for (const binding of sortedBindings) {
          try {
            await this.conversationTaggingService.toggleConversationTag({
              shopId: params.shopId,
              conversationId: conversation.id,
              tagId: binding.tagId,
              actorUserId: params.actorUserId || 'SYSTEM_EVENT_ORCHESTRATOR',
              forceState: binding.operation,
              recursionDepth: depth + 1,
            });
            if (binding.operation === 'ADD') {
              appliedTagIds.push(binding.tagId);
            } else {
              removedTagIds.push(binding.tagId);
            }
          } catch (err) {
            this.logger.warn(`Failed applying linked tag ${binding.tagId}: ${String(err)}`);
          }
        }
      }

      // Chiều 2 (TAG_TO_EVENT / BIDIRECTIONAL hoặc Outbound Actions gắn với Sự kiện)
      if (Array.isArray(evt.outboundActionsJson) && evt.outboundActionsJson.length > 0) {
        const actionResults = await this.tagActionWorkflowExecutor.executeActionList({
          shopId: params.shopId,
          conversation,
          actions: evt.outboundActionsJson,
          sourceLabel: evt.name,
          sourceSlug: `CUSTOM_EVENT:${evt.eventKey}`,
          trigger: 'CUSTOM_EVENT',
          actorUserId: params.actorUserId || 'SYSTEM_EVENT_ORCHESTRATOR',
          recursionDepth: depth + 1,
          visitedEventKeys: nextVisited,
        });
        executedActionsCount += actionResults.filter((r) => r.status === 'EXECUTED').length;
      }

      await this.eventDefRepo
        .update(
          { id: evt.id },
          {
            triggerCount: Number(evt.triggerCount || 0) + 1,
            lastTriggeredAt: new Date(),
          },
        )
        .catch(() => null);
    }

    return {
      matchedEventsCount,
      appliedTagIds,
      removedTagIds,
      executedActionsCount,
    };
  }

  public async fireEventManually(
    shopId: string,
    eventId: string,
    dto: FireTagEventDto,
    actorUserId: string,
  ) {
    const eventDef = await this.eventDefRepo.findOne({
      where: { id: eventId, shopId, isActive: true },
    });
    if (!eventDef) {
      throw new NotFoundException('TAG_EVENT_DEFINITION_NOT_FOUND');
    }

    return this.dispatchEvent({
      shopId,
      eventKey: eventDef.eventKey,
      conversationId: dto.conversationId,
      messageContent: dto.messageContent,
      payload: dto.payload,
      actorUserId,
      source: 'MANUAL_OR_API_FIRE',
      recursionDepth: 0,
    });
  }

  @OnEvent('custom.tag_event.dispatched')
  async handleCustomTagEventDispatched(payload: DispatchedCustomEventPayload): Promise<void> {
    await this.dispatchEvent(payload);
  }

  @OnEvent('tag.workflow.mutate_related_tags')
  async handleMutateRelatedTags(payload: {
    shopId: string;
    conversationId: string;
    addTagIds: string[];
    removeTagIds: string[];
    actorUserId: string;
    recursionDepth: number;
  }): Promise<void> {
    for (const removeId of payload.removeTagIds || []) {
      await this.conversationTaggingService
        .toggleConversationTag({
          shopId: payload.shopId,
          conversationId: payload.conversationId,
          tagId: removeId,
          actorUserId: payload.actorUserId,
          forceState: 'REMOVE',
          recursionDepth: payload.recursionDepth,
        })
        .catch(() => null);
    }
    for (const addId of payload.addTagIds || []) {
      await this.conversationTaggingService
        .toggleConversationTag({
          shopId: payload.shopId,
          conversationId: payload.conversationId,
          tagId: addId,
          actorUserId: payload.actorUserId,
          forceState: 'ADD',
          recursionDepth: payload.recursionDepth,
        })
        .catch(() => null);
    }
  }
}
