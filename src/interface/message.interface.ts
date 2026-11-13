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
  e2ee?: AttachmentE2EEMeta;
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
  callDirection?: 'INTERNAL_WEBRTC' | 'OUTBOUND_SIP_PSTN' | 'INBOUND_SIP_PSTN';
  maskedPhoneDisplay?: string | null;
  recordingFileId?: string | null;
  recordingFileUrl?: string | null;
  callDispositionTag?: string | null;
  callNotes?: string | null;
  waveformPeaks?: number[];
}

export interface MessageProductCardMeta {
  skuCode: string;
  name: string;
  retailPrice: number;
  imageUrl?: string | null;
  availableQty?: number;
}

export interface MessageTranslationMeta {
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  translatedAt: string;
}

export type CommentReplyModeType =
  | 'REPLY_COMMENT_ONLY'
  | 'SEND_PRIVATE_REPLY_ONLY'
  | 'REPLY_COMMENT_AND_PRIVATE_INBOX';

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
  forwardedFrom?: {
    messageId: string;
    senderId: string;
    senderName: string;
  };
  reactions?: Record<string, string[]>;
  attachments?: MessageAttachmentMeta[];
  callInfo?: MessageCallInfoMeta;
  poll?: MessagePollMeta;
  linkPreview?: MessageLinkPreviewMeta;
  mentionedUserIds?: string[];
  mentionAll?: boolean;
  expiresAt?: string;
  disappearingTtl?: number;
  isInternalNote?: boolean;
  quickReplyShortcutUsed?: string;
  productCards?: MessageProductCardMeta[];
  translation?: MessageTranslationMeta;
  externalCustomerName?: string;
  externalCustomerAvatar?: string | null;
  externalCustomerPsid?: string | null;
  skipPlatformDispatch?: boolean;
  marketplaceOrder?: Record<string, any>;
  externalCommentId?: string;
  externalPostId?: string;
  parentCommentId?: string | null;
  isHiddenOnPlatform?: boolean;
  hiddenByAgentId?: string;
  hiddenAt?: string;
  isLikedByPage?: boolean;
  likedByAgentId?: string;
  isDeletedOnPlatform?: boolean;
  deletedOnPlatformAt?: string;
  deletedByActor?: 'CUSTOMER' | 'AGENT';
  deletedByAgentId?: string | null;
  originalTextBeforePlatformEdit?: string;
  privateReplySentAt?: string;
  privateReplyByAgentId?: string;
  linkedInboxConversationId?: string;
  commentReplyMode?: CommentReplyModeType;
  autoHideCommentOnReply?: boolean;
  platformDeliveryStatus?: 'DISPATCHED' | 'SIMULATED_SANDBOX' | 'FAILED';
  platformExternalId?: string | null;
  platformEditedExternalId?: string | null;
  platformEditSyncedAt?: string;
  platformErrorMessage?: string | null;
  buyerDeliveredAt?: string | null;
  buyerReadAt?: string | null;
  platformSeenSyncedAt?: string | null;
  viewerReadBy?: Array<{
    id: string;
    name: string;
    avatar: string | null;
    readAt: string;
  }>;
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
