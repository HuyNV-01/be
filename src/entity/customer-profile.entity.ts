import { ChannelTypeEnum, CustomerTierEnum, RfmSegmentCodeEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export interface LinkedExternalIdentityItem {
  channelType: ChannelTypeEnum;
  channelIntegrationId: string | null;
  pageShortCode?: string | null;
  pageName?: string | null;
  externalUserId: string;
  externalUsername?: string | null;
  avatarUrl?: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface CustomerRecentOrderSnapshotItem {
  orderId: string;
  orderCode: string;
  channelType: ChannelTypeEnum;
  pageShortCode?: string | null;
  totalAmount: number;
  status: 'CONFIRMED' | 'SHIPPING' | 'DELIVERED_RECONCILED' | 'RETURNED' | 'CANCELLED';
  carrierCode?: string | null;
  trackingNumber?: string | null;
  createdAt: string;
}

@Entity('customer_profiles')
@Index('idx_crm_shop_code', ['shopId', 'code'], { unique: true })
@Index('idx_crm_shop_phone_hash', ['shopId', 'phoneSearchHash'])
@Index('idx_crm_shop_tier_rfm', ['shopId', 'tier', 'rfmSegmentCode'])
@Index('idx_crm_shop_trust_score', ['shopId', 'deliveryTrustScore', 'isBlacklisted'])
export class CustomerProfileEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'code', type: 'varchar', length: 40 })
  code: string;

  @Column({ name: 'full_name', type: 'varchar', length: 255 })
  fullName: string;

  @Column({ name: 'avatar_url', type: 'text', nullable: true, default: null })
  avatarUrl: string | null;

  @Column({ name: 'phone_masked', type: 'varchar', length: 32, nullable: true, default: null })
  phoneMasked: string | null;

  @Column({ name: 'phone_encrypted', type: 'text', nullable: true, default: null })
  phoneEncrypted: string | null;

  // Chỉ mục mù (Blind Index HMAC-SHA256) giúp tra cứu SĐT trùng đa kênh trong < 2ms mà không cần giải mã toàn bảng
  @Column({ name: 'phone_search_hash', type: 'varchar', length: 64, nullable: true, default: null })
  phoneSearchHash: string | null;

  @Column({ name: 'email', type: 'varchar', length: 255, nullable: true, default: null })
  email: string | null;

  @Column({
    name: 'default_province_code',
    type: 'varchar',
    length: 32,
    nullable: true,
    default: null,
  })
  defaultProvinceCode: string | null;

  @Column({
    name: 'default_province_name',
    type: 'varchar',
    length: 120,
    nullable: true,
    default: null,
  })
  defaultProvinceName: string | null;

  @Column({
    name: 'default_district_code',
    type: 'varchar',
    length: 32,
    nullable: true,
    default: null,
  })
  defaultDistrictCode: string | null;

  @Column({
    name: 'default_district_name',
    type: 'varchar',
    length: 120,
    nullable: true,
    default: null,
  })
  defaultDistrictName: string | null;

  @Column({
    name: 'default_ward_code',
    type: 'varchar',
    length: 32,
    nullable: true,
    default: null,
  })
  defaultWardCode: string | null;

  @Column({
    name: 'default_ward_name',
    type: 'varchar',
    length: 120,
    nullable: true,
    default: null,
  })
  defaultWardName: string | null;

  @Column({ name: 'default_address_line', type: 'text', nullable: true, default: null })
  defaultAddressLine: string | null;

  @Column({
    name: 'tier',
    type: 'enum',
    enum: CustomerTierEnum,
    default: CustomerTierEnum.NEW,
  })
  tier: CustomerTierEnum;

  @Column({ name: 'rfm_score_r', type: 'int', default: 1 })
  rfmScoreR: number;

  @Column({ name: 'rfm_score_f', type: 'int', default: 1 })
  rfmScoreF: number;

  @Column({ name: 'rfm_score_m', type: 'int', default: 1 })
  rfmScoreM: number;

  @Column({
    name: 'rfm_segment_code',
    type: 'enum',
    enum: RfmSegmentCodeEnum,
    default: RfmSegmentCodeEnum.NEW_CUSTOMERS,
  })
  rfmSegmentCode: RfmSegmentCodeEnum;

  @Column({ name: 'total_orders_count', type: 'int', default: 0 })
  totalOrdersCount: number;

  @Column({ name: 'successful_deliveries_count', type: 'int', default: 0 })
  successfulDeliveriesCount: number;

  @Column({ name: 'returned_orders_count', type: 'int', default: 0 })
  returnedOrdersCount: number;

  @Column({ name: 'delivery_trust_score', type: 'int', default: 80 })
  deliveryTrustScore: number;

  @Column({ name: 'is_blacklisted', type: 'boolean', default: false })
  isBlacklisted: boolean;

  @Column({ name: 'blacklist_reason', type: 'text', nullable: true, default: null })
  blacklistReason: string | null;

  @Column({
    name: 'lifetime_value_amount',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  lifetimeValueAmount: number;

  @Column({ name: 'loyalty_points_balance', type: 'int', default: 0 })
  loyaltyPointsBalance: number;

  @Column({
    name: 'wallet_credit_balance',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  walletCreditBalance: number;

  @Column({ name: 'height_cm', type: 'int', nullable: true, default: null })
  heightCm: number | null;

  @Column({ name: 'weight_kg', type: 'int', nullable: true, default: null })
  weightKg: number | null;

  @Column({ name: 'preferred_size', type: 'varchar', length: 32, nullable: true, default: null })
  preferredSize: string | null;

  @Column({ name: 'notes', type: 'text', nullable: true, default: null })
  notes: string | null;

  @Column({ name: 'linked_external_identities_json', type: 'json', nullable: true, default: null })
  linkedExternalIdentitiesJson: LinkedExternalIdentityItem[] | null;

  @Column({ name: 'active_tag_ids_json', type: 'json', nullable: true, default: null })
  activeTagIdsJson: string[] | null;

  @Column({ name: 'recent_orders_snapshot_json', type: 'json', nullable: true, default: null })
  recentOrdersSnapshotJson: CustomerRecentOrderSnapshotItem[] | null;

  @Column({ name: 'last_order_at', type: 'datetime', nullable: true, default: null })
  lastOrderAt: Date | null;
}
