import { NotificationResourceTypeEnum, NotificationTypeEnum } from 'src/common/enum';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseModel } from './base-model';
import { UserEntity } from './user.entity';

export interface NotificationMetadata {
  conversationId?: string;
  conversationName?: string;
  conversationType?: string;
  messageId?: string;
  messageType?: string;
  callId?: string;
  callType?: string;
  emoji?: string;
  unreadMessageCount?: number;
  actionUrl?: string;
  // Bổ sung cho đa ngôn ngữ (i18n) trên FE
  titleKey?: string;
  contentKey?: string;
  i18nParams?: Record<string, string | number | boolean | null | undefined>;
  extra?: Record<string, unknown>;
}

@Entity('notifications')
@Index(['recipientId', 'isRead', 'createdAt'])
@Index(['recipientId', 'dedupeKey'])
@Index(['recipientId', 'resourceType', 'resourceId'])
export class NotificationEntity extends BaseModel {
  @Column({ name: 'recipient_id', type: 'varchar', length: 36 })
  @Index()
  recipientId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipient_id' })
  recipient: UserEntity;

  @Column({ name: 'actor_id', type: 'varchar', length: 36, nullable: true })
  actorId: string | null;

  @ManyToOne(() => UserEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_id' })
  actor: UserEntity | null;

  @Column({
    type: 'enum',
    enum: NotificationTypeEnum,
    default: NotificationTypeEnum.SYSTEM,
  })
  type: NotificationTypeEnum;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text' })
  content: string;

  @Column({
    name: 'resource_type',
    type: 'enum',
    enum: NotificationResourceTypeEnum,
    default: NotificationResourceTypeEnum.SYSTEM,
  })
  resourceType: NotificationResourceTypeEnum;

  @Column({ name: 'resource_id', type: 'varchar', length: 64, nullable: true })
  resourceId: string | null;

  @Column({ name: 'dedupe_key', type: 'varchar', length: 120, nullable: true })
  dedupeKey: string | null;

  @Column({ name: 'is_read', type: 'boolean', default: false })
  isRead: boolean;

  @Column({ name: 'read_at', type: 'timestamp', precision: 6, nullable: true })
  readAt: Date | null;

  @Column({ type: 'json', nullable: true })
  metadata: NotificationMetadata | null;
}
