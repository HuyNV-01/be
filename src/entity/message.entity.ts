import { MessageStatusEnum, MessageTypeEnum } from 'src/common/enum';
import * as messageInterface from 'src/interface/message.interface';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseModel } from './base-model';
import { ConversationEntity } from './conversation.entity';
import { UserEntity } from './user.entity';

export enum MessageDirectionEnum {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
  INTERNAL_NOTE = 'INTERNAL_NOTE',
  SYSTEM = 'SYSTEM',
}

export interface ExtractedCommerceEntitiesPayload {
  phones?: string[];
  provinceCode?: string | null;
  districtCode?: string | null;
  wardCode?: string | null;
  addressLine?: string | null;
  skuCodes?: string[];
}

@Entity('messages')
@Index('idx_msg_id_lookup', ['id'])
@Index(['conversationId', 'createdAt'])
@Index(['conversationId', 'isPinned'])
@Index(['conversationId', 'senderId', 'clientTempId'])
@Index('idx_msg_shop_conv_created', ['shopId', 'conversationId', 'createdAt'])
@Index('idx_msg_shop_ext_id', ['shopId', 'externalMessageId'])
export class MessageEntity extends BaseModel {
  @Column({ type: 'text', nullable: true })
  content: string;

  @Column({
    type: 'enum',
    enum: MessageTypeEnum,
    default: MessageTypeEnum.TEXT,
  })
  type: MessageTypeEnum;

  @Column({ type: 'json', nullable: true })
  metadata: messageInterface.MessageMetadata;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  conversationId: string;

  @ManyToOne(() => ConversationEntity, (c) => c.messages, {
    onDelete: 'CASCADE',
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'conversationId' })
  conversation: ConversationEntity;

  @Column({ type: 'varchar', length: 64 })
  @Index()
  senderId: string;

  @ManyToOne(() => UserEntity, {
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'senderId' })
  sender: UserEntity;

  @Column({ name: 'reply_to_message_id', type: 'varchar', length: 36, nullable: true })
  @Index()
  replyToMessageId: string | null;

  @ManyToOne(() => MessageEntity, {
    nullable: true,
    onDelete: 'SET NULL',
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'reply_to_message_id' })
  replyToMessage: MessageEntity | null;

  @Column({ name: 'is_pinned', type: 'boolean', default: false })
  isPinned: boolean;

  @Column({ name: 'client_temp_id', type: 'varchar', length: 64, nullable: true })
  clientTempId: string | null;

  @Column({ type: 'json' })
  readBy: string[];

  @Column({
    type: 'enum',
    enum: MessageStatusEnum,
    default: MessageStatusEnum.SENT,
  })
  status: MessageStatusEnum;

  @Column({ type: 'json' })
  deliveredTo: string[];

  @Column({ name: 'expires_at', type: 'datetime', nullable: true, default: null })
  @Index()
  expiresAt: Date | null;

  // ============================================================================
  // OMNICHANNEL SELLER OS EXTENSIONS (Zero-Config DatabaseEvolutionService Safe)
  // ============================================================================

  @Column({ name: 'shop_id', type: 'varchar', length: 36, nullable: true, default: null })
  shopId: string | null;

  @Column({
    name: 'direction',
    type: 'enum',
    enum: MessageDirectionEnum,
    default: MessageDirectionEnum.INBOUND,
  })
  direction: MessageDirectionEnum;

  @Column({
    name: 'external_message_id',
    type: 'varchar',
    length: 191,
    nullable: true,
    default: null,
  })
  externalMessageId: string | null;

  @Column({ name: 'is_internal_note', type: 'boolean', default: false })
  isInternalNote: boolean;

  @Column({ name: 'message_tag_ids_json', type: 'json', nullable: true })
  messageTagIdsJson: string[] | null;

  @Column({ name: 'extracted_entities_json', type: 'json', nullable: true, default: null })
  extractedEntitiesJson: ExtractedCommerceEntitiesPayload | null;

  @Column({
    name: 'ai_draft_confidence',
    type: 'decimal',
    precision: 5,
    scale: 4,
    nullable: true,
    default: null,
  })
  aiDraftConfidence: number | null;

  @Column({ name: 'order_id_ref', type: 'varchar', length: 36, nullable: true, default: null })
  orderIdRef: string | null;
}
