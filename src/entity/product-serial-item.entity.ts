import { ProductSerialStatusEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

@Entity('product_serial_items')
@Index('uq_serial_shop_number', ['shopId', 'serialNumber'], { unique: true })
@Index('idx_serial_shop_variant_wh', ['shopId', 'variantId', 'warehouseId', 'status'])
export class ProductSerialItemEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'warehouse_id', type: 'varchar', length: 36 })
  warehouseId: string;

  @Column({ name: 'variant_id', type: 'varchar', length: 36 })
  variantId: string;

  @Column({ name: 'sku_code', type: 'varchar', length: 80 })
  skuCode: string;

  @Column({ name: 'variant_name', type: 'varchar', length: 255 })
  variantName: string;

  @Column({ name: 'serial_number', type: 'varchar', length: 100 })
  serialNumber: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: ProductSerialStatusEnum,
    default: ProductSerialStatusEnum.IN_STOCK,
  })
  status: ProductSerialStatusEnum;

  @Column({ name: 'sold_order_id', type: 'varchar', length: 36, nullable: true, default: null })
  soldOrderId: string | null;

  @Column({ name: 'sold_order_code', type: 'varchar', length: 48, nullable: true, default: null })
  soldOrderCode: string | null;

  @Column({ name: 'customer_id', type: 'varchar', length: 36, nullable: true, default: null })
  customerId: string | null;

  @Column({ name: 'warranty_months', type: 'int', default: 12 })
  warrantyMonths: number;

  @Column({ name: 'activated_at', type: 'datetime', nullable: true, default: null })
  activatedAt: Date | null;

  @Column({ name: 'warranty_expires_at', type: 'datetime', nullable: true, default: null })
  warrantyExpiresAt: Date | null;

  @Column({ name: 'note', type: 'text', nullable: true, default: null })
  note: string | null;
}
