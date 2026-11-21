import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';
import { type TagWorkflowActionItem } from './custom-tag.entity';

export type TagEventCategoryType =
  | 'SYSTEM_BUILT_IN'
  | 'INBOUND_MESSAGE'
  | 'ORDER_COMMERCE'
  | 'PAYMENT_FINANCE'
  | 'CUSTOMER_LIFECYCLE'
  | 'EXTERNAL_WEBHOOK'
  | 'CUSTOM_MANUAL';

export type TagEventDirectionType = 'EVENT_TO_TAG' | 'TAG_TO_EVENT' | 'BIDIRECTIONAL';

export interface TagEventPayloadMatcher {
  field: string;
  operator: 'EQUALS' | 'NOT_EQUALS' | 'CONTAINS' | 'GT' | 'GTE' | 'LT' | 'LTE';
  value: string | number | boolean;
}

export interface TagEventMatchConditions {
  keywords?: string[];
  keywordMatchMode?: 'ANY' | 'ALL' | 'REGEX';
  channelTypes?: string[];
  interactionTypes?: Array<'INBOX' | 'COMMENT' | 'LIVESTREAM' | 'MARKETPLACE'>;
  minOrderAmount?: number | null;
  onlyWhenCustomerHasPhone?: boolean;
  payloadMatchers?: TagEventPayloadMatcher[];
}

export interface TagEventTagBinding {
  tagId: string;
  operation: 'ADD' | 'REMOVE';
  priority?: number;
}

@Entity('tag_event_definitions')
@Index('uq_tag_event_shop_key', ['shopId', 'eventKey'], { unique: true })
@Index('idx_tag_event_shop_topic', ['shopId', 'systemEventTopic', 'isActive'])
export class TagEventDefinitionEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'event_key', type: 'varchar', length: 80 })
  eventKey: string;

  @Column({ name: 'name', type: 'varchar', length: 140 })
  name: string;

  @Column({ name: 'description', type: 'varchar', length: 300, nullable: true, default: null })
  description: string | null;

  @Column({ name: 'category', type: 'varchar', length: 32, default: 'CUSTOM_MANUAL' })
  category: TagEventCategoryType;

  @Column({ name: 'direction', type: 'varchar', length: 24, default: 'BIDIRECTIONAL' })
  direction: TagEventDirectionType;

  @Column({ name: 'is_system_event', type: 'boolean', default: false })
  isSystemEvent: boolean;

  /**
   * EventEmitter2 topic lắng nghe khi sự kiện xảy ra:
   * VD: 'chat.message.inbound', 'ner.phone.extracted', 'pos.order.created',
   * 'payment.vietqr.confirmed', 'carrier.delivery.failed', hoặc 'custom.event.<eventKey>'
   */
  @Column({
    name: 'system_event_topic',
    type: 'varchar',
    length: 120,
    nullable: true,
    default: null,
  })
  systemEventTopic: string | null;

  @Column({ name: 'match_conditions_json', type: 'json', nullable: true, default: null })
  matchConditionsJson: TagEventMatchConditions | null;

  /**
   * Chiều EVENT_TO_TAG: Danh sách Tag sẽ được tự động gắn hoặc gỡ khi sự kiện này kích hoạt
   */
  @Column({ name: 'linked_tag_bindings_json', type: 'json', nullable: true, default: null })
  linkedTagBindingsJson: TagEventTagBinding[] | null;

  /**
   * Chiều TAG_TO_EVENT / Outbound: Danh sách hành động tự động thực thi khi sự kiện được kích hoạt
   * (từ thao tác bấm gắn Tag của nhân viên hoặc kích hoạt thủ công / API)
   */
  @Column({ name: 'outbound_actions_json', type: 'json', nullable: true, default: null })
  outboundActionsJson: TagWorkflowActionItem[] | null;

  @Column({ name: 'cooldown_seconds', type: 'int', default: 0 })
  cooldownSeconds: number;

  @Column({ name: 'trigger_count', type: 'int', default: 0 })
  triggerCount: number;

  @Column({ name: 'last_triggered_at', type: 'timestamp', nullable: true, default: null })
  lastTriggeredAt: Date | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
