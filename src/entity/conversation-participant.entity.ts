import { GroupRoleEnum } from 'src/common/enum';
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

  @Column({
    type: 'enum',
    enum: GroupRoleEnum,
    default: GroupRoleEnum.MEMBER,
  })
  role: GroupRoleEnum;

  @Column({ type: 'datetime', nullable: true })
  lastReadAt: Date;

  @Column({ default: false })
  isMuted: boolean;

  @Column({ name: 'sound_enabled', type: 'boolean', default: true })
  soundEnabled: boolean;

  @Column({ name: 'read_receipts_enabled', type: 'boolean', default: true })
  readReceiptsEnabled: boolean;

  @Column({ name: 'is_restricted', type: 'boolean', default: false })
  isRestricted: boolean;

  @Column({ name: 'is_hidden', type: 'boolean', default: false })
  isHidden: boolean;

  @Column({ name: 'cleared_at', type: 'datetime', nullable: true, default: null })
  clearedAt: Date | null;

  @Column({ name: 'nickname', type: 'varchar', length: 100, nullable: true, default: null })
  nickname: string | null;

  @CreateDateColumn()
  joinedAt: Date;
}
