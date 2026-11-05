import {
  DataScopeEnum,
  MembershipStatusEnum,
  PermissionCodeEnum,
  ShiftStatusEnum,
  ShopRoleEnum,
} from 'src/common/enum/permission.enum';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseModel } from './base-model';
import { ShopWorkspaceEntity } from './shop-workspace.entity';
import { UserEntity } from './user.entity';

export interface SavedPageGroupPreset {
  presetId: string;
  name: string;
  channelIntegrationIds: string[];
  isDefault?: boolean;
}

@Entity('shop_members')
@Index('uq_shop_member_shop_user', ['shopId', 'userId'], { unique: true })
@Index('idx_shop_member_shift_routing', ['shopId', 'membershipStatus', 'shiftStatus', 'role'])
export class ShopMemberEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @ManyToOne(() => ShopWorkspaceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'shop_id' })
  shop: ShopWorkspaceEntity;

  @Column({ name: 'user_id', type: 'varchar', length: 36 })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({
    name: 'role',
    type: 'enum',
    enum: ShopRoleEnum,
    default: ShopRoleEnum.SALE_AGENT,
  })
  role: ShopRoleEnum;

  @Column({
    name: 'membership_status',
    type: 'enum',
    enum: MembershipStatusEnum,
    default: MembershipStatusEnum.PENDING_APPROVAL,
  })
  membershipStatus: MembershipStatusEnum;

  @Column({
    name: 'data_scope',
    type: 'enum',
    enum: DataScopeEnum,
    default: DataScopeEnum.ASSIGNED_PLUS_POOL,
  })
  dataScope: DataScopeEnum;

  @Column({
    name: 'shift_status',
    type: 'enum',
    enum: ShiftStatusEnum,
    default: ShiftStatusEnum.OFFLINE,
  })
  shiftStatus: ShiftStatusEnum;

  @Column({ name: 'team_code', type: 'varchar', length: 64, nullable: true, default: null })
  teamCode: string | null;

  @Column({ name: 'max_concurrent_chats', type: 'int', default: 25 })
  maxConcurrentChats: number;

  @Column({
    name: 'max_discount_percent',
    type: 'decimal',
    precision: 5,
    scale: 2,
    default: 5.0,
  })
  maxDiscountPercent: number;

  @Column({ name: 'unmask_phone_hourly_limit', type: 'int', default: 15 })
  unmaskPhoneHourlyLimit: number;

  @Column({ name: 'granted_permissions_json', type: 'json' })
  grantedPermissionsJson: PermissionCodeEnum[];

  @Column({ name: 'revoked_permissions_json', type: 'json' })
  revokedPermissionsJson: PermissionCodeEnum[];

  @Column({ name: 'allowed_channel_ids_json', type: 'json' })
  allowedChannelIdsJson: string[];

  @Column({ name: 'allowed_warehouse_ids_json', type: 'json' })
  allowedWarehouseIdsJson: string[];

  @Column({ name: 'saved_page_group_presets_json', type: 'json' })
  savedPageGroupPresetsJson: SavedPageGroupPreset[];

  @Column({
    name: 'requested_join_note',
    type: 'varchar',
    length: 300,
    nullable: true,
    default: null,
  })
  requestedJoinNote: string | null;

  @Column({ name: 'last_shift_changed_at', type: 'datetime', nullable: true, default: null })
  lastShiftChangedAt: Date | null;
}
