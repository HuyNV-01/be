/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { HttpStatus } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConnectedSocket, MessageBody, SubscribeMessage } from '@nestjs/websockets';

import { AppGateway } from 'src/common/decorators/app-gateway.decorator';
import { MessageStatusEnum } from 'src/common/enum';
import { SocketStateService } from 'src/common/websocket/socket-state.service';
import { ChatEventEnum, ChatMessageReadEvent } from 'src/config/websocket/events/chat.events';
import {
  ContactEventEnum,
  ContactRemovedEvent,
  ContactRequestAcceptedEvent,
  ContactRequestSentEvent,
} from 'src/config/websocket/events/contact.events';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { SendMessageDto } from 'src/dto/chat/chat.dto';
import type { AuthenticatedSocket } from 'src/interface/auth-socket.interface';

import { BaseGateway, PresenceGateway } from '../../common/websocket/base.gateway';
import { ChatService } from './chat.service';

@AppGateway(SOCKET_CONFIG.namespaces.CHAT)
export class ChatGateway extends BaseGateway implements PresenceGateway {
  constructor(
    socketStateService: SocketStateService,
    private readonly chatService: ChatService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(socketStateService, ChatGateway.name);
  }

  async handleUserOnline(userId: string) {
    const recipientIds = await this.chatService.getRelatedUserIds(userId);
    this.broadcastStatus(userId, true, recipientIds);
    this.syncUndeliveredMessages(userId);
  }

  async handleUserOffline(userId: string) {
    const recipientIds = await this.chatService.getRelatedUserIds(userId);
    this.broadcastStatus(userId, false, recipientIds);
  }

  private broadcastStatus(userId: string, isOnline: boolean, recipients: string[]) {
    const payload = { userId, isOnline, lastActive: new Date() };
    recipients.forEach((id) => this.emitToUser(id, SOCKET_CONFIG.events.USER_STATUS, payload));
  }

  @SubscribeMessage('join_room')
  async handleJoinRoom(
    @MessageBody('conversationId') conversationId: string,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.logger.debug(`User ${client.data.user.id} joined conversation ${conversationId}`);
    await client.join(`conversation:${conversationId}`);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
    };
  }

  @SubscribeMessage('leave_room')
  async handleLeaveRoom(
    @MessageBody('conversationId') conversationId: string,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    await client.leave(`conversation:${conversationId}`);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
    };
  }

  @SubscribeMessage('send_message')
  async handleSendMessage(
    @MessageBody() dto: SendMessageDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    const label = '[handleSendMessage]';
    this.logger.debug(`${label} userID -> ${client.data.user.id}`);
    const { message, recipientIds } = await this.chatService.sendMessage({
      senderId: client.data.user.id,
      dto,
    });

    this.server.to(`conversation:${dto.conversationId}`).emit('new_message', message);

    recipientIds.forEach((userId) => {
      if (userId !== client.data.user.id) {
        this.server.to(`user:${userId}`).emit('new_message', message);
      }
    });

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: message,
    };
  }

  @SubscribeMessage('message_received')
  async handleMessageReceived(
    @MessageBody() payload: { conversationId: string; messageId: string },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    try {
      const userId = client.data.user.id;

      await this.chatService.markAsDelivered({
        userId,
        messageId: payload.messageId,
      });

      const updatePayload = {
        id: payload.messageId,
        conversationId: payload.conversationId,
        status: MessageStatusEnum.DELIVERED,
        userId: userId,
        timestamp: new Date().toISOString(),
      };

      this.server
        .to(`conversation:${payload.conversationId}`)
        .emit('message_status_update', updatePayload);

      return { status: HttpStatus.OK };
    } catch (error) {
      this.logger.error(`Error Message Received: ${error}`);
    }
  }

  @SubscribeMessage('ack_pending_messages')
  async handleAckPendingMessages(@ConnectedSocket() client: AuthenticatedSocket) {
    const userId = client.data.user.id;
    this.logger.debug(`[AckPending] User ${userId} requested sync via Inbox`);

    await this.syncUndeliveredMessages(userId);

    return { status: HttpStatus.OK };
  }

  @OnEvent(ChatEventEnum.MESSAGE_READ)
  handleInternalMessageRead(event: ChatMessageReadEvent) {
    this.server.to(`conversation:${event.conversationId}`).emit('message_read', {
      conversationId: event.conversationId,
      userId: event.userId,
      user: event.user,
      lastReadAt: event.lastReadAt.toISOString(),
    });
  }

  @SubscribeMessage('mark_read')
  async handleMarkRead(
    @MessageBody() payload: { conversationId: string },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    await this.chatService.markConversationAsRead({
      userId: client.data.user.id,
      conversationId: payload.conversationId,
    });
  }

  @SubscribeMessage('typing')
  handleTyping(
    @MessageBody() payload: { conversationId: string; isTyping: boolean },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    client.to(`conversation:${payload.conversationId}`).emit('user_typing', {
      userId: client.data.user.id,
      conversationId: payload.conversationId,
      isTyping: payload.isTyping,
    });
  }

  @OnEvent(ContactEventEnum.REQUEST_SENT)
  handleContactRequestSent(event: ContactRequestSentEvent) {
    this.logger.log(`[Event] Request sent from ${event.senderId} to ${event.targetUserId}`);

    this.server
      .to(`user:${event.targetUserId}`)
      .emit(SOCKET_CONFIG.events.CONTACT.REQUEST_RECEIVED, {
        senderId: event.senderId,
        timestamp: event.timestamp,
      });
  }

  @OnEvent(ContactEventEnum.REQUEST_ACCEPTED)
  handleContactRequestAccepted(event: ContactRequestAcceptedEvent) {
    this.logger.log(`[Event] Request accepted by ${event.accepterId}`);

    this.server
      .to(`user:${event.requesterId}`)
      .emit(SOCKET_CONFIG.events.CONTACT.REQUEST_ACCEPTED, {
        accepterId: event.accepterId,
        timestamp: event.timestamp,
      });
  }

  @OnEvent(ContactEventEnum.FRIEND_REMOVED)
  handleContactRemoved(event: ContactRemovedEvent) {
    this.server.to(`user:${event.targetId}`).emit(SOCKET_CONFIG.events.CONTACT.FRIEND_REMOVED, {
      removerId: event.removerId,
      timestamp: event.timestamp,
    });
  }

  private async syncUndeliveredMessages(userId: string) {
    try {
      const groupedMessages = await this.chatService.processUndeliveredMessages(userId);
      const conversationIds = Object.keys(groupedMessages);

      if (conversationIds.length === 0) return;

      conversationIds.forEach((convId) => {
        const messageIds = groupedMessages[convId];

        const batchPayload = {
          conversationId: convId,
          messageIds: messageIds,
          status: MessageStatusEnum.DELIVERED,
          userId: userId,
          updatedAt: new Date().toISOString(),
        };

        this.server.to(`conversation:${convId}`).emit('message_status_update_batch', batchPayload);
      });

      this.logger.log(`Synced batch messages for user ${userId}`);
    } catch (error) {
      this.logger.error(`Error syncing: ${error}`);
    }
  }
}
