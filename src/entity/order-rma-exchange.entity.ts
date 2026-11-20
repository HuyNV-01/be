import { OmsReturnConditionEnum, OmsRmaStatusEnum, OmsRmaTypeEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export interface RmaReturnLineItem {
  variantId: string;
  skuCode: string;
  barcode: string;
  variantName: string;
  expectedQty: number;
  verifiedQty: number;
  unitPrice: number;
  condition: OmsReturnConditionEnum;
  serialNumbers?: string[];
  evidenceImageUrls?: string[];
  inspectionNote?: string | null;
}

export interface RmaOutboundLineItem {
  variantId: string;
  skuCode: string;
  barcode: string;
  variantName: string;
  quantity: number;
  unitPrice: number;
  weightGrams: number;
  warehouseId: string;
}

@Entity('order_rma_exchanges')
@Index('uq_rma_shop_code', ['shopId', 'rmaCode'], { unique: true })
@Index('idx_rma_shop_original_order', ['shopId', 'originalOrderId'])
@Index('idx_rma_shop_status', ['shopId', 'status', 'createdAt'])
export class OrderRmaExchangeEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'rma_code', type: 'varchar', length: 48 })
  rmaCode: string;

  @Column({
    name: 'rma_type',
    type: 'enum',
    enum: OmsRmaTypeEnum,
    default: OmsRmaTypeEnum.EXCHANGE_2_WAY,
  })
  rmaType: OmsRmaTypeEnum;

  @Column({
    name: 'status',
    type: 'enum',
    enum: OmsRmaStatusEnum,
    default: OmsRmaStatusEnum.PENDING_DISPATCH,
  })
  status: OmsRmaStatusEnum;

  @Column({ name: 'original_order_id', type: 'varchar', length: 36 })
  originalOrderId: string;

  @Column({ name: 'original_order_code', type: 'varchar', length: 48 })
  originalOrderCode: string;

  @Column({
    name: 'exchange_order_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  exchangeOrderId: string | null;

  @Column({
    name: 'exchange_order_code',
    type: 'varchar',
    length: 48,
    nullable: true,
    default: null,
  })
  exchangeOrderCode: string | null;

  @Column({ name: 'customer_id', type: 'varchar', length: 36, nullable: true, default: null })
  customerId: string | null;

  @Column({ name: 'customer_name', type: 'varchar', length: 255 })
  customerName: string;

  @Column({ name: 'warehouse_id', type: 'varchar', length: 36 })
  warehouseId: string;

  @Column({ name: 'return_items_json', type: 'json' })
  returnItemsJson: RmaReturnLineItem[];

  @Column({ name: 'outbound_items_json', type: 'json' })
  outboundItemsJson: RmaOutboundLineItem[];

  @Column({
    name: 'return_items_total_amount',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  returnItemsTotalAmount: number;

  @Column({
    name: 'outbound_items_total_amount',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  outboundItemsTotalAmount: number;

  @Column({
    name: 'rma_shipping_fee_customer_charged',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  rmaShippingFeeCustomerCharged: number;

  /**
   * > 0: Khách thanh toán thêm COD; < 0: Shop hoàn lại chênh lệch (vào Ví khách hàng hoặc chuyển khoản)
   */
  @Column({ name: 'cod_delta_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  codDeltaAmount: number;

  @Column({ name: 'refund_to_wallet_credit', type: 'boolean', default: true })
  refundToWalletCredit: boolean;

  @Column({ name: 'reason_note', type: 'text', nullable: true, default: null })
  reasonNote: string | null;

  @Column({
    name: 'carrier_claim_code',
    type: 'varchar',
    length: 64,
    nullable: true,
    default: null,
  })
  carrierClaimCode: string | null;

  @Column({
    name: 'verified_by_user_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  verifiedByUserId: string | null;

  @Column({ name: 'verified_at', type: 'timestamp', nullable: true, default: null })
  verifiedAt: Date | null;
}
