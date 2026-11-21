import { PosOrderStatusEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

@Entity('order_carrier_events')
@Index('idx_carrier_evt_shop_order', ['shopId', 'orderId', 'eventOccurredAt'])
@Index('idx_carrier_evt_tracking', ['shopId', 'trackingNumber'])
export class OrderCarrierEventEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'order_id', type: 'varchar', length: 36 })
  orderId: string;

  @Column({ name: 'order_code', type: 'varchar', length: 48 })
  orderCode: string;

  @Column({ name: 'carrier_code', type: 'varchar', length: 24 })
  carrierCode: string;

  @Column({ name: 'tracking_number', type: 'varchar', length: 64 })
  trackingNumber: string;

  @Column({ name: 'carrier_raw_status', type: 'varchar', length: 80 })
  carrierRawStatus: string;

  @Column({
    name: 'mapped_oms_status',
    type: 'enum',
    enum: PosOrderStatusEnum,
    nullable: true,
    default: null,
  })
  mappedOmsStatus: PosOrderStatusEnum | null;

  @Column({ name: 'description', type: 'text' })
  description: string;

  @Column({
    name: 'location_hub_name',
    type: 'varchar',
    length: 255,
    nullable: true,
    default: null,
  })
  locationHubName: string | null;

  @Column({ name: 'shipper_name', type: 'varchar', length: 120, nullable: true, default: null })
  shipperName: string | null;

  @Column({ name: 'shipper_phone', type: 'varchar', length: 32, nullable: true, default: null })
  shipperPhone: string | null;

  @Column({ name: 'event_source', type: 'varchar', length: 32, default: 'WEBHOOK' })
  eventSource: 'WEBHOOK' | 'MANUAL_RESCUE' | 'SLA_WATCHDOG' | 'SYSTEM';

  @Column({ name: 'event_occurred_at', type: 'timestamp' })
  eventOccurredAt: Date;

  @Column({ name: 'raw_payload_json', type: 'json', nullable: true, default: null })
  rawPayloadJson: Record<string, unknown> | null;
}
