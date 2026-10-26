import { NotificationResourceTypeEnum, NotificationTypeEnum } from 'src/common/enum';
import { NotificationMetadata } from 'src/entity/notification.entity';

export enum NotificationEventEnum {
  DISPATCH = 'notification.dispatch',
  MARK_CONVERSATION_READ = 'notification.conversation.read',
}

export interface CreateNotificationPayload {
  recipientIds: string[];
  actorId?: string | null;
  type: NotificationTypeEnum;
  title: string;
  content: string;
  resourceType?: NotificationResourceTypeEnum;
  resourceId?: string | null;
  dedupeKey?: string | null;
  metadata?: NotificationMetadata | null;
}

export class NotificationDispatchEvent {
  constructor(public readonly payload: CreateNotificationPayload) {}
}

export class NotificationConversationReadEvent {
  constructor(
    public readonly userId: string,
    public readonly conversationId: string,
  ) {}
}
