import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseModel } from './base-model';
import { ConversationEntity } from './conversation.entity';
import { UserEntity } from './user.entity';

@Entity('conversation_participants')
@Index(['conversationId', 'userId'], { unique: true })
@Index(['userId'])
export class ConversationParticipantEntity extends BaseModel {
  @Column({ type: 'varchar', length: 36 })
  conversationId: string;

  @ManyToOne(() => ConversationEntity, (c) => c.participants, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversationId' })
  conversation: ConversationEntity;

  @Column({ type: 'varchar', length: 36 })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: UserEntity;

  @Column({ default: false })
  isAdmin: boolean;

  @Column({ type: 'datetime', nullable: true })
  lastReadAt: Date;

  @Column({ default: false })
  isMuted: boolean;

  @CreateDateColumn()
  joinedAt: Date;
}
