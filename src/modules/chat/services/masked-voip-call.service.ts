import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { CallStatusEnum, CallTypeEnum, MessageStatusEnum, MessageTypeEnum } from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { envs } from 'src/config/envs/envs';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  FinalizeMaskedVoipCallDto,
  InitiateMaskedVoipCallDto,
} from 'src/dto/chat/omnichannel-inbox.dto';
import { CallDirectionEnum, CallSessionEntity } from 'src/entity/call-session.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { MessageDirectionEnum, MessageEntity } from 'src/entity/message.entity';
import { Repository } from 'typeorm';

import { AccountabilityTimelineService } from './accountability-timeline.service';
import { MessageCryptoService } from './message-crypto.service';

@Injectable()
export class MaskedVoipCallService {
  constructor(
    @InjectRepository(CallSessionEntity)
    private readonly callSessionRepo: Repository<CallSessionEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(MessageEntity)
    private readonly messageRepo: Repository<MessageEntity>,
    private readonly messageCryptoService: MessageCryptoService,
    private readonly accountabilityService: AccountabilityTimelineService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private buildDeterministicWaveformPeaks(seed: string): number[] {
    const peaks: number[] = [];
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    for (let i = 0; i < 36; i++) {
      hash ^= i * 31;
      hash = Math.imul(hash, 16777619);
      const normalized = 18 + (Math.abs(hash) % 78);
      peaks.push(normalized);
    }
    return peaks;
  }

  /**
   * F03.10 & T04: Khởi tạo cuộc gọi chốt đơn ẩn SĐT qua WebRTC-to-SIP Trunking
   * Sale chỉ thấy SĐT đã che (VD: 098***678), SĐT gốc chỉ được giải mã trong RAM của Backend.
   */
  async initiateMaskedPstnCall(params: {
    conversationId: string;
    agentUserId: string;
    dto: InitiateMaskedVoipCallDto;
  }) {
    const conv = await this.conversationRepo.findOne({
      where: { id: params.conversationId },
    });
    if (!conv) {
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    const shopId = conv.shopId || 'default-shop';

    if (params.dto.customerPhoneEncrypted) {
      const rawDestPhone = this.messageCryptoService.decryptForConversation(
        params.dto.customerPhoneEncrypted,
        shopId,
      );
      if (!rawDestPhone || rawDestPhone.startsWith('[')) {
        throw new ForbiddenException('CUSTOMER_PHONE_DECRYPTION_FAILED');
      }
    }

    const maskedDisplay = params.dto.customerPhoneMasked || '098***678';
    const customerId = params.dto.customerId || conv.customerId || conv.id;

    const callSession = this.callSessionRepo.create({
      conversationId: params.conversationId,
      initiatorId: params.agentUserId,
      shopId: conv.shopId,
      customerId,
      callType: CallTypeEnum.AUDIO,
      callDirection: CallDirectionEnum.OUTBOUND_SIP_PSTN,
      sipTrunkProvider: params.dto.sipTrunkProvider || 'PANCAKE_SIP_TRUNK',
      maskedPhoneDisplay: maskedDisplay,
      status: CallStatusEnum.RINGING,
      isGroupCall: false,
      invitedUserIds: [customerId],
      participants: {
        [params.agentUserId]: {
          userId: params.agentUserId,
          joinedAt: new Date().toISOString(),
          isAudioMuted: false,
          isVideoOff: true,
          isScreenSharing: false,
        },
      },
      topology: 'SFU',
      maxConcurrentParticipants: 2,
    });

    const savedSession = await this.callSessionRepo.save(callSession);

    const chatConfig = envs.chat;
    const iceConfig = this.messageCryptoService.generateIceServers({
      userId: params.agentUserId,
      stunUrls: chatConfig?.stunUrls || ['stun:stun.l.google.com:19302'],
      turnUrls: chatConfig?.turnUrls || [],
      turnSecret: chatConfig?.turnSecret || 'turn-default-secret',
      ttlSeconds: 3600,
    });

    await this.accountabilityService.appendMilestone({
      conversationId: params.conversationId,
      eventCode: 'MASKED_CALL_INITIATED',
      actorUserId: params.agentUserId,
      note: `Gọi VoIP ẩn SĐT (${maskedDisplay})`,
    });

    const statusPayload = {
      callSessionId: savedSession.id,
      conversationId: params.conversationId,
      status: CallStatusEnum.RINGING,
      maskedPhoneDisplay: maskedDisplay,
      sipTrunkProvider: savedSession.sipTrunkProvider,
      startedAt: new Date().toISOString(),
    };

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      params.conversationId,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.MASKED_PSTN_CALL_STATUS,
      statusPayload,
    );

    return {
      callSessionId: savedSession.id,
      conversationId: params.conversationId,
      maskedPhoneDisplay: maskedDisplay,
      sipTrunkProvider: savedSession.sipTrunkProvider,
      status: CallStatusEnum.RINGING,
      iceConfig,
    };
  }

  /**
   * F03.10 & T04: Kết thúc cuộc gọi VoIP ẩn SĐT, lưu file ghi âm và chèn bong bóng AudioWaveformPlayer vào luồng chat
   */
  async finalizeCallAndAttachRecordingBubble(params: {
    conversationId: string;
    agentUserId: string;
    dto: FinalizeMaskedVoipCallDto;
  }) {
    const session = await this.callSessionRepo.findOne({
      where: { id: params.dto.callSessionId },
    });
    if (!session) {
      throw new NotFoundException('CALL_SESSION_NOT_FOUND');
    }

    const now = new Date();
    const recordingUrl =
      params.dto.recordingFileUrl || `/api/files/voip-recordings/${session.id}.mp3`;

    session.status = CallStatusEnum.COMPLETED;
    session.durationSeconds = params.dto.durationSeconds;
    session.answeredAt =
      session.answeredAt || new Date(now.getTime() - params.dto.durationSeconds * 1000);
    session.endedAt = now;
    session.recordingFileId = params.dto.recordingFileId || null;
    session.recordingFileUrl = recordingUrl;
    session.callDispositionTag = params.dto.callDispositionTag;
    session.callNotes = params.dto.callNotes || null;

    await this.callSessionRepo.save(session);

    const summaryText = `Cuộc gọi chốt đơn ẩn SĐT (${session.maskedPhoneDisplay || '098***678'}) • ${params.dto.durationSeconds}s — ${params.dto.callDispositionTag}`;
    const encrypted = this.messageCryptoService.encryptForConversation(
      summaryText,
      session.conversationId,
    );

    const waveformPeaks = this.buildDeterministicWaveformPeaks(session.id);

    const callMessage = this.messageRepo.create({
      conversationId: session.conversationId,
      senderId: params.agentUserId,
      shopId: session.shopId,
      direction: MessageDirectionEnum.OUTBOUND,
      type: MessageTypeEnum.CALL,
      content: encrypted.ciphertext,
      status: MessageStatusEnum.SENT,
      readBy: [params.agentUserId],
      deliveredTo: [params.agentUserId],
      createdAt: now,
      updatedAt: now,
      metadata: {
        isEncrypted: true,
        encryptionAlg: 'AES-256-GCM',
        callInfo: {
          callId: session.id,
          callType: CallTypeEnum.AUDIO,
          status: CallStatusEnum.COMPLETED,
          durationSeconds: params.dto.durationSeconds,
          initiatorId: params.agentUserId,
          participantIds: [params.agentUserId, ...(session.invitedUserIds || [])],
          endedAt: now.toISOString(),
          callDirection: CallDirectionEnum.OUTBOUND_SIP_PSTN,
          maskedPhoneDisplay: session.maskedPhoneDisplay || '098***678',
          recordingFileId: session.recordingFileId,
          recordingFileUrl: recordingUrl,
          callDispositionTag: params.dto.callDispositionTag,
          callNotes: params.dto.callNotes || null,
          waveformPeaks,
        },
      },
    });

    const savedMsg = await this.messageRepo.save(callMessage);

    await this.conversationRepo.update(session.conversationId, {
      lastMessage: encrypted.ciphertext,
      lastMessageSenderId: params.agentUserId,
      lastMessageAt: now,
      lastMessageType: MessageTypeEnum.CALL,
      lastAgentReplyAt: now,
      isGhostedByAgent: false,
      isSlaBreached: false,
    });

    await this.accountabilityService.appendMilestone({
      conversationId: session.conversationId,
      eventCode: 'MASKED_CALL_COMPLETED',
      actorUserId: params.agentUserId,
      note: `${params.dto.callDispositionTag} (${params.dto.durationSeconds}s)`,
    });

    const clientMessage = {
      ...savedMsg,
      content: summaryText,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      session.conversationId,
      SOCKET_CONFIG.events.CHAT.NEW_MESSAGE,
      clientMessage,
    );

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      session.conversationId,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.MASKED_PSTN_CALL_STATUS,
      {
        callSessionId: session.id,
        conversationId: session.conversationId,
        status: CallStatusEnum.COMPLETED,
        durationSeconds: params.dto.durationSeconds,
        recordingFileUrl: recordingUrl,
        callDispositionTag: params.dto.callDispositionTag,
      },
    );

    return clientMessage;
  }
}
