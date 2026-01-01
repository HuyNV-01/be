import { StatusEnum, ValidRolesEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

@Entity('users')
@Index(['email', 'name'])
export class UserEntity extends BaseModel {
  @Column({ name: 'email', type: 'varchar', length: 255, unique: true })
  email: string;
  @Column({ name: 'password', type: 'varchar' })
  password: string;
  @Column({ name: 'name', type: 'varchar', length: 100 })
  name: string;
  @Column({
    name: 'role',
    type: 'varchar',
    length: 8,
    default: ValidRolesEnum.USER,
  })
  role: ValidRolesEnum;
  @Column({ name: 'status', type: 'smallint', default: StatusEnum.NOT_ACTIVE })
  status: StatusEnum;
  @Column({
    name: 'current_sign_in_at',
    type: 'datetime',
    default: null,
    nullable: true,
  })
  currentSignInAt: Date;
  @Column({
    name: 'last_sign_in_at',
    type: 'datetime',
    default: null,
    nullable: true,
  })
  lastSignInAt: Date;
  @Column({
    name: 'refresh_token',
    type: 'text',
    default: null,
    nullable: true,
  })
  refreshToken?: string | null;
  @Column({ name: 'provider', type: 'varchar', default: null, nullable: true })
  provider: string;
  @Column({ name: 'uid', type: 'varchar', default: null, nullable: true })
  uid: string;
}
