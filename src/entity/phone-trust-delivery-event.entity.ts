import { PhoneTrustEventOutcomeEnum, PhoneTrustVerificationLevelEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

/**
 * Immutable ledger of verified delivery and return outcomes across all shops and 3PL webhooks.
 * Keyed by globalPhoneHash so cross-shop aggregation never exposes raw buyer phone numbers.
 */
@Entity('phone_trust_delivery_events')
@Index('uq_trust_event_idempotency', ['sourceProvider', 'externalEventKey'], { unique: true })
@Index('idx_trust_event_global_hash_outcome', ['globalPhoneHash', 'eventOutcome'])
@Index('idx_trust_event_shop_hash', ['sourceShopId', 'globalPhoneHash'])
@Index('idx_trust_event_tracking', ['carrierCode', 'trackingNumber'])
export class PhoneTrustDeliveryEventEntity extends BaseModel {
  @Column({ name: 'global_phone_hash', type: 'varchar', length: 64 })
  globalPhoneHash: string;

  @Column({ name: 'phone_masked', type: 'varchar', length: 32 })
  phoneMasked: string;

  @Column({ name: 'source_shop_id', type: 'varchar', length: 36, nullable: true, default: null })
  sourceShopId: string | null;

  @Column({ name: 'source_provider', type: 'varchar', length: 48 })
  sourceProvider: string;

  @Column({ name: 'external_event_key', type: 'varchar', length: 160 })
  externalEventKey: string;

  @Column({ name: 'carrier_code', type: 'varchar', length: 32, nullable: true, default: null })
  carrierCode: string | null;

  @Column({ name: 'tracking_number', type: 'varchar', length: 80, nullable: true, default: null })
  trackingNumber: string | null;

  @Column({ name: 'order_code', type: 'varchar', length: 80, nullable: true, default: null })
  orderCode: string | null;

  @Column({
    name: 'event_outcome',
    type: 'enum',
    enum: PhoneTrustEventOutcomeEnum,
  })
  eventOutcome: PhoneTrustEventOutcomeEnum;

  @Column({
    name: 'verification_level',
    type: 'enum',
    enum: PhoneTrustVerificationLevelEnum,
    default: PhoneTrustVerificationLevelEnum.ORDER_LINKED,
  })
  verificationLevel: PhoneTrustVerificationLevelEnum;

  @Column({ name: 'share_with_consortium', type: 'boolean', default: true })
  shareWithConsortium: boolean;

  @Column({ name: 'cod_amount', type: 'decimal', precision: 15, scale: 2, default: 0 })
  codAmount: number;

  @Column({
    name: 'carrier_raw_status',
    type: 'varchar',
    length: 80,
    nullable: true,
    default: null,
  })
  carrierRawStatus: string | null;

  @Column({ name: 'carrier_reason_note', type: 'text', nullable: true, default: null })
  carrierReasonNote: string | null;

  @Column({ name: 'occurred_at', type: 'datetime' })
  occurredAt: Date;
}
