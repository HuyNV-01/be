import { ContactStatusEnum, MessageTypeEnum, StatusEnum, ValidRolesEnum } from 'src/common/enum';
import { UserEntity } from 'src/entity/user.entity';

export type ProfileAccessLevel = 'SELF' | 'FRIEND' | 'STRANGER';

export interface IUserPrivacySettings {
  showEmail?: boolean;
  showPhone?: boolean;
  showAlias?: boolean;
  showOnlineStatus?: boolean;
  showSharedMedia?: boolean;
}

export interface IProfileSharedAsset {
  messageId: string;
  fileId: string;
  url: string;
  thumbnailUrl?: string;
  fileName: string;
  mimeType: string;
  size: number;
  type: MessageTypeEnum;
  senderId: string;
  senderName: string;
  createdAt: string;
}

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
  bio?: string | null;
  phone?: string | null;
  privacySettings?: IUserPrivacySettings | null;
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

export interface IUserProfile extends Partial<UserEntity> {
  bio?: string | null;
  coverImage?: string | null;
  avatar?: string | null;
  phone?: string | null;
  address?: string;
  alias?: string | null;
  isOnline?: boolean;
  joinDate?: string;
  friendCount?: number;
  commonGroups?: number;
  relationship: ContactStatusEnum | null;
  accessLevel?: ProfileAccessLevel;
  isMe?: boolean;
  isBlocked?: boolean;
  blockedByMe?: boolean;
  blockedByTarget?: boolean;
  privacySettings?: IUserPrivacySettings;
  sharedMedia?: IProfileSharedAsset[];
  sharedFiles?: IProfileSharedAsset[];
}
