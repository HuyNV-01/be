import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export interface CarrierBreakdownCounterMap {
  [carrierCode: string]: {
    deliveredCount: number;
    returnedCount: number;
    failedCount: number;
    lastEventAt: string | null;
  };
}

/**
 * Materialized cross-shop reputation summary per globalPhoneHash.
 * Enables O(1) indexed lookups (< 5ms) during high-concurrency chat ingestion
 * without scanning the full delivery event ledger on every incoming message.
 */
@Entity('phone_trust_global_aggregates')
@Index('uq_trust_agg_global_phone_hash', ['globalPhoneHash'], { unique: true })
export class PhoneTrustGlobalAggregateEntity extends BaseModel {
  @Column({ name: 'global_phone_hash', type: 'varchar', length: 64, unique: true })
  globalPhoneHash: string;

  @Column({ name: 'phone_masked', type: 'varchar', length: 32 })
  phoneMasked: string;

  @Column({ name: 'consortium_delivered_count', type: 'int', default: 0 })
  consortiumDeliveredCount: number;

  @Column({ name: 'consortium_returned_count', type: 'int', default: 0 })
  consortiumReturnedCount: number;

  @Column({ name: 'consortium_failed_count', type: 'int', default: 0 })
  consortiumFailedCount: number;

  @Column({ name: 'consortium_active_report_count', type: 'int', default: 0 })
  consortiumActiveReportCount: number;

  @Column({ name: 'consortium_verified_report_count', type: 'int', default: 0 })
  consortiumVerifiedReportCount: number;

  @Column({ name: 'distinct_reporting_shops_count', type: 'int', default: 0 })
  distinctReportingShopsCount: number;

  @Column({ name: 'carrier_breakdown_json', type: 'json', nullable: true, default: null })
  carrierBreakdownJson: CarrierBreakdownCounterMap | null;

  @Column({ name: 'last_event_at', type: 'datetime', nullable: true, default: null })
  lastEventAt: Date | null;
}
