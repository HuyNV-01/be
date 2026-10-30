import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseModel } from './base-model';
import { CallSessionEntity } from './call-session.entity';
import { UserEntity } from './user.entity';

export enum CallParticipantStatusEnum {
  INVITED = 'INVITED',
  JOINED = 'JOINED',
  LEFT = 'LEFT',
  REJECTED = 'REJECTED',
  MISSED = 'MISSED',
  BUSY = 'BUSY',
}

@Entity('call_participants')
@Index('idx_call_part_id_lookup', ['id'])
@Index('idx_call_part_call_user', ['callId', 'userId'])
@Index('idx_call_part_user_joined', ['userId', 'joinedAt'])
@Index('idx_call_part_conv_user', ['conversationId', 'userId', 'createdAt'])
export class CallParticipantEntity extends BaseModel {
  @Column({ name: 'call_id', type: 'varchar', length: 36 })
  callId: string;

  @ManyToOne(() => CallSessionEntity, {
    onDelete: 'CASCADE',
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'call_id' })
  callSession: CallSessionEntity;

  @Column({ name: 'conversation_id', type: 'varchar', length: 36 })
  conversationId: string;

  @Column({ name: 'user_id', type: 'varchar', length: 36 })
  userId: string;

  @ManyToOne(() => UserEntity, {
    onDelete: 'CASCADE',
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({
    type: 'enum',
    enum: CallParticipantStatusEnum,
    default: CallParticipantStatusEnum.INVITED,
  })
  status: CallParticipantStatusEnum;

  @Column({ name: 'joined_at', type: 'timestamp', nullable: true })
  joinedAt: Date | null;

  @Column({ name: 'left_at', type: 'timestamp', nullable: true })
  leftAt: Date | null;

  @Column({ name: 'duration_seconds', type: 'int', default: 0 })
  durationSeconds: number;
}
