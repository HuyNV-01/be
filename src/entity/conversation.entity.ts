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

  @OneToMany(() => ConversationParticipantEntity, (p) => p.conversation)
  participants: ConversationParticipantEntity[];

  @OneToMany(() => MessageEntity, (m) => m.conversation)
  messages: MessageEntity[];
}
