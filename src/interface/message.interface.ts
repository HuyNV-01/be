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
  poll?: MessagePollMeta;
  linkPreview?: MessageLinkPreviewMeta;
  mentionedUserIds?: string[];
  mentionAll?: boolean;
  expiresAt?: string;
  disappearingTtl?: number;
}

export interface MessagePollOptionMeta {
  id: string;
  text: string;
  voterIds: string[];
}

export interface MessagePollMeta {
  question: string;
  options: MessagePollOptionMeta[];
  allowMultipleAnswers: boolean;
  isAnonymous?: boolean;
  isClosed: boolean;
  closedAt?: string;
  closedBy?: string;
}

export interface MessageLinkPreviewMeta {
  url: string;
  hostname: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

export interface AttachmentE2EEWrappedKey {
  ivB64: string;
  wrappedKeyB64: string;
}

export interface AttachmentE2EEMeta {
  algorithm: 'AES-256-GCM';
  fileIvB64: string;
  originalMimeType: string;
  senderUserId: string;
  senderPublicKeyB64: string;
  senderKeyId: string;
  wrappedKeys: Record<string, AttachmentE2EEWrappedKey>;
}

export interface MessageAttachmentMeta {
  fileId: string;
  url: string;
  thumbnailUrl?: string;
  fileName: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  e2ee?: AttachmentE2EEMeta;
}
