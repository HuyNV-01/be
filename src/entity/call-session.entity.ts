import { CallStatusEnum, CallTypeEnum } from 'src/common/enum';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseModel } from './base-model';
import { ConversationEntity } from './conversation.entity';
import { UserEntity } from './user.entity';

export interface CallParticipantRecord {
  userId: string;
  joinedAt: string;
  leftAt?: string;
  isAudioMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing: boolean;
}

@Entity('call_sessions')
@Index(['conversationId', 'createdAt'])
@Index(['initiatorId', 'status'])
export class CallSessionEntity extends BaseModel {
  @Column({ name: 'conversation_id', type: 'varchar', length: 36 })
  conversationId: string;

  @ManyToOne(() => ConversationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: ConversationEntity;

  @Column({ name: 'initiator_id', type: 'varchar', length: 36 })
  initiatorId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'initiator_id' })
  initiator: UserEntity;

  @Column({
    name: 'call_type',
    type: 'enum',
    enum: CallTypeEnum,
    default: CallTypeEnum.AUDIO,
  })
  callType: CallTypeEnum;

  @Column({
    type: 'enum',
    enum: CallStatusEnum,
    default: CallStatusEnum.RINGING,
  })
  status: CallStatusEnum;

  @Column({ name: 'is_group_call', type: 'boolean', default: false })
  isGroupCall: boolean;

  @Column({ name: 'invited_user_ids', type: 'json' })
  invitedUserIds: string[];

  @Column({ name: 'participants', type: 'json' })
  participants: Record<string, CallParticipantRecord>;

  @Column({ name: 'answered_at', type: 'timestamp', nullable: true })
  answeredAt: Date | null;

  @Column({ name: 'ended_at', type: 'timestamp', nullable: true })
  endedAt: Date | null;

  @Column({ name: 'duration_seconds', type: 'int', default: 0 })
  durationSeconds: number;

  @Column({ name: 'end_reason', type: 'varchar', length: 64, nullable: true })
  endReason: string | null;
}
