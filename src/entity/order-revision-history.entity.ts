import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export interface OrderFieldDiffEntry {
  field: string;
  label: string;
  beforeValue: unknown;
  afterValue: unknown;
}

@Entity('order_revision_histories')
@Index('idx_order_rev_shop_order', ['shopId', 'orderId', 'revisionNumber'])
export class OrderRevisionHistoryEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'order_id', type: 'varchar', length: 36 })
  orderId: string;

  @Column({ name: 'order_code', type: 'varchar', length: 48 })
  orderCode: string;

  @Column({ name: 'revision_number', type: 'int', default: 1 })
  revisionNumber: number;

  @Column({ name: 'changed_by_user_id', type: 'varchar', length: 36 })
  changedByUserId: string;

  @Column({ name: 'changed_by_name', type: 'varchar', length: 150, default: '' })
  changedByName: string;

  @Column({ name: 'action_type', type: 'varchar', length: 64 })
  actionType: string;

  @Column({ name: 'reason_note', type: 'text', nullable: true, default: null })
  reasonNote: string | null;

  @Column({ name: 'before_snapshot_json', type: 'json' })
  beforeSnapshotJson: Record<string, unknown>;

  @Column({ name: 'after_snapshot_json', type: 'json' })
  afterSnapshotJson: Record<string, unknown>;

  @Column({ name: 'diff_summary_json', type: 'json' })
  diffSummaryJson: OrderFieldDiffEntry[];
}
