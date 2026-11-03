export enum StatusEnum {
  NOT_ACTIVE = 0,
  ACTIVE = 1,
}

export enum ValidRolesEnum {
  ADMIN = 'ADMIN',
  STAFF = 'STAFF',
  USER = 'USER',
}

export enum ConversationTypeEnum {
  DIRECT = 'DIRECT',
  GROUP = 'GROUP',
}

export enum GroupRoleEnum {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
}

export enum MessageTypeEnum {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  FILE = 'FILE',
  AUDIO = 'AUDIO',
  VIDEO = 'VIDEO',
  CALL = 'CALL',
  POLL = 'POLL',
  SYSTEM = 'SYSTEM',
}

export enum CallTypeEnum {
  AUDIO = 'AUDIO',
  VIDEO = 'VIDEO',
}

export enum CallStatusEnum {
  RINGING = 'RINGING',
  ONGOING = 'ONGOING',
  COMPLETED = 'COMPLETED',
  MISSED = 'MISSED',
  REJECTED = 'REJECTED',
  BUSY = 'BUSY',
  CANCELLED = 'CANCELLED',
}

export enum ContactStatusEnum {
  PENDING_SENT = 'PENDING_SENT',
  PENDING_RECEIVED = 'PENDING_RECEIVED',
  FRIEND = 'FRIEND',
  BLOCKED = 'BLOCKED',
}

export enum FileProviderEnum {
  LOCAL = 'LOCAL',
  SEAWEEDFS = 'SEAWEEDFS',
  S3 = 'S3',
  R2 = 'R2',
}

export enum MediaTypeEnum {
  USER_AVATAR = 'USER_AVATAR',
  USER_COVER = 'USER_COVER',
  MESSAGE_ATTACHMENT = 'MESSAGE_ATTACHMENT',
  POST_IMAGE = 'POST_IMAGE',
}

export enum SortTypeEnum {
  ASC = 'ASC',
  DESC = 'DESC',
}

export enum MessageStatusEnum {
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
  REMOVED = 'removed',
}

export enum NotificationTypeEnum {
  NEW_MESSAGE = 'NEW_MESSAGE',
  MESSAGE_REPLY = 'MESSAGE_REPLY',
  MESSAGE_MENTION = 'MESSAGE_MENTION',
  MESSAGE_REACTION = 'MESSAGE_REACTION',
  MESSAGE_PINNED = 'MESSAGE_PINNED',
  FRIEND_REQUEST = 'FRIEND_REQUEST',
  FRIEND_ACCEPTED = 'FRIEND_ACCEPTED',
  GROUP_INVITE = 'GROUP_INVITE',
  GROUP_MEMBER_ADDED = 'GROUP_MEMBER_ADDED',
  MISSED_CALL = 'MISSED_CALL',
  SYSTEM = 'SYSTEM',
}

export enum NotificationResourceTypeEnum {
  CONVERSATION = 'CONVERSATION',
  MESSAGE = 'MESSAGE',
  CONTACT = 'CONTACT',
  CALL = 'CALL',
  USER = 'USER',
  SYSTEM = 'SYSTEM',
}
