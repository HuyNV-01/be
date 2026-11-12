import { Exclude } from 'class-transformer';
import { StatusEnum, ValidRolesEnum } from 'src/common/enum';
import { IUserPrivacySettings } from 'src/interface/user.interface';
import { Column, Entity, Index, ValueTransformer } from 'typeorm';

import { BaseModel } from './base-model';

const emailNormalizationTransformer: ValueTransformer = {
  to(this: void, value?: string): string | undefined {
    return typeof value === 'string' ? value.trim().toLowerCase() : value;
  },
  from(this: void, value?: string): string | undefined {
    return value;
  },
};

export const DEFAULT_USER_PRIVACY_SETTINGS: IUserPrivacySettings = {
  showEmail: true,
  showPhone: true,
  showAlias: true,
  showOnlineStatus: true,
  showSharedMedia: true,
};

@Entity('users')
@Index(['email', 'name'])
@Index(['provider', 'uid'])
export class UserEntity extends BaseModel {
  @Column({
    name: 'email',
    type: 'varchar',
    length: 255,
    unique: true,
    transformer: emailNormalizationTransformer,
  })
  email: string;

  @Exclude()
  @Column({ name: 'password', type: 'varchar', length: 255, select: false })
  password: string;

  @Column({ name: 'name', type: 'varchar', length: 150 })
  name: string;

  @Column({
    name: 'bio',
    type: 'text',
    default: null,
    nullable: true,
  })
  bio?: string | null;

  @Column({
    name: 'phone',
    type: 'varchar',
    length: 32,
    default: null,
    nullable: true,
  })
  phone?: string | null;

  @Column({
    name: 'privacy_settings',
    type: 'json',
    nullable: true,
  })
  privacySettings?: IUserPrivacySettings | null;

  @Column({
    name: 'role',
    type: 'varchar',
    length: 16,
    default: ValidRolesEnum.USER,
  })
  role: ValidRolesEnum;

  @Column({
    name: 'last_active_shop_id',
    type: 'varchar',
    length: 36,
    default: null,
    nullable: true,
  })
  lastActiveShopId?: string | null;

  @Column({ name: 'status', type: 'smallint', default: StatusEnum.NOT_ACTIVE })
  status: StatusEnum;

  @Column({
    name: 'current_sign_in_at',
    type: 'datetime',
    default: null,
    nullable: true,
  })
  currentSignInAt: Date | null;

  @Column({
    name: 'last_sign_in_at',
    type: 'datetime',
    default: null,
    nullable: true,
  })
  lastSignInAt: Date | null;

  @Column({
    name: 'last_sign_in_ip',
    type: 'varchar',
    length: 64,
    default: null,
    nullable: true,
  })
  lastSignInIp?: string | null;

  @Exclude()
  @Column({
    name: 'refresh_token',
    type: 'text',
    default: null,
    nullable: true,
    select: false,
  })
  refreshToken?: string | null;

  @Column({ name: 'provider', type: 'varchar', length: 64, default: 'local', nullable: true })
  provider: string;

  @Column({ name: 'uid', type: 'varchar', length: 255, default: null, nullable: true })
  uid: string | null;

  @Column({ name: 'email_verified_at', type: 'datetime', default: null, nullable: true })
  emailVerifiedAt?: Date | null;

  @Column({ name: 'password_changed_at', type: 'datetime', default: null, nullable: true })
  passwordChangedAt?: Date | null;

  @Column({ name: 'failed_login_attempts', type: 'int', default: 0 })
  failedLoginAttempts: number;

  @Column({ name: 'locked_until', type: 'datetime', default: null, nullable: true })
  lockedUntil?: Date | null;
}
