import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

@Entity('warehouse_stock_items')
@Index('uq_warehouse_variant_stock', ['warehouseId', 'variantId'], { unique: true })
@Index('idx_stock_shop_variant', ['shopId', 'variantId'])
@Index('idx_stock_shop_warehouse', ['shopId', 'warehouseId'])
export class WarehouseStockItemEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'warehouse_id', type: 'varchar', length: 36 })
  warehouseId: string;

  @Column({ name: 'variant_id', type: 'varchar', length: 36 })
  variantId: string;

  @Column({ name: 'sku_code', type: 'varchar', length: 80 })
  skuCode: string;

  /**
   * 1. Tồn vật lý thực tế trong kho (chỉ trừ khi thực sự đóng gói xuất giao cho bưu tá `ORDER_SHIP`)
   */
  @Column({ name: 'on_hand_qty', type: 'int', default: 0 })
  onHandQty: number;

  /**
   * 2. Số lượng đang giữ chỗ tạm thời cho giỏ hàng nháp POS (TTL 15 phút) hoặc đơn đã xác nhận nhưng chưa đóng gói
   */
  @Column({ name: 'reserved_qty', type: 'int', default: 0 })
  reservedQty: number;

  /**
   * 3. Số lượng có thể bán (`availableQty = onHandQty - reservedQty`) hiển thị cho Sale và đồng bộ sàn TMĐT
   */
  @Column({ name: 'available_qty', type: 'int', default: 0 })
  availableQty: number;

  /**
   * Số lượng đang trên đường điều chuyển nội bộ giữa các kho (`TRANSFER_OUT` -> `TRANSFER_IN`)
   */
  @Column({ name: 'in_transit_qty', type: 'int', default: 0 })
  inTransitQty: number;

  /**
   * 4. Số lượng hàng lỗi / hàng hoàn đang chờ kiểm định, không được tính vào `availableQty`
   */
  @Column({ name: 'defective_hold_qty', type: 'int', default: 0 })
  defectiveHoldQty: number;

  @Column({ name: 'bin_location_code', type: 'varchar', length: 64, default: 'KHU-A-01' })
  binLocationCode: string;

  @Column({ name: 'low_stock_threshold', type: 'int', default: 5 })
  lowStockThreshold: number;
}
