import {
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import {
  BaseGateway,
  PresenceGateway,
} from '../../common/websocket/base.gateway';
import { ChatService } from './chat.service';
import { HttpStatus } from '@nestjs/common';
import { SocketStateService } from 'src/common/websocket/socket-state.service';
import type { AuthenticatedSocket } from 'src/interface/auth-socket.interface';
import { SendMessageDto } from 'src/dto/chat/chat.dto';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { AppGateway } from 'src/common/decorators/app-gateway.decorator';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ContactEventEnum,
  ContactRemovedEvent,
  ContactRequestAcceptedEvent,
  ContactRequestSentEvent,
} from 'src/config/websocket/events/contact.events';

@AppGateway(SOCKET_CONFIG.namespaces.CHAT)
export class ChatGateway extends BaseGateway implements PresenceGateway {
  constructor(
    socketStateService: SocketStateService,
    private readonly chatService: ChatService,
  ) {
    super(socketStateService, ChatGateway.name);
  }

  async handleUserOnline(userId: string) {
    const recipientIds = await this.chatService.getRelatedUserIds(userId);
    this.broadcastStatus(userId, true, recipientIds);
  }

  async handleUserOffline(userId: string) {
    const recipientIds = await this.chatService.getRelatedUserIds(userId);
    this.broadcastStatus(userId, false, recipientIds);
  }

  private broadcastStatus(
    userId: string,
    isOnline: boolean,
    recipients: string[],
  ) {
    const payload = { userId, isOnline, lastActive: new Date() };
    recipients.forEach((id) =>
      this.emitToUser(id, SOCKET_CONFIG.events.USER_STATUS, payload),
    );
  }

  @SubscribeMessage('join_room')
  async handleJoinRoom(
    @MessageBody('conversationId') conversationId: string,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.logger.debug(
      `User ${client.data.user.id} joined conversation ${conversationId}`,
    );
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

    this.server
      .to(`conversation:${dto.conversationId}`)
      .emit('new_message', message);

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
    this.logger.log(
      `[Event] Request sent from ${event.senderId} to ${event.targetUserId}`,
    );

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
    this.server
      .to(`user:${event.targetId}`)
      .emit(SOCKET_CONFIG.events.CONTACT.FRIEND_REMOVED, {
        removerId: event.removerId,
        timestamp: event.timestamp,
      });
  }
}
