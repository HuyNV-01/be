import { WarehouseTransferStatusEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export interface WarehouseTransferLineItem {
  variantId: string;
  skuCode: string;
  variantName: string;
  requestedQty: number;
  shippedQty: number;
  receivedQty: number;
  discrepancyReason?: string | null;
}

@Entity('warehouse_transfer_orders')
@Index('uq_transfer_shop_code', ['shopId', 'transferCode'], { unique: true })
@Index('idx_transfer_shop_status', ['shopId', 'status'])
export class WarehouseTransferOrderEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'transfer_code', type: 'varchar', length: 48 })
  transferCode: string;

  @Column({ name: 'from_warehouse_id', type: 'varchar', length: 36 })
  fromWarehouseId: string;

  @Column({ name: 'from_warehouse_name', type: 'varchar', length: 150 })
  fromWarehouseName: string;

  @Column({ name: 'to_warehouse_id', type: 'varchar', length: 36 })
  toWarehouseId: string;

  @Column({ name: 'to_warehouse_name', type: 'varchar', length: 150 })
  toWarehouseName: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: WarehouseTransferStatusEnum,
    default: WarehouseTransferStatusEnum.DRAFT,
  })
  status: WarehouseTransferStatusEnum;

  @Column({ name: 'items_json', type: 'json' })
  itemsJson: WarehouseTransferLineItem[];

  @Column({ name: 'note', type: 'text', nullable: true, default: null })
  note: string | null;

  @Column({
    name: 'shipped_by_user_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  shippedByUserId: string | null;

  @Column({ name: 'shipped_at', type: 'datetime', nullable: true, default: null })
  shippedAt: Date | null;

  @Column({
    name: 'received_by_user_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  receivedByUserId: string | null;

  @Column({ name: 'received_at', type: 'datetime', nullable: true, default: null })
  receivedAt: Date | null;
}
