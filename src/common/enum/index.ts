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

export enum MessageTypeEnum {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  FILE = 'FILE',
  SYSTEM = 'SYSTEM',
}

export enum ContactStatusEnum {
  PENDING_SENT = 'PENDING_SENT',
  PENDING_RECEIVED = 'PENDING_RECEIVED',
  FRIEND = 'FRIEND',
  BLOCKED = 'BLOCKED',
}

export enum FileProviderEnum {
  MINIO = 'MINIO',
  S3 = 'S3',
  LOCAL = 'LOCAL',
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
