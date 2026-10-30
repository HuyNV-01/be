import { MessageStatusEnum, MessageTypeEnum } from 'src/common/enum';
import * as messageInterface from 'src/interface/message.interface';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseModel } from './base-model';
import { ConversationEntity } from './conversation.entity';
import { UserEntity } from './user.entity';

@Entity('messages')
@Index('idx_msg_id_lookup', ['id'])
@Index(['conversationId', 'createdAt'])
@Index(['conversationId', 'isPinned'])
@Index(['conversationId', 'senderId', 'clientTempId'])
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

  @Column({ type: 'varchar', length: 36 })
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
}
