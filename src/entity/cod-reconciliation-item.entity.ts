import { CodReconciliationDiscrepancyTypeEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

@Entity('cod_reconciliation_items')
@Index('idx_cod_item_batch_type', ['batchId', 'discrepancyType'])
@Index('idx_cod_item_shop_tracking', ['shopId', 'trackingNumber'])
export class CodReconciliationItemEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'batch_id', type: 'varchar', length: 36 })
  batchId: string;

  @Column({ name: 'order_id', type: 'varchar', length: 36, nullable: true, default: null })
  orderId: string | null;

  @Column({ name: 'order_code', type: 'varchar', length: 48, nullable: true, default: null })
  orderCode: string | null;

  @Column({ name: 'tracking_number', type: 'varchar', length: 64 })
  trackingNumber: string;

  @Column({
    name: 'discrepancy_type',
    type: 'enum',
    enum: CodReconciliationDiscrepancyTypeEnum,
    default: CodReconciliationDiscrepancyTypeEnum.MATCHED,
  })
  discrepancyType: CodReconciliationDiscrepancyTypeEnum;

  @Column({ name: 'expected_cod_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  expectedCodAmount: number;

  @Column({ name: 'actual_cod_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  actualCodAmount: number;

  @Column({ name: 'cod_variance_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  codVarianceAmount: number;

  @Column({
    name: 'expected_shipping_fee',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  expectedShippingFee: number;

  @Column({ name: 'actual_shipping_fee', type: 'decimal', precision: 15, scale: 2, default: 0 })
  actualShippingFee: number;

  @Column({
    name: 'shipping_fee_variance_amount',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  shippingFeeVarianceAmount: number;

  @Column({ name: 'actual_packed_weight_grams', type: 'int', nullable: true, default: null })
  actualPackedWeightGrams: number | null;

  @Column({ name: 'carrier_charged_weight_grams', type: 'int', nullable: true, default: null })
  carrierChargedWeightGrams: number | null;

  @Column({ name: 'return_fee_charged', type: 'decimal', precision: 15, scale: 2, default: 0 })
  returnFeeCharged: number;

  @Column({ name: 'is_reconciled', type: 'boolean', default: false })
  isReconciled: boolean;

  @Column({ name: 'dispute_note', type: 'text', nullable: true, default: null })
  disputeNote: string | null;
}
