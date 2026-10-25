import { ContactStatusEnum, StatusEnum, ValidRolesEnum } from 'src/common/enum';
import { UserEntity } from 'src/entity/user.entity';

export interface ICreateUser {
  email: string;
  password: string;
  name: string;
  status?: StatusEnum;
  role?: ValidRolesEnum;
  provider?: string;
  uid?: string | null;
  emailVerifiedAt?: Date | null;
}

export interface IUpdateUser {
  name?: string;
  password?: string;
  email?: string;
  status?: StatusEnum;
  role?: ValidRolesEnum;
  provider?: string;
  uid?: string | null;
  currentSignInAt?: Date | null;
  lastSignInAt?: Date | null;
  lastSignInIp?: string | null;
  refreshToken?: string | null;
  emailVerifiedAt?: Date | null;
  passwordChangedAt?: Date | null;
  failedLoginAttempts?: number;
  lockedUntil?: Date | null;
}

export interface IUserProfile extends UserEntity {
  bio?: string;
  coverImage?: string;
  phone?: string;
  address?: string;
  joinDate: string;
  friendCount: number;
  commonGroups: number;
  relationship: ContactStatusEnum | null;
  isBlocked?: boolean;
}
