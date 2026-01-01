import { ConversationTypeEnum } from 'src/common/enum';
import { Column, Entity, Index, OneToMany } from 'typeorm';

import { BaseModel } from './base-model';
import { ConversationParticipantEntity } from './conversation-participant.entity';
import { MessageEntity } from './message.entity';

@Entity('conversations')
@Index(['lastMessageAt'])
export class ConversationEntity extends BaseModel {
  @Column({
    type: 'enum',
    enum: ConversationTypeEnum,
    default: ConversationTypeEnum.DIRECT,
  })
  type: ConversationTypeEnum;

  @Column({ nullable: true })
  name: string;

  @Column({ nullable: true })
  avatar: string;

  @Column({ type: 'text', nullable: true })
  lastMessage: string;

  @Column({ nullable: true })
  lastMessageSenderId: string;

  @Column({ nullable: true })
  lastMessageType: string;

  @Column({ nullable: true })
  lastMessageAt: Date;

  @OneToMany(() => ConversationParticipantEntity, (p) => p.conversation)
  participants: ConversationParticipantEntity[];

  @OneToMany(() => MessageEntity, (m) => m.conversation)
  messages: MessageEntity[];
}
