import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export enum CarrierHandoverManifestStatusEnum {
  DRAFT_SCANNING = 'DRAFT_SCANNING',
  SEALED_HANDED_OVER = 'SEALED_HANDED_OVER',
  CANCELLED = 'CANCELLED',
}

export interface HandoverManifestScannedOrderItem {
  orderId: string;
  orderCode: string;
  trackingNumber: string;
  customerName: string;
  codCollectAmount: number;
  actualPackedWeightGrams: number;
  scannedAtIso: string;
  scannedByUserId: string;
}

/**
 * Biên bản bàn giao vận chuyển quét Barcode (Pancake POS F07.9B).
 * Lưu vết đối chứng từng kiện hàng đã trao tay bưu tá để ngăn thất lạc kiện & làm bằng chứng khiếu nại 3PL.
 */
@Entity('carrier_handover_manifests')
@Index('uq_handover_manifest_shop_code', ['shopId', 'manifestCode'], {
  unique: true,
})
@Index('idx_handover_manifest_shop_status', ['shopId', 'status', 'createdAt'])
@Index('idx_handover_manifest_carrier', ['shopId', 'carrierCode', 'createdAt'])
export class CarrierHandoverManifestEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'manifest_code', type: 'varchar', length: 48 })
  manifestCode: string;

  @Column({ name: 'warehouse_id', type: 'varchar', length: 36 })
  warehouseId: string;

  @Column({ name: 'warehouse_name', type: 'varchar', length: 150, default: '' })
  warehouseName: string;

  @Column({ name: 'carrier_code', type: 'varchar', length: 24 })
  carrierCode: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: CarrierHandoverManifestStatusEnum,
    default: CarrierHandoverManifestStatusEnum.DRAFT_SCANNING,
  })
  status: CarrierHandoverManifestStatusEnum;

  @Column({
    name: 'courier_driver_name',
    type: 'varchar',
    length: 120,
    nullable: true,
    default: null,
  })
  courierDriverName: string | null;

  @Column({
    name: 'courier_driver_phone',
    type: 'varchar',
    length: 32,
    nullable: true,
    default: null,
  })
  courierDriverPhone: string | null;

  @Column({
    name: 'courier_vehicle_plate',
    type: 'varchar',
    length: 32,
    nullable: true,
    default: null,
  })
  courierVehiclePlate: string | null;

  @Column({ name: 'scanned_orders_json', type: 'json' })
  scannedOrdersJson: HandoverManifestScannedOrderItem[];

  @Column({ name: 'total_parcels_count', type: 'int', default: 0 })
  totalParcelsCount: number;

  @Column({ name: 'total_weight_grams', type: 'int', default: 0 })
  totalWeightGrams: number;

  @Column({
    name: 'total_cod_amount',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  totalCodAmount: number;

  @Column({
    name: 'sealed_by_user_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  sealedByUserId: string | null;

  @Column({
    name: 'sealed_at',
    type: 'timestamp',
    nullable: true,
    default: null,
  })
  sealedAt: Date | null;

  @Column({ name: 'note', type: 'text', nullable: true, default: null })
  note: string | null;
}
