import {
  ChannelTypeEnum,
  DiscountApprovalStatusEnum,
  PosOrderPaymentMethodEnum,
  PosOrderPaymentStatusEnum,
  PosOrderStatusEnum,
} from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export interface PosOrderLineItem {
  variantId: string;
  productId: string;
  skuCode: string;
  barcode: string;
  variantName: string;
  imageUrl?: string | null;
  quantity: number;
  retailPrice: number;
  discountPercent: number;
  discountAmount: number;
  finalUnitPrice: number;
  lineTotalAmount: number;
  /**
   * Giá vốn snapshot tại thời điểm lên đơn (bảo vệ bởi FieldLevelSecurityInterceptor)
   */
  costPrice: number;
  weightGrams: number;
  isBundleBom: boolean;
  isFreeGift: boolean;
  warehouseId: string;
  warehouseName: string;
  assignedSerialNumbers?: string[];
}

export interface VietQrEmvcoPayloadInfo {
  bankBin: string;
  bankShortName: string;
  accountNumber: string;
  accountName: string;
  amountVnd: number;
  transferReferenceCode: string;
  emvcoRawPayload: string;
  qrImageUrl: string;
  generatedAt: string;
  paidAt?: string | null;
  bankTransactionId?: string | null;
}

@Entity('pos_orders')
@Index('uq_pos_order_shop_code', ['shopId', 'orderCode'], { unique: true })
@Index('idx_pos_order_shop_status', ['shopId', 'status', 'createdAt'])
@Index('idx_pos_order_shop_customer', ['shopId', 'customerId', 'status'])
@Index('idx_pos_order_shop_conv', ['shopId', 'conversationId'])
export class PosOrderEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'order_code', type: 'varchar', length: 48 })
  orderCode: string;

  @Column({ name: 'parent_order_id', type: 'varchar', length: 36, nullable: true, default: null })
  parentOrderId: string | null;

  @Column({ name: 'merged_from_order_ids_json', type: 'json', nullable: true, default: null })
  mergedFromOrderIdsJson: string[] | null;

  @Column({ name: 'split_child_order_ids_json', type: 'json', nullable: true, default: null })
  splitChildOrderIdsJson: string[] | null;

  @Column({ name: 'conversation_id', type: 'varchar', length: 36, nullable: true, default: null })
  conversationId: string | null;

  @Column({ name: 'customer_id', type: 'varchar', length: 36, nullable: true, default: null })
  customerId: string | null;

  @Column({ name: 'customer_name', type: 'varchar', length: 255 })
  customerName: string;

  @Column({ name: 'customer_phone_masked', type: 'varchar', length: 32, default: '098***678' })
  customerPhoneMasked: string;

  @Column({ name: 'customer_phone_encrypted', type: 'text', nullable: true, default: null })
  customerPhoneEncrypted: string | null;

  @Column({
    name: 'channel_type',
    type: 'enum',
    enum: ChannelTypeEnum,
    default: ChannelTypeEnum.FACEBOOK_PAGE,
  })
  channelType: ChannelTypeEnum;

  @Column({ name: 'page_short_code', type: 'varchar', length: 64, nullable: true, default: null })
  pageShortCode: string | null;

  @Column({ name: 'warehouse_id', type: 'varchar', length: 36 })
  warehouseId: string;

  @Column({ name: 'warehouse_name', type: 'varchar', length: 150 })
  warehouseName: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: PosOrderStatusEnum,
    default: PosOrderStatusEnum.CONFIRMED,
  })
  status: PosOrderStatusEnum;

  // Địa chỉ nhận hàng hỗ trợ đồng thời 3 Cấp Mới (34 tỉnh) & 4 Cấp Cũ (63 tỉnh)
  @Column({ name: 'address_tier_mode', type: 'varchar', length: 16, default: '3_TIER' })
  addressTierMode: '3_TIER' | '4_TIER';

  @Column({
    name: 'receiver_province_code',
    type: 'varchar',
    length: 32,
    nullable: true,
    default: null,
  })
  receiverProvinceCode: string | null;

  @Column({
    name: 'receiver_province_name',
    type: 'varchar',
    length: 120,
    nullable: true,
    default: null,
  })
  receiverProvinceName: string | null;

  @Column({
    name: 'receiver_district_code',
    type: 'varchar',
    length: 32,
    nullable: true,
    default: null,
  })
  receiverDistrictCode: string | null;

  @Column({
    name: 'receiver_district_name',
    type: 'varchar',
    length: 120,
    nullable: true,
    default: null,
  })
  receiverDistrictName: string | null;

  @Column({
    name: 'receiver_ward_code',
    type: 'varchar',
    length: 48,
    nullable: true,
    default: null,
  })
  receiverWardCode: string | null;

  @Column({
    name: 'receiver_ward_name',
    type: 'varchar',
    length: 150,
    nullable: true,
    default: null,
  })
  receiverWardName: string | null;

  @Column({
    name: 'receiver_hamlet_code',
    type: 'varchar',
    length: 64,
    nullable: true,
    default: null,
  })
  receiverHamletCode: string | null;

  @Column({
    name: 'receiver_hamlet_name',
    type: 'varchar',
    length: 150,
    nullable: true,
    default: null,
  })
  receiverHamletName: string | null;

  @Column({ name: 'receiver_address_line', type: 'text', nullable: true, default: null })
  receiverAddressLine: string | null;

  @Column({ name: 'full_three_tier_address', type: 'text', nullable: true, default: null })
  fullThreeTierAddress: string | null;

  @Column({ name: 'full_four_tier_address', type: 'text', nullable: true, default: null })
  fullFourTierAddress: string | null;

  // Danh sách sản phẩm trong đơn
  @Column({ name: 'items_json', type: 'json' })
  itemsJson: PosOrderLineItem[];

  @Column({ name: 'total_weight_grams', type: 'int', default: 500 })
  totalWeightGrams: number;

  // Hãng vận chuyển & Cước phí
  @Column({ name: 'carrier_code', type: 'varchar', length: 24, default: 'GHN' })
  carrierCode: 'GHN' | 'GHTK' | 'VTP' | 'JT' | 'COUNTER_PICKUP';

  @Column({ name: 'carrier_service_name', type: 'varchar', length: 120, default: 'Chuẩn Express' })
  carrierServiceName: string;

  @Column({ name: 'tracking_number', type: 'varchar', length: 64, nullable: true, default: null })
  trackingNumber: string | null;

  @Column({ name: 'shipping_fee_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  shippingFeeAmount: number;

  @Column({ name: 'is_free_shipping_for_customer', type: 'boolean', default: false })
  isFreeShippingForCustomer: boolean;

  // Tài chính đơn hàng
  @Column({ name: 'subtotal_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  subtotalAmount: number;

  @Column({ name: 'discount_percent', type: 'decimal', precision: 5, scale: 2, default: 0 })
  discountPercent: number;

  @Column({ name: 'discount_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  discountAmount: number;

  @Column({ name: 'loyalty_points_redeemed', type: 'int', default: 0 })
  loyaltyPointsRedeemed: number;

  @Column({
    name: 'wallet_credit_applied_amount',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  walletCreditAppliedAmount: number;

  @Column({ name: 'total_payable_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  totalPayableAmount: number;

  @Column({ name: 'deposit_required_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  depositRequiredAmount: number;

  @Column({ name: 'paid_transfer_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  paidTransferAmount: number;

  @Column({ name: 'cod_collect_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  codCollectAmount: number;

  /**
   * Tổng giá vốn và lợi nhuận ròng dự kiến (bảo vệ bởi FieldLevelSecurityInterceptor)
   */
  @Column({ name: 'cogs_snapshot_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  cogsSnapshotAmount: number;

  @Column({
    name: 'estimated_net_profit_amount',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  estimatedNetProfitAmount: number;

  @Column({
    name: 'payment_method',
    type: 'enum',
    enum: PosOrderPaymentMethodEnum,
    default: PosOrderPaymentMethodEnum.COD,
  })
  paymentMethod: PosOrderPaymentMethodEnum;

  @Column({
    name: 'payment_status',
    type: 'enum',
    enum: PosOrderPaymentStatusEnum,
    default: PosOrderPaymentStatusEnum.UNPAID,
  })
  paymentStatus: PosOrderPaymentStatusEnum;

  @Column({
    name: 'discount_approval_status',
    type: 'enum',
    enum: DiscountApprovalStatusEnum,
    default: DiscountApprovalStatusEnum.NOT_REQUIRED,
  })
  discountApprovalStatus: DiscountApprovalStatusEnum;

  @Column({ name: 'discount_approval_reason', type: 'text', nullable: true, default: null })
  discountApprovalReason: string | null;

  @Column({
    name: 'discount_approved_by_user_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  discountApprovedByUserId: string | null;

  @Column({ name: 'vietqr_payload_json', type: 'json', nullable: true, default: null })
  vietqrPayloadJson: VietQrEmvcoPayloadInfo | null;

  @Column({
    name: 'reservation_cart_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    default: null,
  })
  reservationCartId: string | null;

  @Column({ name: 'note', type: 'text', nullable: true, default: null })
  note: string | null;

  @Column({
    name: 'created_by_user_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  createdByUserId: string | null;
}
