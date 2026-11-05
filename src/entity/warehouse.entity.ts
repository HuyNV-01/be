import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

@Entity('warehouses')
@Index('uq_warehouse_shop_code', ['shopId', 'code'], { unique: true })
export class WarehouseEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'code', type: 'varchar', length: 32 })
  code: string;

  @Column({ name: 'name', type: 'varchar', length: 150 })
  name: string;

  @Column({ name: 'province_code', type: 'varchar', length: 16, default: '01' })
  provinceCode: string;

  @Column({ name: 'district_code', type: 'varchar', length: 16, default: '001' })
  districtCode: string;

  @Column({ name: 'ward_code', type: 'varchar', length: 16, default: '00001' })
  wardCode: string;

  @Column({ name: 'address_line', type: 'varchar', length: 300 })
  addressLine: string;

  @Column({ name: 'contact_phone', type: 'varchar', length: 24 })
  contactPhone: string;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean;

  @Column({ name: 'priority_order', type: 'int', default: 1 })
  priorityOrder: number;

  @Column({ name: 'allow_negative_stock', type: 'boolean', default: false })
  allowNegativeStock: boolean;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
