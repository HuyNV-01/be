import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { ConversationEntity } from './conversation.entity';
import { UserEntity } from './user.entity';
import { BaseModel } from './base-model';

@Entity('conversation_participants')
@Index(['conversationId', 'userId'], { unique: true })
export class ConversationParticipantEntity extends BaseModel {
  @Column()
  conversationId: string;

  @ManyToOne(() => ConversationEntity, (c) => c.participants, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversationId' })
  conversation: ConversationEntity;

  @Column()
  userId: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'userId' })
  user: UserEntity;

  @Column({ default: false })
  isAdmin: boolean;

  @Column({ nullable: true })
  lastReadAt: Date;

  @Column({ default: false })
  isMuted: boolean;

  @CreateDateColumn()
  joinedAt: Date;
}
