import { MessageTypeEnum } from 'src/common/enum';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseModel } from './base-model';
import { ConversationEntity } from './conversation.entity';
import { UserEntity } from './user.entity';

@Entity('messages')
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
  metadata: {
    fileName?: string;
    fileSize?: number;
    width?: number;
    height?: number;
  };

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

  @Column({ type: 'json', nullable: true })
  readBy: string[];
}
