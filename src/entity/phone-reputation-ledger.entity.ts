import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export interface CarrierReputationCounterItem {
  deliveredCount: number;
  returnedCount: number;
  failedAttemptCount: number;
  reportedCount: number;
  lastEventAt: string | null;
}

export type CarrierReputationBreakdownMap = Record<string, CarrierReputationCounterItem>;

export interface ProcessedOrderReputationMarker {
  orderId: string;
  shopId: string;
  carrierCode: string;
  outcome: 'DELIVERED' | 'RETURNED' | 'FAILED_ATTEMPT';
  recordedAt: string;
}

/**
 * Sổ cái Uy tín Giao nhận SĐT Toàn Mạng Lưới (Cross-Shop Privacy-Preserving Consortium Ledger).
 * Định danh duy nhất bằng `phoneGlobalHash` (HMAC-SHA256 với global pepper) để không lưu SĐT thô
 * và loại bỏ hoàn toàn lỗi va chạm 10.000 SĐT của `phoneMasked`.
 */
@Entity('phone_reputation_ledgers')
@Index('uq_phone_reputation_global_hash', ['phoneGlobalHash'], { unique: true })
@Index('idx_phone_reputation_risk', ['totalReturnedCount', 'activeAbuseReportsCount'])
export class PhoneReputationLedgerEntity extends BaseModel {
  @Column({ name: 'phone_global_hash', type: 'varchar', length: 64 })
  phoneGlobalHash: string;

  @Column({ name: 'phone_masked_hint', type: 'varchar', length: 32, nullable: true, default: null })
  phoneMaskedHint: string | null;

  @Column({ name: 'total_delivered_count', type: 'int', default: 0 })
  totalDeliveredCount: number;

  @Column({ name: 'total_returned_count', type: 'int', default: 0 })
  totalReturnedCount: number;

  @Column({ name: 'total_failed_attempt_count', type: 'int', default: 0 })
  totalFailedAttemptCount: number;

  @Column({ name: 'active_abuse_reports_count', type: 'int', default: 0 })
  activeAbuseReportsCount: number;

  @Column({ name: 'verified_abuse_reports_count', type: 'int', default: 0 })
  verifiedAbuseReportsCount: number;

  @Column({ name: 'unique_shops_delivered_json', type: 'json', nullable: true, default: null })
  uniqueShopsDeliveredJson: string[] | null;

  @Column({ name: 'unique_shops_returned_json', type: 'json', nullable: true, default: null })
  uniqueShopsReturnedJson: string[] | null;

  @Column({ name: 'unique_shops_reported_json', type: 'json', nullable: true, default: null })
  uniqueShopsReportedJson: string[] | null;

  @Column({ name: 'carrier_breakdown_json', type: 'json', nullable: true, default: null })
  carrierBreakdownJson: CarrierReputationBreakdownMap | null;

  /**
   * Lưu vết idempotency theo `orderId` để mỗi đơn hàng chỉ cộng đúng 1 kết cục cuối cùng
   * (tránh đếm trùng khi Webhook 3PL gửi lặp hoặc khi chuyển DELIVERED -> DELIVERED_RECONCILED).
   */
  @Column({ name: 'processed_orders_json', type: 'json', nullable: true, default: null })
  processedOrdersJson: ProcessedOrderReputationMarker[] | null;

  @Column({ name: 'last_order_event_at', type: 'datetime', nullable: true, default: null })
  lastOrderEventAt: Date | null;

  @Column({ name: 'last_report_at', type: 'datetime', nullable: true, default: null })
  lastReportAt: Date | null;
}
