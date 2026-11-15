import { AdsConversionEventNameEnum, AdsConversionPlatformEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export type AdsConversionSyncStatusType =
  | 'DISPATCHED_LIVE'
  | 'SIMULATED_SANDBOX'
  | 'QUEUED_RETRY'
  | 'FAILED';

@Entity('ads_conversion_event_logs')
@Index('idx_capi_log_shop_created', ['shopId', 'createdAt'])
@Index('idx_capi_log_shop_conv', ['shopId', 'conversationId'])
@Index('idx_capi_log_event_id', ['shopId', 'eventId'])
export class AdsConversionEventLogEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({
    name: 'channel_integration_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  channelIntegrationId: string | null;

  @Column({ name: 'conversation_id', type: 'varchar', length: 36, nullable: true, default: null })
  conversationId: string | null;

  @Column({ name: 'customer_id', type: 'varchar', length: 36, nullable: true, default: null })
  customerId: string | null;

  @Column({ name: 'order_id', type: 'varchar', length: 64, nullable: true, default: null })
  orderId: string | null;

  @Column({
    name: 'platform',
    type: 'enum',
    enum: AdsConversionPlatformEnum,
    default: AdsConversionPlatformEnum.META_CAPI,
  })
  platform: AdsConversionPlatformEnum;

  @Column({
    name: 'event_name',
    type: 'enum',
    enum: AdsConversionEventNameEnum,
    default: AdsConversionEventNameEnum.LEAD_SUBMITTED,
  })
  eventName: AdsConversionEventNameEnum;

  @Column({ name: 'event_id', type: 'varchar', length: 128 })
  eventId: string;

  @Column({ name: 'ctwa_click_id', type: 'text', nullable: true, default: null })
  ctwaClickId: string | null;

  @Column({ name: 'source_ad_id', type: 'varchar', length: 191, nullable: true, default: null })
  sourceAdId: string | null;

  @Column({ name: 'source_post_id', type: 'varchar', length: 191, nullable: true, default: null })
  sourcePostId: string | null;

  @Column({
    name: 'value_amount',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  valueAmount: number;

  @Column({ name: 'currency', type: 'varchar', length: 12, default: 'VND' })
  currency: string;

  @Column({ name: 'test_event_code', type: 'varchar', length: 64, nullable: true, default: null })
  testEventCode: string | null;

  @Column({ name: 'sync_status', type: 'varchar', length: 32, default: 'DISPATCHED_LIVE' })
  syncStatus: AdsConversionSyncStatusType;

  @Column({ name: 'request_payload_json', type: 'json', nullable: true, default: null })
  requestPayloadJson: Record<string, unknown> | null;

  @Column({ name: 'response_status', type: 'int', default: 200 })
  responseStatus: number;

  @Column({ name: 'response_body_json', type: 'json', nullable: true, default: null })
  responseBodyJson: Record<string, unknown> | null;

  @Column({ name: 'retry_count', type: 'int', default: 0 })
  retryCount: number;

  @Column({ name: 'synced_at', type: 'datetime', nullable: true, default: null })
  syncedAt: Date | null;
}
