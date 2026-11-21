import {
  PhoneTrustAbuseReasonCodeEnum,
  PhoneTrustAbuseSeverityEnum,
  PhoneTrustReportStatusEnum,
  PhoneTrustVerificationLevelEnum,
} from 'src/common/enum/phone-trust.enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

/**
 * Multi-tenant buyer abuse / boom-hang report ledger with anti-spam deduplication
 * and retraction audit trail to prevent malicious sellers from falsely bombing numbers.
 */
@Entity('phone_trust_abuse_reports')
@Index('idx_trust_report_global_status', ['globalPhoneHash', 'status'])
@Index('idx_trust_report_shop_hash', ['sourceShopId', 'globalPhoneHash'])
@Index('uq_trust_report_shop_dedup', ['sourceShopId', 'globalPhoneHash', 'dedupFingerprint'], {
  unique: true,
})
export class PhoneTrustAbuseReportEntity extends BaseModel {
  @Column({ name: 'global_phone_hash', type: 'varchar', length: 64 })
  globalPhoneHash: string;

  @Column({ name: 'phone_masked', type: 'varchar', length: 32 })
  phoneMasked: string;

  @Column({ name: 'source_shop_id', type: 'varchar', length: 36 })
  sourceShopId: string;

  @Column({
    name: 'source_customer_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  sourceCustomerId: string | null;

  @Column({ name: 'reported_by_user_id', type: 'varchar', length: 36 })
  reportedByUserId: string;

  @Column({ name: 'reported_by_name', type: 'varchar', length: 160 })
  reportedByName: string;

  @Column({ name: 'dedup_fingerprint', type: 'varchar', length: 64 })
  dedupFingerprint: string;

  @Column({
    name: 'reason_code',
    type: 'enum',
    enum: PhoneTrustAbuseReasonCodeEnum,
    default: PhoneTrustAbuseReasonCodeEnum.BOM_HANG,
  })
  reasonCode: PhoneTrustAbuseReasonCodeEnum;

  @Column({ name: 'reason_note', type: 'text' })
  reasonNote: string;

  @Column({ name: 'carrier_code', type: 'varchar', length: 32, nullable: true, default: null })
  carrierCode: string | null;

  @Column({ name: 'order_code', type: 'varchar', length: 80, nullable: true, default: null })
  orderCode: string | null;

  @Column({ name: 'tracking_number', type: 'varchar', length: 80, nullable: true, default: null })
  trackingNumber: string | null;

  @Column({
    name: 'severity',
    type: 'enum',
    enum: PhoneTrustAbuseSeverityEnum,
    default: PhoneTrustAbuseSeverityEnum.HIGH,
  })
  severity: PhoneTrustAbuseSeverityEnum;

  @Column({
    name: 'verification_level',
    type: 'enum',
    enum: PhoneTrustVerificationLevelEnum,
    default: PhoneTrustVerificationLevelEnum.SHOP_DECLARED,
  })
  verificationLevel: PhoneTrustVerificationLevelEnum;

  @Column({ name: 'is_carrier_verified', type: 'boolean', default: false })
  isCarrierVerified: boolean;

  @Column({ name: 'evidence_url', type: 'text', nullable: true, default: null })
  evidenceUrl: string | null;

  @Column({ name: 'share_with_consortium', type: 'boolean', default: true })
  shareWithConsortium: boolean;

  @Column({
    name: 'status',
    type: 'enum',
    enum: PhoneTrustReportStatusEnum,
    default: PhoneTrustReportStatusEnum.ACTIVE,
  })
  status: PhoneTrustReportStatusEnum;

  @Column({ name: 'retracted_at', type: 'datetime', nullable: true, default: null })
  retractedAt: Date | null;

  @Column({
    name: 'retracted_by_user_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  retractedByUserId: string | null;

  @Column({ name: 'retract_reason', type: 'text', nullable: true, default: null })
  retractReason: string | null;
}
