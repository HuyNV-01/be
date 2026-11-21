import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export type CommunityAbuseReportStatusType = 'ACTIVE' | 'RETRACTED' | 'DISPUTED';

export type CommunityAbuseReportVerificationType =
  | 'CARRIER_VERIFIED'
  | 'ORDER_LINKED'
  | 'SHOP_DECLARED';

@Entity('community_phone_abuse_reports')
@Index('idx_comm_abuse_global_hash_status', ['phoneGlobalHash', 'status', 'createdAt'])
@Index('idx_comm_abuse_shop_hash', ['reporterShopId', 'phoneGlobalHash'])
@Index('uq_comm_abuse_dedupe', ['phoneGlobalHash', 'reporterShopId', 'dedupeKey'], { unique: true })
export class CommunityPhoneAbuseReportEntity extends BaseModel {
  @Column({ name: 'phone_global_hash', type: 'varchar', length: 64 })
  phoneGlobalHash: string;

  @Column({ name: 'phone_masked_hint', type: 'varchar', length: 32, nullable: true, default: null })
  phoneMaskedHint: string | null;

  @Column({ name: 'reporter_shop_id', type: 'varchar', length: 36 })
  reporterShopId: string;

  @Column({ name: 'reporter_shop_alias', type: 'varchar', length: 120 })
  reporterShopAlias: string;

  @Column({ name: 'reporter_user_id', type: 'varchar', length: 36 })
  reporterUserId: string;

  @Column({ name: 'customer_id', type: 'varchar', length: 36, nullable: true, default: null })
  customerId: string | null;

  @Column({ name: 'dedupe_key', type: 'varchar', length: 96 })
  dedupeKey: string;

  @Column({ name: 'reason_code', type: 'varchar', length: 48, default: 'BOM_HANG' })
  reasonCode: string;

  @Column({ name: 'reason_note', type: 'text' })
  reasonNote: string;

  @Column({ name: 'source_code', type: 'varchar', length: 48, default: 'SHOP_INTERNAL' })
  sourceCode: string;

  @Column({ name: 'carrier_code', type: 'varchar', length: 32, nullable: true, default: null })
  carrierCode: string | null;

  @Column({ name: 'order_code', type: 'varchar', length: 64, nullable: true, default: null })
  orderCode: string | null;

  @Column({ name: 'tracking_number', type: 'varchar', length: 64, nullable: true, default: null })
  trackingNumber: string | null;

  @Column({
    name: 'verification_level',
    type: 'varchar',
    length: 32,
    default: 'SHOP_DECLARED',
  })
  verificationLevel: CommunityAbuseReportVerificationType;

  @Column({ name: 'severity', type: 'varchar', length: 16, default: 'HIGH' })
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  @Column({ name: 'status', type: 'varchar', length: 16, default: 'ACTIVE' })
  status: CommunityAbuseReportStatusType;

  @Column({
    name: 'retracted_by_user_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  retractedByUserId: string | null;

  @Column({ name: 'retracted_reason', type: 'text', nullable: true, default: null })
  retractedReason: string | null;

  @Column({ name: 'retracted_at', type: 'datetime', nullable: true, default: null })
  retractedAt: Date | null;
}
