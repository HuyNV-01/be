import { CallStatusEnum, CallTypeEnum, MessageTypeEnum } from 'src/common/enum';

export interface MessageAttachmentMeta {
  fileId: string;
  url: string;
  thumbnailUrl?: string;
  fileName: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}

export interface MessageReplyPreview {
  messageId: string;
  senderId: string;
  senderName?: string;
  content: string;
  type: MessageTypeEnum;
}

export interface MessageCallInfoMeta {
  callId: string;
  callType: CallTypeEnum;
  status: CallStatusEnum;
  durationSeconds?: number;
  initiatorId: string;
  participantIds: string[];
  startedAt?: string;
  endedAt?: string;
}

export interface MessageMetadata {
  fileName?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  isEncrypted?: boolean;
  encryptionAlg?: 'AES-256-GCM';
  isE2EE?: boolean;
  e2eeKeyId?: string;
  senderPublicKey?: string;
  isEdited?: boolean;
  editedAt?: string;
  isPinned?: boolean;
  pinnedBy?: string;
  pinnedAt?: string;
  replyToMessageId?: string;
  replyPreview?: MessageReplyPreview;
  reactions?: Record<string, string[]>;
  attachments?: MessageAttachmentMeta[];
  callInfo?: MessageCallInfoMeta;
  expiresAt?: string;
  disappearingTtl?: number;
}
