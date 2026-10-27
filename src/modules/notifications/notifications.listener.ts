/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { NotificationResourceTypeEnum, NotificationTypeEnum } from 'src/common/enum';
import {
  ContactEventEnum,
  ContactRequestAcceptedEvent,
  ContactRequestSentEvent,
} from 'src/config/websocket/events/contact.events';
import {
  NotificationConversationReadEvent,
  NotificationDispatchEvent,
  NotificationEventEnum,
} from 'src/config/websocket/events/notification.events';

import { UserService } from '../user/user.service';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationsListener {
  private readonly logger = new Logger(NotificationsListener.name, {
    timestamp: true,
  });

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly userService: UserService,
  ) {}

  @OnEvent(NotificationEventEnum.DISPATCH, { async: true })
  async handleGenericDispatch(event: NotificationDispatchEvent): Promise<void> {
    await this.notificationsService.createAndDispatch(event.payload);
  }

  @OnEvent(NotificationEventEnum.MARK_CONVERSATION_READ, { async: true })
  async handleConversationRead(event: NotificationConversationReadEvent): Promise<void> {
    await this.notificationsService.markConversationNotificationsAsRead(
      event.userId,
      event.conversationId,
    );
  }

  @OnEvent(ContactEventEnum.REQUEST_SENT, { async: true })
  async handleFriendRequestSent(event: ContactRequestSentEvent): Promise<void> {
    try {
      const users = await this.userService.getBasicUsersInfo([event.senderId]);
      const sender = users[0] as any;
      const senderName = sender?.name || 'User';

      await this.notificationsService.createAndDispatch({
        recipientIds: [event.targetUserId],
        actorId: event.senderId,
        type: NotificationTypeEnum.FRIEND_REQUEST,
        title: 'Lời mời kết bạn mới',
        content: `${senderName} đã gửi cho bạn một lời mời kết bạn.`,
        resourceType: NotificationResourceTypeEnum.CONTACT,
        resourceId: event.senderId,
        dedupeKey: `friend_req:${event.senderId}:${event.targetUserId}`,
        metadata: {
          actionUrl: '/contacts/directory?tab=PENDING_RECEIVED',
          titleKey: 'i18n.friendRequest.title',
          contentKey: 'i18n.friendRequest.content',
          i18nParams: {
            senderName,
          },
        },
      });
    } catch (err) {
      this.logger.error(`Error handling friend request notification: ${String(err)}`);
    }
  }

  @OnEvent(ContactEventEnum.REQUEST_ACCEPTED, { async: true })
  async handleFriendRequestAccepted(event: ContactRequestAcceptedEvent): Promise<void> {
    try {
      const users = await this.userService.getBasicUsersInfo([event.accepterId]);
      const accepter = users[0] as any;
      const accepterName = accepter?.name || 'User';

      await this.notificationsService.createAndDispatch({
        recipientIds: [event.requesterId],
        actorId: event.accepterId,
        type: NotificationTypeEnum.FRIEND_ACCEPTED,
        title: 'Đã kết bạn',
        content: `${accepterName} đã chấp nhận lời mời kết bạn của bạn.`,
        resourceType: NotificationResourceTypeEnum.USER,
        resourceId: event.accepterId,
        dedupeKey: `friend_acc:${event.accepterId}:${event.requesterId}`,
        metadata: {
          actionUrl: `/profile/${event.accepterId}`,
          titleKey: 'i18n.friendAccepted.title',
          contentKey: 'i18n.friendAccepted.content',
          i18nParams: {
            accepterName,
          },
        },
      });
    } catch (err) {
      this.logger.error(`Error handling friend accepted notification: ${String(err)}`);
    }
  }
}
