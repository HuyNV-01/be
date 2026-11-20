import {
  ChannelTypeEnum,
  DiscountApprovalStatusEnum,
  OmsCarrierSlaBreachTypeEnum,
  PosOrderPaymentMethodEnum,
  PosOrderPaymentStatusEnum,
  PosOrderStatusEnum,
  PosOrderTypeEnum,
} from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export interface BundleComponentRevenueAllocationItem {
  componentVariantId: string;
  componentSkuCode: string;
  componentName: string;
  quantityDeducted: number;
  retailWeightRatio: number;
  allocatedRevenueAmount: number;
  allocatedCogsAmount: number;
}

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
  bundleComponentAllocations?: BundleComponentRevenueAllocationItem[];
  /**
   * Sprint 5: Số lượng đã quét barcode xác nhận tại bàn đóng gói
   */
  packedScannedQty?: number;
  requiresSerialImei?: boolean;
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

export interface PackingBoxDimensionsInfo {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

@Entity('pos_orders')
@Index('uq_pos_order_shop_code', ['shopId', 'orderCode'], { unique: true })
@Index('idx_pos_order_shop_status', ['shopId', 'status', 'createdAt'])
@Index('idx_pos_order_shop_customer', ['shopId', 'customerId', 'status'])
@Index('idx_pos_order_shop_conv', ['shopId', 'conversationId'])
@Index('idx_pos_order_shop_tracking', ['shopId', 'trackingNumber'])
@Index('idx_pos_order_shop_sla', ['shopId', 'slaBreachType', 'status'])
export class PosOrderEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'order_code', type: 'varchar', length: 48 })
  orderCode: string;

  @Column({
    name: 'order_type',
    type: 'enum',
    enum: PosOrderTypeEnum,
    default: PosOrderTypeEnum.STANDARD,
  })
  orderType: PosOrderTypeEnum;

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

  @Column({ name: 'customer_phone_masked', type: 'varchar', length: 32, default: '' })
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

  @Column({ name: 'items_json', type: 'json' })
  itemsJson: PosOrderLineItem[];

  @Column({ name: 'total_weight_grams', type: 'int', default: 500 })
  totalWeightGrams: number;

  // Sprint 5: Trọng lượng cân thực tế tại bàn đóng gói & trọng lượng hãng vận chuyển tính cước
  @Column({ name: 'actual_packed_weight_grams', type: 'int', nullable: true, default: null })
  actualPackedWeightGrams: number | null;

  @Column({ name: 'carrier_charged_weight_grams', type: 'int', nullable: true, default: null })
  carrierChargedWeightGrams: number | null;

  @Column({ name: 'packing_box_dimensions_json', type: 'json', nullable: true, default: null })
  packingBoxDimensionsJson: PackingBoxDimensionsInfo | null;

  @Column({ name: 'carrier_code', type: 'varchar', length: 24, default: 'GHN' })
  carrierCode: 'GHN' | 'GHTK' | 'VTP' | 'JT' | 'COUNTER_PICKUP';

  @Column({ name: 'carrier_service_name', type: 'varchar', length: 120, default: 'Chuẩn Express' })
  carrierServiceName: string;

  @Column({ name: 'tracking_number', type: 'varchar', length: 64, nullable: true, default: null })
  trackingNumber: string | null;

  @Column({ name: 'shipping_fee_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  shippingFeeAmount: number;

  @Column({
    name: 'shipping_fee_carrier_estimated',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  shippingFeeCarrierEstimated: number;

  @Column({
    name: 'shipping_fee_carrier_actual',
    type: 'decimal',
    precision: 15,
    scale: 2,
    nullable: true,
    default: null,
  })
  shippingFeeCarrierActual: number | null;

  @Column({ name: 'is_free_shipping_for_customer', type: 'boolean', default: false })
  isFreeShippingForCustomer: boolean;

  @Column({ name: 'is_two_way_exchange', type: 'boolean', default: false })
  isTwoWayExchange: boolean;

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

  // Sprint 5: Đóng gói Barcode, In phiếu nhiệt & Camera bằng chứng (F07.3)
  @Column({ name: 'printed_count', type: 'int', default: 0 })
  printedCount: number;

  @Column({ name: 'last_printed_at', type: 'timestamp', nullable: true, default: null })
  lastPrintedAt: Date | null;

  @Column({ name: 'packed_by_user_id', type: 'varchar', length: 36, nullable: true, default: null })
  packedByUserId: string | null;

  @Column({ name: 'packed_at', type: 'timestamp', nullable: true, default: null })
  packedAt: Date | null;

  @Column({ name: 'packing_video_url', type: 'text', nullable: true, default: null })
  packingVideoUrl: string | null;

  @Column({ name: 'handed_to_carrier_at', type: 'timestamp', nullable: true, default: null })
  handedToCarrierAt: Date | null;

  @Column({ name: 'delivered_at', type: 'timestamp', nullable: true, default: null })
  deliveredAt: Date | null;

  // Sprint 5: Trung tâm Cứu đơn Giao thất bại & SLA Watchdog (F07.4 & F07.8)
  @Column({ name: 'delivery_fail_count', type: 'int', default: 0 })
  deliveryFailCount: number;

  @Column({ name: 'last_delivery_fail_reason', type: 'text', nullable: true, default: null })
  lastDeliveryFailReason: string | null;

  @Column({ name: 'shipper_name', type: 'varchar', length: 120, nullable: true, default: null })
  shipperName: string | null;

  @Column({ name: 'shipper_phone', type: 'varchar', length: 32, nullable: true, default: null })
  shipperPhone: string | null;

  @Column({ name: 'rescue_deadline_at', type: 'timestamp', nullable: true, default: null })
  rescueDeadlineAt: Date | null;

  @Column({ name: 'last_carrier_event_at', type: 'timestamp', nullable: true, default: null })
  lastCarrierEventAt: Date | null;

  @Column({
    name: 'sla_breach_type',
    type: 'enum',
    enum: OmsCarrierSlaBreachTypeEnum,
    default: OmsCarrierSlaBreachTypeEnum.NONE,
  })
  slaBreachType: OmsCarrierSlaBreachTypeEnum;

  @Column({
    name: 'carrier_ticket_code',
    type: 'varchar',
    length: 64,
    nullable: true,
    default: null,
  })
  carrierTicketCode: string | null;

  // Sprint 5: Đối soát COD & Chốt sổ (F07.6)
  @Column({
    name: 'reconciled_batch_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  reconciledBatchId: string | null;

  @Column({ name: 'reconciled_at', type: 'timestamp', nullable: true, default: null })
  reconciledAt: Date | null;

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
