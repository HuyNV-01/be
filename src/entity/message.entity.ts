import { MessageStatusEnum, MessageTypeEnum } from 'src/common/enum';
import * as messageInterface from 'src/interface/message.interface';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseModel } from './base-model';
import { ConversationEntity } from './conversation.entity';
import { UserEntity } from './user.entity';

@Entity('messages')
@Index(['conversationId', 'createdAt'])
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

  @Column()
  @Index()
  conversationId: string;

  @ManyToOne(() => ConversationEntity, (c) => c.messages, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversationId' })
  conversation: ConversationEntity;

  @Column()
  senderId: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'senderId' })
  sender: UserEntity;

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
}
