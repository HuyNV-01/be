import {
  AiHandlingModeEnum,
  ChannelTypeEnum,
  ConversationSupportStatusEnum,
  ConversationTypeEnum,
} from 'src/common/enum';
import { Column, Entity, Index, OneToMany } from 'typeorm';

import { BaseModel } from './base-model';
import { ConversationParticipantEntity } from './conversation-participant.entity';
import { MessageEntity } from './message.entity';

export type ConversationInteractionType = 'INBOX' | 'COMMENT' | 'LIVESTREAM' | 'MARKETPLACE';

export interface AccountabilityMilestoneItem {
  eventCode:
    | 'LEAD_INBOUND'
    | 'ASSIGNED_AGENT'
    | 'FIRST_SEEN'
    | 'FIRST_AGENT_REPLY_FRT'
    | 'INTERNAL_NOTE_ADDED'
    | 'CONVERSATION_TRANSFERRED'
    | 'CONVERSATION_SNOOZED'
    | 'CONVERSATION_UNSNOOZED'
    | 'MASKED_CALL_INITIATED'
    | 'MASKED_CALL_COMPLETED'
    | 'PHONE_COLLECTED'
    | 'ORDER_CREATED';
  actorUserId?: string | null;
  actorName?: string | null;
  targetUserId?: string | null;
  targetUserName?: string | null;
  note?: string | null;
  elapsedSecondsFromInbound?: number | null;
  timestamp: string;
}

@Entity('conversations')
@Index(['lastMessageAt'])
@Index('idx_conv_shop_support_sla', ['shopId', 'supportStatus', 'slaDeadlineAt'])
@Index('idx_conv_shop_status_last_msg', ['shopId', 'supportStatus', 'lastMessageAt'])
@Index('idx_conv_shop_channel_assigned', ['shopId', 'channelIntegrationId', 'assignedAgentId'])
@Index('idx_conv_shop_channel_ext', ['shopId', 'channelIntegrationId', 'externalThreadId'])
@Index('idx_conv_shop_ghosted', ['shopId', 'isGhostedByAgent', 'supportStatus'])
@Index('idx_conv_shop_snoozed', ['shopId', 'supportStatus', 'snoozedUntilAt'])
export class ConversationEntity extends BaseModel {
  @Column({
    type: 'enum',
    enum: ConversationTypeEnum,
    default: ConversationTypeEnum.DIRECT,
  })
  type: ConversationTypeEnum;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string;

  // Chuyển từ varchar(255) sang text vì ảnh đại diện khách hàng lấy từ Graph API / Zalo OA / CDN
  // có chứa query string chữ ký bảo mật thường dài 400 - 1.500+ ký tự, tránh lỗi tràn cột khi lưu.
  @Column({ type: 'text', nullable: true })
  avatar: string;

  @Column({ name: 'direct_key', type: 'varchar', length: 120, nullable: true, unique: true })
  directKey: string | null;

  @Column({ type: 'text', nullable: true })
  lastMessage: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  lastMessageSenderId: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  lastMessageType: string;

  @Column({ type: 'datetime', nullable: true })
  lastMessageAt: Date;

  @Column({ name: 'disappearing_ttl', type: 'int', nullable: true, default: null })
  disappearingTtl: number | null;

  // ============================================================================
  // OMNICHANNEL SELLER OS EXTENSIONS (Zero-Config DatabaseEvolutionService Safe)
  // ============================================================================

  @Column({ name: 'shop_id', type: 'varchar', length: 36, nullable: true, default: null })
  shopId: string | null;

  @Column({
    name: 'channel_type',
    type: 'enum',
    enum: ChannelTypeEnum,
    default: ChannelTypeEnum.INTERNAL,
  })
  channelType: ChannelTypeEnum;

  @Column({
    name: 'channel_integration_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  channelIntegrationId: string | null;

  @Column({
    name: 'external_thread_id',
    type: 'varchar',
    length: 191,
    nullable: true,
    default: null,
  })
  externalThreadId: string | null;

  @Column({
    name: 'interaction_type',
    type: 'enum',
    enum: ['INBOX', 'COMMENT', 'LIVESTREAM', 'MARKETPLACE'],
    default: 'INBOX',
  })
  interactionType: ConversationInteractionType;

  @Column({ name: 'customer_id', type: 'varchar', length: 36, nullable: true, default: null })
  customerId: string | null;

  @Column({
    name: 'assigned_agent_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  assignedAgentId: string | null;

  @Column({
    name: 'support_status',
    type: 'enum',
    enum: ConversationSupportStatusEnum,
    default: ConversationSupportStatusEnum.NEW,
  })
  supportStatus: ConversationSupportStatusEnum;

  @Column({
    name: 'ai_handling_mode',
    type: 'enum',
    enum: AiHandlingModeEnum,
    default: AiHandlingModeEnum.COPILOT,
  })
  aiHandlingMode: AiHandlingModeEnum;

  @Column({ name: 'sla_deadline_at', type: 'datetime', nullable: true, default: null })
  slaDeadlineAt: Date | null;

  @Column({ name: 'is_sla_breached', type: 'boolean', default: false })
  isSlaBreached: boolean;

  @Column({ name: 'last_customer_message_at', type: 'datetime', nullable: true, default: null })
  lastCustomerMessageAt: Date | null;

  @Column({ name: 'last_agent_reply_at', type: 'datetime', nullable: true, default: null })
  lastAgentReplyAt: Date | null;

  @Column({
    name: 'first_seen_by_agent_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  firstSeenByAgentId: string | null;

  @Column({ name: 'first_seen_at', type: 'datetime', nullable: true, default: null })
  firstSeenAt: Date | null;

  @Column({ name: 'is_ghosted_by_agent', type: 'boolean', default: false })
  isGhostedByAgent: boolean;

  @Column({ name: 'has_phone_collected', type: 'boolean', default: false })
  hasPhoneCollected: boolean;

  @Column({ name: 'has_order_created', type: 'boolean', default: false })
  hasOrderCreated: boolean;

  @Column({ name: 'source_post_id', type: 'varchar', length: 255, nullable: true, default: null })
  sourcePostId: string | null;

  @Column({ name: 'source_ad_id', type: 'varchar', length: 255, nullable: true, default: null })
  sourceAdId: string | null;

  // Chuyển sang kiểu text vì mã ctwa_clid từ quảng cáo Click-to-Messenger là chuỗi token mã hóa dài > 255 ký tự
  @Column({ name: 'ctwa_click_id', type: 'text', nullable: true, default: null })
  ctwaClickId: string | null;

  @Column({ name: 'active_tag_ids_json', type: 'json', nullable: true })
  activeTagIdsJson: string[] | null;

  @Column({ name: 'snoozed_until_at', type: 'datetime', nullable: true, default: null })
  snoozedUntilAt: Date | null;

  @Column({ name: 'snooze_note', type: 'text', nullable: true, default: null })
  snoozeNote: string | null;

  @Column({
    name: 'snoozed_by_user_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  snoozedByUserId: string | null;

  @Column({ name: 'accountability_timeline_json', type: 'json', nullable: true, default: null })
  accountabilityTimelineJson: AccountabilityMilestoneItem[] | null;

  @Column({
    name: 'customer_preferred_lang',
    type: 'varchar',
    length: 16,
    nullable: true,
    default: null,
  })
  customerPreferredLang: string | null;

  @Column({ name: 'auto_translate_enabled', type: 'boolean', default: false })
  autoTranslateEnabled: boolean;

  @OneToMany(() => ConversationParticipantEntity, (p) => p.conversation)
  participants: ConversationParticipantEntity[];

  @OneToMany(() => MessageEntity, (m) => m.conversation)
  messages: MessageEntity[];
}
