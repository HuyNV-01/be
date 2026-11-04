import {
  DataScopeEnum,
  InvitationStatusEnum,
  PermissionCodeEnum,
  ShopRoleEnum,
} from 'src/common/enum/permission.enum';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseModel } from './base-model';
import { ShopWorkspaceEntity } from './shop-workspace.entity';
import { UserEntity } from './user.entity';

@Entity('shop_invitations')
@Index('idx_shop_invite_email_status', ['invitedEmail', 'status'])
@Index('uq_shop_invite_token_hash', ['tokenHash'], { unique: true })
@Index('idx_shop_invite_shop_status', ['shopId', 'status'])
export class ShopInvitationEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @ManyToOne(() => ShopWorkspaceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'shop_id' })
  shop: ShopWorkspaceEntity;

  @Column({ name: 'invited_by_user_id', type: 'varchar', length: 36 })
  invitedByUserId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'invited_by_user_id' })
  invitedByUser: UserEntity;

  @Column({ name: 'invited_email', type: 'varchar', length: 255 })
  invitedEmail: string;

  @Column({ name: 'invited_name', type: 'varchar', length: 120, nullable: true, default: null })
  invitedName: string | null;

  @Column({
    name: 'target_role',
    type: 'enum',
    enum: ShopRoleEnum,
    default: ShopRoleEnum.SALE_AGENT,
  })
  targetRole: ShopRoleEnum;

  @Column({
    name: 'target_data_scope',
    type: 'enum',
    enum: DataScopeEnum,
    default: DataScopeEnum.ASSIGNED_PLUS_POOL,
  })
  targetDataScope: DataScopeEnum;

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

  @Column({ name: 'allowed_channel_ids_json', type: 'json' })
  allowedChannelIdsJson: string[];

  @Column({ name: 'allowed_warehouse_ids_json', type: 'json' })
  allowedWarehouseIdsJson: string[];

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: InvitationStatusEnum,
    default: InvitationStatusEnum.PENDING,
  })
  status: InvitationStatusEnum;

  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt: Date;

  @Column({
    name: 'accepted_by_user_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    default: null,
  })
  acceptedByUserId: string | null;

  @Column({ name: 'accepted_at', type: 'datetime', nullable: true, default: null })
  acceptedAt: Date | null;
}
