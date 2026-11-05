import { ChannelTypeEnum } from 'src/common/enum/permission.enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

@Entity('channel_webhook_logs')
@Index('idx_channel_webhook_logs_id_lookup', ['id'])
@Index('idx_webhook_dedupe_lookup', ['shopId', 'channelType', 'idempotencyKey'])
@Index('idx_webhook_status_created', ['shopId', 'processingStatus', 'createdAt'])
export class ChannelWebhookLogEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36, nullable: true, default: null })
  shopId: string | null;

  @Column({
    name: 'channel_integration_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  channelIntegrationId: string | null;

  @Column({
    name: 'channel_type',
    type: 'enum',
    enum: ChannelTypeEnum,
    default: ChannelTypeEnum.FACEBOOK_PAGE,
  })
  channelType: ChannelTypeEnum;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 160 })
  idempotencyKey: string;

  @Column({ name: 'event_type', type: 'varchar', length: 100 })
  eventType: string;

  @Column({ name: 'headers_json', type: 'json' })
  headersJson: Record<string, string>;

  @Column({ name: 'raw_payload_json', type: 'json' })
  rawPayloadJson: Record<string, unknown>;

  @Column({
    name: 'processing_status',
    type: 'enum',
    enum: ['RECEIVED', 'PROCESSED', 'DUPLICATE_SKIPPED', 'FAILED_DLQ', 'REPLAYED_SUCCESS'],
    default: 'RECEIVED',
  })
  processingStatus:
    | 'RECEIVED'
    | 'PROCESSED'
    | 'DUPLICATE_SKIPPED'
    | 'FAILED_DLQ'
    | 'REPLAYED_SUCCESS';

  @Column({ name: 'processing_duration_ms', type: 'int', default: 0 })
  processingDurationMs: number;

  @Column({ name: 'error_stack', type: 'text', nullable: true, default: null })
  errorStack: string | null;

  @Column({ name: 'replayed_count', type: 'int', default: 0 })
  replayedCount: number;
}
