import { CodReconciliationBatchStatusEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

@Entity('cod_reconciliation_batches')
@Index('uq_cod_batch_shop_code', ['shopId', 'batchCode'], { unique: true })
@Index('idx_cod_batch_shop_status', ['shopId', 'status', 'createdAt'])
export class CodReconciliationBatchEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'batch_code', type: 'varchar', length: 48 })
  batchCode: string;

  @Column({ name: 'carrier_code', type: 'varchar', length: 24 })
  carrierCode: 'GHN' | 'GHTK' | 'VTP' | 'JT' | 'OTHER';

  @Column({ name: 'source_file_name', type: 'varchar', length: 255, default: 'manual_import.csv' })
  sourceFileName: string;

  @Column({ name: 'total_orders_count', type: 'int', default: 0 })
  totalOrdersCount: number;

  @Column({ name: 'matched_orders_count', type: 'int', default: 0 })
  matchedOrdersCount: number;

  @Column({ name: 'discrepancy_orders_count', type: 'int', default: 0 })
  discrepancyOrdersCount: number;

  @Column({ name: 'expected_cod_total', type: 'decimal', precision: 18, scale: 2, default: 0 })
  expectedCodTotal: number;

  @Column({ name: 'actual_cod_total', type: 'decimal', precision: 18, scale: 2, default: 0 })
  actualCodTotal: number;

  @Column({
    name: 'expected_shipping_fee_total',
    type: 'decimal',
    precision: 18,
    scale: 2,
    default: 0,
  })
  expectedShippingFeeTotal: number;

  @Column({
    name: 'actual_shipping_fee_total',
    type: 'decimal',
    precision: 18,
    scale: 2,
    default: 0,
  })
  actualShippingFeeTotal: number;

  @Column({ name: 'net_settlement_amount', type: 'decimal', precision: 18, scale: 2, default: 0 })
  netSettlementAmount: number;

  @Column({
    name: 'status',
    type: 'enum',
    enum: CodReconciliationBatchStatusEnum,
    default: CodReconciliationBatchStatusEnum.DRAFT_PARSED,
  })
  status: CodReconciliationBatchStatusEnum;

  @Column({
    name: 'confirmed_by_user_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  confirmedByUserId: string | null;

  @Column({ name: 'confirmed_at', type: 'timestamp', nullable: true, default: null })
  confirmedAt: Date | null;

  @Column({ name: 'note', type: 'text', nullable: true, default: null })
  note: string | null;
}
