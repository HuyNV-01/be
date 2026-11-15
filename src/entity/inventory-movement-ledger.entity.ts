import { InventoryMovementTypeEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

/**
 * Sổ cái Thẻ kho Bất biến Phân vùng theo Tháng (`inventory_movement_ledgers` — F05.5)
 * Đã đăng ký trong `TablePartitionManagerService.PARTITIONED_TABLES`.
 */
@Entity('inventory_movement_ledgers')
@Index('idx_inventory_movement_ledgers_id_lookup', ['id'])
@Index('idx_inv_ledger_shop_wh_var', ['shopId', 'warehouseId', 'variantId', 'createdAt'])
@Index('idx_inv_ledger_shop_ref', ['shopId', 'referenceId'])
export class InventoryMovementLedgerEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'warehouse_id', type: 'varchar', length: 36 })
  warehouseId: string;

  @Column({ name: 'variant_id', type: 'varchar', length: 36 })
  variantId: string;

  @Column({ name: 'sku_code', type: 'varchar', length: 80 })
  skuCode: string;

  @Column({
    name: 'movement_type',
    type: 'enum',
    enum: InventoryMovementTypeEnum,
    default: InventoryMovementTypeEnum.STOCKTAKE_ADJUST,
  })
  movementType: InventoryMovementTypeEnum;

  @Column({ name: 'delta_qty', type: 'int', default: 0 })
  deltaQty: number;

  @Column({ name: 'before_on_hand_qty', type: 'int', default: 0 })
  beforeOnHandQty: number;

  @Column({ name: 'after_on_hand_qty', type: 'int', default: 0 })
  afterOnHandQty: number;

  @Column({ name: 'before_reserved_qty', type: 'int', default: 0 })
  beforeReservedQty: number;

  @Column({ name: 'after_reserved_qty', type: 'int', default: 0 })
  afterReservedQty: number;

  @Column({ name: 'before_available_qty', type: 'int', default: 0 })
  beforeAvailableQty: number;

  @Column({ name: 'after_available_qty', type: 'int', default: 0 })
  afterAvailableQty: number;

  /**
   * Giá vốn đơn vị tại thời điểm phát sinh giao dịch (được bảo vệ bởi FLS)
   */
  @Column({ name: 'cost_price', type: 'decimal', precision: 15, scale: 2, default: 0 })
  costPrice: number;

  @Column({ name: 'reference_type', type: 'varchar', length: 48, default: 'POS_ORDER' })
  referenceType: string;

  @Column({ name: 'reference_id', type: 'varchar', length: 64, nullable: true, default: null })
  referenceId: string | null;

  @Column({ name: 'note', type: 'text', nullable: true, default: null })
  note: string | null;

  @Column({ name: 'actor_user_id', type: 'varchar', length: 36, nullable: true, default: null })
  actorUserId: string | null;
}
