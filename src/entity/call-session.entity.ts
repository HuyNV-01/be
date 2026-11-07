import { CallStatusEnum, CallTypeEnum } from 'src/common/enum';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseModel } from './base-model';
import { ConversationEntity } from './conversation.entity';
import { UserEntity } from './user.entity';

export enum CallDirectionEnum {
  INTERNAL_WEBRTC = 'INTERNAL_WEBRTC',
  OUTBOUND_SIP_PSTN = 'OUTBOUND_SIP_PSTN',
  INBOUND_SIP_PSTN = 'INBOUND_SIP_PSTN',
}

export interface CallParticipantRecord {
  userId: string;
  joinedAt: string;
  leftAt?: string;
  isAudioMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing: boolean;
  isHandRaised?: boolean;
  raisedHandAt?: string | null;
}

@Entity('call_sessions')
@Index('idx_call_conv_status_created', ['conversationId', 'status', 'createdAt'])
@Index('idx_call_initiator_created', ['initiatorId', 'createdAt'])
@Index('idx_call_status_created', ['status', 'createdAt'])
@Index('idx_call_shop_customer_created', ['shopId', 'customerId', 'createdAt'])
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

  @Column({
    name: 'topology',
    type: 'varchar',
    length: 16,
    default: 'MESH',
  })
  topology: 'MESH' | 'SFU';

  @Column({ name: 'max_concurrent_participants', type: 'int', default: 1 })
  maxConcurrentParticipants: number;

  // ============================================================================
  // SPRINT 2 — MASKED VOIP / SIP TRUNK EXTENSIONS (F03.10 & T04)
  // ============================================================================

  @Column({ name: 'shop_id', type: 'varchar', length: 36, nullable: true, default: null })
  shopId: string | null;

  @Column({ name: 'customer_id', type: 'varchar', length: 36, nullable: true, default: null })
  customerId: string | null;

  @Column({ name: 'order_id', type: 'varchar', length: 36, nullable: true, default: null })
  orderId: string | null;

  @Column({
    name: 'call_direction',
    type: 'enum',
    enum: CallDirectionEnum,
    default: CallDirectionEnum.INTERNAL_WEBRTC,
  })
  callDirection: CallDirectionEnum;

  @Column({
    name: 'sip_trunk_provider',
    type: 'varchar',
    length: 64,
    nullable: true,
    default: null,
  })
  sipTrunkProvider: string | null;

  @Column({
    name: 'masked_phone_display',
    type: 'varchar',
    length: 32,
    nullable: true,
    default: null,
  })
  maskedPhoneDisplay: string | null;

  @Column({ name: 'recording_file_id', type: 'varchar', length: 36, nullable: true, default: null })
  recordingFileId: string | null;

  @Column({
    name: 'recording_file_url',
    type: 'varchar',
    length: 500,
    nullable: true,
    default: null,
  })
  recordingFileUrl: string | null;

  @Column({
    name: 'call_disposition_tag',
    type: 'varchar',
    length: 64,
    nullable: true,
    default: null,
  })
  callDispositionTag: string | null;

  @Column({ name: 'call_notes', type: 'varchar', length: 500, nullable: true, default: null })
  callNotes: string | null;
}
