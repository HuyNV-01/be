import { HttpStatus } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { ConnectedSocket, MessageBody, SubscribeMessage, WsException } from '@nestjs/websockets';

import { AppGateway } from 'src/common/decorators/app-gateway.decorator';
import { MessageStatusEnum } from 'src/common/enum';
import { BaseGateway, PresenceGateway } from 'src/common/websocket/base.gateway';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SocketRateLimiter } from 'src/common/websocket/socket-rate-limiter';
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
import {
  EditMessageDto,
  InitiateCallDto,
  PinMessageDto,
  ReactMessageDto,
  RecallMessageDto,
  RegisterPublicKeyDto,
  RespondCallDto,
  ToggleCallMediaDto,
  WebRtcSignalDto,
} from 'src/dto/chat/call-and-security.dto';
import { SendMessageDto } from 'src/dto/chat/chat.dto';
import type { AuthenticatedSocket } from 'src/interface/auth-socket.interface';

import { ChatService } from './chat.service';
import { CallSignalingService } from './services/call-signaling.service';

@AppGateway(SOCKET_CONFIG.namespaces.CHAT)
export class ChatGateway extends BaseGateway implements PresenceGateway {
  constructor(
    socketStateService: SocketStateService,
    realtimeEmitter: RealtimeEmitterService,
    rateLimiter: SocketRateLimiter,
    jwtService: JwtService,
    private readonly chatService: ChatService,
    private readonly callSignalingService: CallSignalingService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(
      socketStateService,
      ChatGateway.name,
      SOCKET_CONFIG.namespaces.CHAT,
      realtimeEmitter,
      rateLimiter,
      jwtService,
    );
  }

  async handleUserOnline(userId: string): Promise<void> {
    const recipientIds = await this.chatService.getRelatedUserIds(userId);
    this.broadcastStatus(userId, true, recipientIds);
    await this.syncUndeliveredMessages(userId);
  }

  async handleUserOffline(userId: string): Promise<void> {
    const recipientIds = await this.chatService.getRelatedUserIds(userId);
    this.broadcastStatus(userId, false, recipientIds);

    try {
      const activeCallId = await this.callSignalingService.getActiveCallIdByUser(userId);
      if (activeCallId) {
        const outcome = await this.callSignalingService.rejectOrLeaveCall({
          callId: activeCallId,
          userId,
          reason: 'hangup',
        });

        if (outcome.session) {
          if (outcome.isCallTerminated) {
            const endPayload = {
              callId: activeCallId,
              endedBy: userId,
              finalStatus: outcome.finalStatus,
              durationSeconds: outcome.durationSeconds,
            };
            this.server
              .to(`call:${activeCallId}`)
              .emit(SOCKET_CONFIG.events.CALL.ENDED, endPayload);

            const allCallMembers = [outcome.session.initiatorId, ...outcome.session.invitedUserIds];
            allCallMembers.forEach((uid) => {
              this.emitToUser(uid, SOCKET_CONFIG.events.CALL.ENDED, endPayload);
            });

            const callLog = await this.chatService.recordCallHistoryMessage({
              conversationId: outcome.session.conversationId,
              initiatorId: outcome.session.initiatorId,
              callId: outcome.session.callId,
              callType: outcome.session.callType,
              status: outcome.finalStatus,
              durationSeconds: outcome.durationSeconds,
              participantIds: allCallMembers,
            });
            this.server
              .to(`conversation:${outcome.session.conversationId}`)
              .emit(SOCKET_CONFIG.events.CHAT.NEW_MESSAGE, callLog);
          } else {
            this.server
              .to(`call:${activeCallId}`)
              .emit(SOCKET_CONFIG.events.CALL.PARTICIPANT_LEFT, {
                callId: activeCallId,
                userId,
                remainingParticipants: outcome.session.participants,
              });
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error cleaning up call on user offline: ${msg}`);
    }
  }

  private broadcastStatus(userId: string, isOnline: boolean, recipients: string[]): void {
    const payload = { userId, isOnline, lastActive: new Date() };
    recipients.forEach((id) => this.emitToUser(id, SOCKET_CONFIG.events.USER_STATUS, payload));
  }

  @SubscribeMessage('join_room')
  async handleJoinRoom(
    @MessageBody('conversationId') conversationId: string,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.enforceRateLimit(client, 'join_room');
    const userId = client.data.user.id;

    const isMember = await this.chatService.isParticipant(conversationId, userId);
    if (!isMember) {
      throw new WsException('Forbidden: You are not a member of this conversation');
    }

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
    this.enforceRateLimit(client, 'send_message');
    const senderId = client.data.user.id;

    const { message, recipientIds, isDuplicate } = await this.chatService.sendMessage({
      senderId,
      dto,
    });

    if (!isDuplicate) {
      const uniqueTargets = new Set([senderId, ...recipientIds]);
      uniqueTargets.forEach((userId) => {
        this.server.to(`user:${userId}`).emit(SOCKET_CONFIG.events.CHAT.NEW_MESSAGE, message);
      });
    }

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: message,
    };
  }

  @SubscribeMessage('edit_message')
  async handleEditMessage(
    @MessageBody() dto: EditMessageDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.enforceRateLimit(client, 'edit_message');
    const { message, recipientIds } = await this.chatService.editMessage({
      userId: client.data.user.id,
      dto,
    });

    this.server
      .to(`conversation:${dto.conversationId}`)
      .emit(SOCKET_CONFIG.events.CHAT.MESSAGE_EDITED, message);

    recipientIds.forEach((uid) => {
      this.server.to(`user:${uid}`).emit(SOCKET_CONFIG.events.CHAT.MESSAGE_EDITED, message);
    });

    return {
      status: HttpStatus.OK,
      data: message,
    };
  }

  @SubscribeMessage('recall_message')
  async handleRecallMessage(
    @MessageBody() dto: RecallMessageDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.enforceRateLimit(client, 'recall_message');
    const result = await this.chatService.recallMessage({
      userId: client.data.user.id,
      dto,
    });

    this.server
      .to(`conversation:${dto.conversationId}`)
      .emit(SOCKET_CONFIG.events.CHAT.MESSAGE_RECALLED, result);

    result.recipientIds.forEach((uid) => {
      this.server.to(`user:${uid}`).emit(SOCKET_CONFIG.events.CHAT.MESSAGE_RECALLED, result);
    });

    return {
      status: HttpStatus.OK,
      data: result,
    };
  }

  @SubscribeMessage('react_message')
  async handleReactMessage(
    @MessageBody() dto: ReactMessageDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.enforceRateLimit(client, 'react_message');
    const result = await this.chatService.toggleReaction({
      userId: client.data.user.id,
      dto,
    });

    this.server
      .to(`conversation:${dto.conversationId}`)
      .emit(SOCKET_CONFIG.events.CHAT.MESSAGE_REACTION, result);

    return {
      status: HttpStatus.OK,
      data: result,
    };
  }

  @SubscribeMessage('pin_message')
  async handlePinMessage(
    @MessageBody() dto: PinMessageDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.enforceRateLimit(client, 'pin_message');
    const result = await this.chatService.togglePinMessage({
      userId: client.data.user.id,
      dto,
    });

    this.server
      .to(`conversation:${dto.conversationId}`)
      .emit(SOCKET_CONFIG.events.CHAT.MESSAGE_PINNED, result);

    return {
      status: HttpStatus.OK,
      data: result,
    };
  }

  @SubscribeMessage('e2ee:register_key')
  async handleRegisterPublicKey(
    @MessageBody() dto: RegisterPublicKeyDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.enforceRateLimit(client, 'e2ee:register_key');
    const userId = client.data.user.id;
    const bundle = await this.chatService.registerE2EEPublicKey(userId, dto);

    const relatedUsers = await this.chatService.getRelatedUserIds(userId);
    relatedUsers.forEach((uid) => {
      this.emitToUser(uid, SOCKET_CONFIG.events.CHAT.E2EE_KEY_UPDATED, bundle);
    });

    return {
      status: HttpStatus.OK,
      data: bundle,
    };
  }

  @SubscribeMessage('call:initiate')
  async handleCallInitiate(
    @MessageBody() dto: InitiateCallDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.enforceRateLimit(client, 'call:initiate');
    const callerId = client.data.user.id;

    await this.chatService.ensureParticipant(dto.conversationId, callerId);
    const membersInfo = await this.chatService.getConversationMembersInfo(dto.conversationId);
    const memberIds = membersInfo.map((m) => m.id);
    const callerInfo = membersInfo.find((m) => m.id === callerId);

    const { session, busyUserIds, ringingUserIds, isJoinedExisting } =
      await this.callSignalingService.initiateCall({
        conversationId: dto.conversationId,
        initiatorId: callerId,
        memberIds,
        callType: dto.callType,
        isGroupCall: memberIds.length > 2,
      });

    await client.join(`call:${session.callId}`);

    if (isJoinedExisting) {
      this.server.to(`call:${session.callId}`).emit(SOCKET_CONFIG.events.CALL.PARTICIPANT_JOINED, {
        callId: session.callId,
        conversationId: session.conversationId,
        userId: callerId,
        userInfo: callerInfo,
        participants: session.participants,
        membersInfo,
      });
    } else {
      ringingUserIds.forEach((targetId) => {
        this.emitToUser(targetId, SOCKET_CONFIG.events.CALL.INCOMING, {
          callId: session.callId,
          conversationId: dto.conversationId,
          callType: dto.callType,
          isGroupCall: session.isGroupCall,
          callerId,
          callerName: callerInfo?.name || 'Người dùng',
          callerAvatar: callerInfo?.avatar || null,
          sdpOffer: dto.sdpOffer,
          createdAt: session.createdAt,
          participants: session.participants,
          membersInfo,
        });
      });

      // Tự động kết thúc cuộc gọi nếu sau 60s không ai bắt máy
      this.callSignalingService.scheduleRingingTimeout(session.callId, async (staleSession) => {
        const outcome = await this.callSignalingService.rejectOrLeaveCall({
          callId: staleSession.callId,
          userId: staleSession.initiatorId,
          reason: 'timeout',
        });

        const endPayload = {
          callId: staleSession.callId,
          endedBy: staleSession.initiatorId,
          finalStatus: outcome.finalStatus,
          durationSeconds: 0,
          reason: 'timeout',
        };

        this.server
          .to(`call:${staleSession.callId}`)
          .emit(SOCKET_CONFIG.events.CALL.ENDED, endPayload);

        const allUsers = [staleSession.initiatorId, ...staleSession.invitedUserIds];
        allUsers.forEach((uid) => {
          this.emitToUser(uid, SOCKET_CONFIG.events.CALL.ENDED, endPayload);
        });

        const callLog = await this.chatService.recordCallHistoryMessage({
          conversationId: staleSession.conversationId,
          initiatorId: staleSession.initiatorId,
          callId: staleSession.callId,
          callType: staleSession.callType,
          status: outcome.finalStatus,
          durationSeconds: 0,
          participantIds: allUsers,
        });

        this.server
          .to(`conversation:${staleSession.conversationId}`)
          .emit(SOCKET_CONFIG.events.CHAT.NEW_MESSAGE, callLog);
      });
    }

    return {
      status: HttpStatus.OK,
      data: {
        ...session,
        busyUserIds,
        ringingUserIds,
        isJoinedExisting,
        membersInfo,
        iceConfig: this.chatService.getWebRtcIceServers(callerId),
      },
    };
  }

  @SubscribeMessage('call:accept')
  async handleCallAccept(
    @MessageBody() dto: RespondCallDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.enforceRateLimit(client, 'call:accept');
    const userId = client.data.user.id;
    const session = await this.callSignalingService.acceptCall(dto.callId, userId);
    const membersInfo = await this.chatService.getConversationMembersInfo(session.conversationId);
    const userInfo = membersInfo.find((m) => m.id === userId);

    await client.join(`call:${session.callId}`);

    const acceptedPayload = {
      callId: session.callId,
      conversationId: session.conversationId,
      acceptedBy: userId,
      userInfo,
      participants: session.participants,
      membersInfo,
      answeredAt: session.answeredAt,
    };

    this.server
      .to(`call:${session.callId}`)
      .emit(SOCKET_CONFIG.events.CALL.ACCEPTED, acceptedPayload);
    this.emitToUser(session.initiatorId, SOCKET_CONFIG.events.CALL.ACCEPTED, acceptedPayload);

    // Thông báo cho tất cả thành viên đang trong cuộc gọi để tạo kết nối P2P Mesh với thành viên mới
    client.to(`call:${session.callId}`).emit(SOCKET_CONFIG.events.CALL.PARTICIPANT_JOINED, {
      callId: session.callId,
      conversationId: session.conversationId,
      userId,
      userInfo,
      participants: session.participants,
      membersInfo,
    });

    return {
      status: HttpStatus.OK,
      data: {
        session,
        membersInfo,
        iceConfig: this.chatService.getWebRtcIceServers(userId),
      },
    };
  }

  @SubscribeMessage('call:reject')
  async handleCallReject(
    @MessageBody() dto: RespondCallDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.enforceRateLimit(client, 'call:reject');
    const userId = client.data.user.id;
    const reason = dto.reason === 'busy' ? 'busy' : 'rejected';

    const outcome = await this.callSignalingService.rejectOrLeaveCall({
      callId: dto.callId,
      userId,
      reason,
    });

    if (outcome.session) {
      const rejectedPayload = {
        callId: dto.callId,
        rejectedBy: userId,
        reason,
        isCallTerminated: outcome.isCallTerminated,
      };

      this.server
        .to(`call:${dto.callId}`)
        .emit(SOCKET_CONFIG.events.CALL.REJECTED, rejectedPayload);
      this.emitToUser(
        outcome.session.initiatorId,
        SOCKET_CONFIG.events.CALL.REJECTED,
        rejectedPayload,
      );

      if (outcome.isCallTerminated) {
        const callLog = await this.chatService.recordCallHistoryMessage({
          conversationId: outcome.session.conversationId,
          initiatorId: outcome.session.initiatorId,
          callId: outcome.session.callId,
          callType: outcome.session.callType,
          status: outcome.finalStatus,
          durationSeconds: outcome.durationSeconds,
          participantIds: [outcome.session.initiatorId, ...outcome.session.invitedUserIds],
        });
        this.server
          .to(`conversation:${outcome.session.conversationId}`)
          .emit(SOCKET_CONFIG.events.CHAT.NEW_MESSAGE, callLog);
      }
    }

    return { status: HttpStatus.OK, data: outcome };
  }

  @SubscribeMessage('call:signal')
  async handleWebRtcSignal(
    @MessageBody() dto: WebRtcSignalDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.enforceRateLimit(client, 'call:signal');
    const senderId = client.data.user.id;
    const session = await this.callSignalingService.getCallSession(dto.callId);

    if (!session) {
      throw new WsException('Call session does not exist or has ended');
    }

    // Xác thực người gửi và người nhận đều thuộc cuộc gọi
    const allowedUsers = new Set([session.initiatorId, ...session.invitedUserIds]);
    if (!allowedUsers.has(senderId) || !allowedUsers.has(dto.targetUserId)) {
      throw new WsException('Forbidden: Unauthorized WebRTC signal target');
    }

    this.emitToUser(dto.targetUserId, SOCKET_CONFIG.events.CALL.SIGNAL, {
      callId: dto.callId,
      conversationId: session.conversationId,
      fromUserId: senderId,
      type: dto.type,
      signalData: dto.signalData,
    });

    return { status: HttpStatus.OK };
  }

  @SubscribeMessage('call:media_state')
  async handleCallMediaState(
    @MessageBody() dto: ToggleCallMediaDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.enforceRateLimit(client, 'call:media_state');
    const userId = client.data.user.id;
    const session = await this.callSignalingService.updateMediaState({
      callId: dto.callId,
      userId,
      isAudioMuted: dto.isAudioMuted,
      isVideoOff: dto.isVideoOff,
      isScreenSharing: dto.isScreenSharing,
    });

    this.server.to(`call:${dto.callId}`).emit(SOCKET_CONFIG.events.CALL.MEDIA_STATE, {
      callId: dto.callId,
      userId,
      callType: session.callType,
      participantState: session.participants[userId],
    });

    return { status: HttpStatus.OK, data: session.participants[userId] };
  }

  @SubscribeMessage('call:hangup')
  async handleCallHangup(
    @MessageBody() dto: RespondCallDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    this.enforceRateLimit(client, 'call:hangup');
    const userId = client.data.user.id;

    const outcome = await this.callSignalingService.rejectOrLeaveCall({
      callId: dto.callId,
      userId,
      reason: 'hangup',
    });

    await client.leave(`call:${dto.callId}`);

    if (outcome.session) {
      if (outcome.isCallTerminated) {
        const endedPayload = {
          callId: dto.callId,
          endedBy: userId,
          finalStatus: outcome.finalStatus,
          durationSeconds: outcome.durationSeconds,
        };

        this.server.to(`call:${dto.callId}`).emit(SOCKET_CONFIG.events.CALL.ENDED, endedPayload);

        const allCallUsers = [outcome.session.initiatorId, ...outcome.session.invitedUserIds];
        allCallUsers.forEach((uid) => {
          this.emitToUser(uid, SOCKET_CONFIG.events.CALL.ENDED, endedPayload);
        });

        const callLog = await this.chatService.recordCallHistoryMessage({
          conversationId: outcome.session.conversationId,
          initiatorId: outcome.session.initiatorId,
          callId: outcome.session.callId,
          callType: outcome.session.callType,
          status: outcome.finalStatus,
          durationSeconds: outcome.durationSeconds,
          participantIds: allCallUsers,
        });

        this.server
          .to(`conversation:${outcome.session.conversationId}`)
          .emit(SOCKET_CONFIG.events.CHAT.NEW_MESSAGE, callLog);
      } else {
        this.server.to(`call:${dto.callId}`).emit(SOCKET_CONFIG.events.CALL.PARTICIPANT_LEFT, {
          callId: dto.callId,
          userId,
          remainingParticipants: outcome.session.participants,
        });
      }
    }

    return { status: HttpStatus.OK, data: outcome };
  }

  @SubscribeMessage('message_received')
  async handleMessageReceived(
    @MessageBody() payload: { conversationId: string; messageId: string },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    try {
      this.enforceRateLimit(client, 'message_received');
      const userId = client.data.user.id;

      await this.chatService.markAsDelivered({
        userId,
        messageId: payload.messageId,
      });

      const updatePayload = {
        id: payload.messageId,
        conversationId: payload.conversationId,
        status: MessageStatusEnum.DELIVERED,
        userId,
        timestamp: new Date().toISOString(),
      };

      this.server
        .to(`conversation:${payload.conversationId}`)
        .emit(SOCKET_CONFIG.events.CHAT.MESSAGE_STATUS_UPDATE, updatePayload);

      return { status: HttpStatus.OK };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error Message Received: ${msg}`);
    }
  }

  @SubscribeMessage('ack_pending_messages')
  async handleAckPendingMessages(@ConnectedSocket() client: AuthenticatedSocket) {
    const userId = client.data.user.id;
    await this.syncUndeliveredMessages(userId);
    return { status: HttpStatus.OK };
  }

  @OnEvent(ChatEventEnum.MESSAGE_READ)
  handleInternalMessageRead(event: ChatMessageReadEvent): void {
    const payload = {
      conversationId: event.conversationId,
      userId: event.userId,
      user: event.user,
      lastReadAt: event.lastReadAt.toISOString(),
    };
    this.server
      .to(`conversation:${event.conversationId}`)
      .emit(SOCKET_CONFIG.events.CHAT.MESSAGE_READ, payload);
    this.emitToUser(event.userId, SOCKET_CONFIG.events.CHAT.MESSAGE_READ, payload);
  }

  @SubscribeMessage('mark_read')
  async handleMarkRead(
    @MessageBody() payload: { conversationId: string },
    @ConnectedSocket() client: AuthenticatedSocket,
  ): Promise<void> {
    this.enforceRateLimit(client, 'mark_read');
    await this.chatService.markConversationAsRead({
      userId: client.data.user.id,
      conversationId: payload.conversationId,
    });
  }

  @SubscribeMessage('typing')
  async handleTyping(
    @MessageBody() payload: { conversationId: string; isTyping: boolean },
    @ConnectedSocket() client: AuthenticatedSocket,
  ): Promise<void> {
    this.enforceRateLimit(client, 'typing');
    const userId = client.data.user.id;
    const isMember = await this.chatService.isParticipant(payload.conversationId, userId);
    if (!isMember) return;

    client
      .to(`conversation:${payload.conversationId}`)
      .emit(SOCKET_CONFIG.events.CHAT.USER_TYPING, {
        userId,
        conversationId: payload.conversationId,
        isTyping: Boolean(payload.isTyping),
      });
  }

  @OnEvent(ContactEventEnum.REQUEST_SENT)
  handleContactRequestSent(event: ContactRequestSentEvent): void {
    this.server
      .to(`user:${event.targetUserId}`)
      .emit(SOCKET_CONFIG.events.CONTACT.REQUEST_RECEIVED, {
        senderId: event.senderId,
        timestamp: event.timestamp,
      });
  }

  @OnEvent(ContactEventEnum.REQUEST_ACCEPTED)
  handleContactRequestAccepted(event: ContactRequestAcceptedEvent): void {
    this.server
      .to(`user:${event.requesterId}`)
      .emit(SOCKET_CONFIG.events.CONTACT.REQUEST_ACCEPTED, {
        accepterId: event.accepterId,
        timestamp: event.timestamp,
      });
  }

  @OnEvent(ContactEventEnum.FRIEND_REMOVED)
  handleContactRemoved(event: ContactRemovedEvent): void {
    this.server.to(`user:${event.targetId}`).emit(SOCKET_CONFIG.events.CONTACT.FRIEND_REMOVED, {
      removerId: event.removerId,
      timestamp: event.timestamp,
    });
  }

  private async syncUndeliveredMessages(userId: string): Promise<void> {
    try {
      const groupedMessages = await this.chatService.processUndeliveredMessages(userId);
      const conversationIds = Object.keys(groupedMessages);

      if (conversationIds.length === 0) return;

      conversationIds.forEach((convId) => {
        const messageIds = groupedMessages[convId];

        const batchPayload = {
          conversationId: convId,
          messageIds,
          status: MessageStatusEnum.DELIVERED,
          userId,
          updatedAt: new Date().toISOString(),
        };

        this.server
          .to(`conversation:${convId}`)
          .emit(SOCKET_CONFIG.events.CHAT.MESSAGE_STATUS_BATCH, batchPayload);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error syncing: ${msg}`);
    }
  }
}
