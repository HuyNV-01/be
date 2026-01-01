import { ContactStatusEnum, StatusEnum, ValidRolesEnum } from 'src/common/enum';
import { UserEntity } from 'src/entity/user.entity';

export interface ICreateUser {
  email: string;
  password: string;
  name: string;
  status?: StatusEnum;
  role?: ValidRolesEnum;
}

export interface IUpdateUser {
  name?: string;
  password?: string;
  email?: string;
  status?: StatusEnum;
  role?: ValidRolesEnum;
  currentSignInAt?: Date;
  lastSignInAt?: Date;
  refreshToken?: string | null;
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
