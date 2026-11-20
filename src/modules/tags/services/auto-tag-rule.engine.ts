import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { CustomTagEntity } from 'src/entity/custom-tag.entity';
import { Repository } from 'typeorm';

import { ConversationTaggingService } from './conversation-tagging.service';
import { TagEventOrchestratorService } from './tag-event-orchestrator.service';

export interface AutoTagEventPayload {
  shopId: string;
  conversationId: string;
  messageContent?: string;
  actorUserId?: string;
  payload?: Record<string, unknown>;
}

@Injectable()
export class AutoTagRuleEngine {
  private readonly logger = new Logger(AutoTagRuleEngine.name);

  constructor(
    @InjectRepository(CustomTagEntity)
    private readonly customTagRepo: Repository<CustomTagEntity>,
    private readonly conversationTaggingService: ConversationTaggingService,
    private readonly tagEventOrchestrator: TagEventOrchestratorService,
  ) {}

  private async evaluateAndApplyTrigger(
    triggerEvent:
      | 'NER_PHONE_EXTRACTED'
      | 'NER_ADDRESS_EXTRACTED'
      | 'POS_DRAFT_CREATED'
      | 'POS_ORDER_CONFIRMED'
      | 'VIETQR_PAID'
      | 'CARRIER_DELIVERY_FAILED'
      | 'KEYWORD_MATCH',
    systemEventTopic: string,
    payload: AutoTagEventPayload,
  ): Promise<void> {
    if (!payload.shopId || !payload.conversationId) return;

    try {
      // 1. Chạy động cơ Sự kiện Tùy chỉnh Hai chiều mới (`TagEventDefinitionEntity`)
      await this.tagEventOrchestrator.dispatchEvent({
        shopId: payload.shopId,
        systemEventTopic,
        conversationId: payload.conversationId,
        messageContent: payload.messageContent,
        actorUserId: payload.actorUserId || 'SYSTEM_AUTO_TAG',
        payload: payload.payload,
        source: `SYSTEM_TOPIC:${systemEventTopic}`,
        recursionDepth: 0,
      });

      // 2. Giữ nguyên tương thích ngược với cấu hình `autoRuleConfigJson` trên từng Tag
      const activeTags = await this.customTagRepo.find({
        where: { shopId: payload.shopId, isActive: true },
      });

      const matchedTags = activeTags.filter((tag) => {
        const rule = tag.autoRuleConfigJson;
        if (!rule) {
          if (triggerEvent === 'NER_PHONE_EXTRACTED' && tag.slug === 'HAS_PHONE') return true;
          if (triggerEvent === 'NER_ADDRESS_EXTRACTED' && tag.slug === 'HAS_ADDRESS') return true;
          if (triggerEvent === 'VIETQR_PAID' && tag.slug === 'PAYMENT_RECEIVED') return true;
          if (triggerEvent === 'POS_ORDER_CONFIRMED' && tag.slug === 'ORDER_CREATED') return true;
          if (triggerEvent === 'CARRIER_DELIVERY_FAILED' && tag.slug === 'DELIVERY_RESCUE_URGENT') {
            return true;
          }
          return false;
        }

        if (rule.triggerEvent !== triggerEvent) return false;

        if (triggerEvent === 'KEYWORD_MATCH' && rule.keywords?.length) {
          const text = (payload.messageContent || '').toLowerCase();
          return rule.keywords.some((kw) => text.includes(kw.toLowerCase()));
        }

        return true;
      });

      for (const tag of matchedTags) {
        await this.conversationTaggingService.toggleConversationTag({
          shopId: payload.shopId,
          conversationId: payload.conversationId,
          tagId: tag.id,
          actorUserId: payload.actorUserId || 'SYSTEM_AUTO_TAG',
          forceState: 'ADD',
        });
      }
    } catch (err) {
      this.logger.warn(`AutoTagRuleEngine warning on ${triggerEvent}: ${String(err)}`);
    }
  }

  @OnEvent('chat.message.inbound')
  async handleInboundMessageKeywords(payload: AutoTagEventPayload): Promise<void> {
    await this.evaluateAndApplyTrigger('KEYWORD_MATCH', 'chat.message.inbound', payload);
  }

  @OnEvent('ner.phone.extracted')
  async handlePhoneExtracted(payload: AutoTagEventPayload): Promise<void> {
    await this.evaluateAndApplyTrigger('NER_PHONE_EXTRACTED', 'ner.phone.extracted', payload);
  }

  @OnEvent('ner.address.extracted')
  async handleAddressExtracted(payload: AutoTagEventPayload): Promise<void> {
    await this.evaluateAndApplyTrigger('NER_ADDRESS_EXTRACTED', 'ner.address.extracted', payload);
  }

  @OnEvent('pos.draft.created')
  async handlePosDraftCreated(payload: AutoTagEventPayload): Promise<void> {
    await this.evaluateAndApplyTrigger('POS_DRAFT_CREATED', 'pos.draft.created', payload);
  }

  @OnEvent('pos.order.created')
  async handlePosOrderCreated(payload: AutoTagEventPayload): Promise<void> {
    await this.evaluateAndApplyTrigger('POS_ORDER_CONFIRMED', 'pos.order.created', payload);
  }

  @OnEvent('payment.vietqr.confirmed')
  async handleVietQrConfirmed(payload: AutoTagEventPayload): Promise<void> {
    await this.evaluateAndApplyTrigger('VIETQR_PAID', 'payment.vietqr.confirmed', payload);
  }

  @OnEvent('carrier.delivery.failed')
  async handleCarrierDeliveryFailed(payload: AutoTagEventPayload): Promise<void> {
    await this.evaluateAndApplyTrigger(
      'CARRIER_DELIVERY_FAILED',
      'carrier.delivery.failed',
      payload,
    );
  }
}
