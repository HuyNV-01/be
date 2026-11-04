import { RoutingStrategyEnum } from 'src/common/enum/permission.enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export interface CommissionSplitConfig {
  leadCollectorWeight: number;
  orderCloserWeight: number;
  deductOnReturnedOrder: boolean;
}

export interface MarketplaceSyncConfig {
  autoReserveStockOnMarketplaceOrder: boolean;
  safetyBufferStockQty: number;
  pushAvailableStockToShopeeTikTok: boolean;
}

@Entity('shop_workspaces')
@Index('idx_shop_workspace_code', ['code'], { unique: true })
@Index('uq_shop_workspace_join_code', ['joinCode'], { unique: true })
@Index('idx_shop_workspace_owner', ['ownerId'])
export class ShopWorkspaceEntity extends BaseModel {
  @Column({ name: 'code', type: 'varchar', length: 32, unique: true })
  code: string;

  @Column({ name: 'join_code', type: 'varchar', length: 16, unique: true })
  joinCode: string;

  @Column({ name: 'name', type: 'varchar', length: 150 })
  name: string;

  @Column({ name: 'logo_url', type: 'varchar', length: 500, nullable: true, default: null })
  logoUrl: string | null;

  @Column({ name: 'owner_id', type: 'varchar', length: 36 })
  ownerId: string;

  @Column({ name: 'default_currency', type: 'varchar', length: 8, default: 'VND' })
  defaultCurrency: string;

  @Column({ name: 'timezone', type: 'varchar', length: 64, default: 'Asia/Ho_Chi_Minh' })
  timezone: string;

  @Column({ name: 'sla_response_seconds', type: 'int', default: 180 })
  slaResponseSeconds: number;

  @Column({ name: 'ghosted_alert_seconds', type: 'int', default: 180 })
  ghostedAlertSeconds: number;

  @Column({ name: 'auto_reclaim_minutes', type: 'int', default: 5 })
  autoReclaimMinutes: number;

  @Column({
    name: 'routing_strategy',
    type: 'enum',
    enum: RoutingStrategyEnum,
    default: RoutingStrategyEnum.STICKY_AGENT,
  })
  routingStrategy: RoutingStrategyEnum;

  @Column({ name: 'lock_order_after_print', type: 'boolean', default: true })
  lockOrderAfterPrint: boolean;

  @Column({ name: 'require_deposit_on_high_risk', type: 'boolean', default: true })
  requireDepositOnHighRisk: boolean;

  @Column({ name: 'commission_split_config_json', type: 'json' })
  commissionSplitConfigJson: CommissionSplitConfig;

  @Column({ name: 'marketplace_sync_config_json', type: 'json' })
  marketplaceSyncConfigJson: MarketplaceSyncConfig;
}
