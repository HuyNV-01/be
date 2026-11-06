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

@Entity('conversations')
@Index(['lastMessageAt'])
@Index('idx_conv_shop_support_sla', ['shopId', 'supportStatus', 'slaDeadlineAt'])
@Index('idx_conv_shop_channel_assigned', ['shopId', 'channelIntegrationId', 'assignedAgentId'])
export class ConversationEntity extends BaseModel {
  @Column({
    type: 'enum',
    enum: ConversationTypeEnum,
    default: ConversationTypeEnum.DIRECT,
  })
  type: ConversationTypeEnum;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  avatar: string;

  @Column({ name: 'direct_key', type: 'varchar', length: 80, nullable: true, unique: true })
  directKey: string | null;

  @Column({ type: 'text', nullable: true })
  lastMessage: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
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
    length: 128,
    nullable: true,
    default: null,
  })
  externalThreadId: string | null;

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

  @Column({ name: 'has_phone_collected', type: 'boolean', default: false })
  hasPhoneCollected: boolean;

  @Column({ name: 'has_order_created', type: 'boolean', default: false })
  hasOrderCreated: boolean;

  @Column({ name: 'source_post_id', type: 'varchar', length: 128, nullable: true, default: null })
  sourcePostId: string | null;

  @Column({ name: 'source_ad_id', type: 'varchar', length: 128, nullable: true, default: null })
  sourceAdId: string | null;

  @Column({ name: 'ctwa_click_id', type: 'varchar', length: 255, nullable: true, default: null })
  ctwaClickId: string | null;

  @Column({ name: 'active_tag_ids_json', type: 'json', nullable: true })
  activeTagIdsJson: string[] | null;

  @Column({ name: 'snoozed_until_at', type: 'datetime', nullable: true, default: null })
  snoozedUntilAt: Date | null;

  @OneToMany(() => ConversationParticipantEntity, (p) => p.conversation)
  participants: ConversationParticipantEntity[];

  @OneToMany(() => MessageEntity, (m) => m.conversation)
  messages: MessageEntity[];
}
