import { SecurityAuditActionCodeEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

@Entity('security_audit_logs')
@Index('idx_security_audit_logs_id_lookup', ['id'])
@Index('idx_sec_audit_shop_created', ['shopId', 'createdAt'])
@Index('idx_sec_audit_shop_action', ['shopId', 'actionCode', 'createdAt'])
@Index('idx_sec_audit_shop_actor', ['shopId', 'actorUserId', 'createdAt'])
export class SecurityAuditLogEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'actor_user_id', type: 'varchar', length: 36 })
  actorUserId: string;

  @Column({ name: 'actor_name', type: 'varchar', length: 255, nullable: true, default: null })
  actorName: string | null;

  @Column({
    name: 'action_code',
    type: 'enum',
    enum: SecurityAuditActionCodeEnum,
  })
  actionCode: SecurityAuditActionCodeEnum;

  @Column({ name: 'target_resource_type', type: 'varchar', length: 64 })
  targetResourceType: string;

  @Column({ name: 'target_resource_id', type: 'varchar', length: 128 })
  targetResourceId: string;

  @Column({ name: 'before_snapshot_json', type: 'json', nullable: true, default: null })
  beforeSnapshotJson: Record<string, unknown> | null;

  @Column({ name: 'after_snapshot_json', type: 'json', nullable: true, default: null })
  afterSnapshotJson: Record<string, unknown> | null;

  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true, default: null })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true, default: null })
  userAgent: string | null;

  @Column({ name: 'prev_hash', type: 'varchar', length: 64 })
  prevHash: string;

  @Column({ name: 'entry_hmac_hash', type: 'varchar', length: 64 })
  entryHmacHash: string;
}
