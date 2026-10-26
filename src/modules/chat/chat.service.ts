/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import {
  CallStatusEnum,
  CallTypeEnum,
  ConversationTypeEnum,
  MediaTypeEnum,
  MessageStatusEnum,
  MessageTypeEnum,
  NotificationResourceTypeEnum,
  NotificationTypeEnum,
} from 'src/common/enum';
import { AdvancedQueryHelper } from 'src/common/helper/query.helper';
import { SocketStateService, UserPublicKeyBundle } from 'src/common/websocket/socket-state.service';
import { envs } from 'src/config/envs/envs';
import { ChatEventEnum, ChatMessageReadEvent } from 'src/config/websocket/events/chat.events';
import {
  NotificationConversationReadEvent,
  NotificationDispatchEvent,
  NotificationEventEnum,
} from 'src/config/websocket/events/notification.events';
import {
  AddGroupMembersDto,
  EditMessageDto,
  PinMessageDto,
  ReactMessageDto,
  RecallMessageDto,
  RegisterPublicKeyDto,
} from 'src/dto/chat/call-and-security.dto';
import { CreateGroupDto, SendMessageDto } from 'src/dto/chat/chat.dto';
import { CreateDirectChatDto } from 'src/dto/chat/create-direct-chat.dto';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { FileEntity } from 'src/entity/file.entity';
import { MediaEntity } from 'src/entity/media.entity';
import { MessageEntity } from 'src/entity/message.entity';
import { UserEntity } from 'src/entity/user.entity';
import { IBaseQuery } from 'src/interface';
import {
  MessageAttachmentMeta,
  MessageMetadata,
  MessageReplyPreview,
} from 'src/interface/message.interface';
import { PaginationOptions } from 'src/types/query.types';
import { DataSource, In, Repository } from 'typeorm';

import { BufferedFile } from '../files/files.service';
import { MediaService } from '../media/media.service';
import { UserService } from '../user/user.service';
import { MessageCryptoService } from './services/message-crypto.service';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name, {
    timestamp: true,
  });

  private readonly membershipCache = new Map<string, { isMember: boolean; expiresAt: number }>();
  private readonly MEMBERSHIP_CACHE_TTL_MS = 30_000;

  constructor(
    @InjectRepository(ConversationEntity)
    private convRepository: Repository<ConversationEntity>,
    @InjectRepository(MessageEntity)
    private msgRepository: Repository<MessageEntity>,
    @InjectRepository(ConversationParticipantEntity)
    private partRepository: Repository<ConversationParticipantEntity>,
    private dataSource: DataSource,
    private readonly userService: UserService,
    private readonly mediaService: MediaService,
    private readonly socketStateService: SocketStateService,
    private readonly messageCryptoService: MessageCryptoService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private invalidateMembershipCache(conversationId: string, userId?: string): void {
    if (userId) {
      this.membershipCache.delete(`${conversationId}:${userId}`);
      return;
    }
    for (const key of this.membershipCache.keys()) {
      if (key.startsWith(`${conversationId}:`)) {
        this.membershipCache.delete(key);
      }
    }
  }

  async isParticipant(conversationId: string, userId: string): Promise<boolean> {
    if (!conversationId || !userId) return false;
    const cacheKey = `${conversationId}:${userId}`;
    const cached = this.membershipCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.isMember;
    }

    const exists = await this.partRepository.exists({
      where: { conversationId, userId },
    });

    this.membershipCache.set(cacheKey, {
      isMember: exists,
      expiresAt: Date.now() + this.MEMBERSHIP_CACHE_TTL_MS,
    });

    return exists;
  }

  async ensureParticipant(
    conversationId: string,
    userId: string,
  ): Promise<ConversationParticipantEntity> {
    const participant = await this.partRepository.findOne({
      where: { conversationId, userId },
    });
    if (!participant) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
    return participant;
  }

  async getConversationMemberIds(conversationId: string): Promise<string[]> {
    const rows = await this.partRepository.find({
      where: { conversationId },
      select: ['userId'],
    });
    return rows.map((r) => r.userId);
  }

  async getConversationMembersInfo(conversationId: string) {
    const memberIds = await this.getConversationMemberIds(conversationId);
    const users = await this.userService.getBasicUsersInfo(memberIds);
    return users.map((u: any) => ({
      id: u.id,
      name: u.name,
      avatar: u.avatarMedia?.file?.url || null,
    }));
  }

  async sendMessage(payload: { senderId: string; dto: SendMessageDto }) {
    const label = '[sendMessage]';
    const { senderId, dto } = payload;

    // 1. Kiểm tra Idempotency
    if (dto.tempId) {
      const existingMsg = await this.msgRepository.findOne({
        where: {
          conversationId: dto.conversationId,
          senderId,
          clientTempId: dto.tempId,
        },
      });
      if (existingMsg) {
        const enrichedExisting = await this.buildEnrichedMessageResponse(existingMsg.id);
        const memberIds = await this.getConversationMemberIds(dto.conversationId);
        return {
          message: { ...enrichedExisting, tempId: dto.tempId },
          recipientIds: memberIds,
          isDuplicate: true,
        };
      }
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const participant = await this.ensureParticipant(dto.conversationId, senderId);
      const now = new Date();

      let replyPreview: MessageReplyPreview | undefined;
      let repliedUserId: string | null = null;

      if (dto.replyToMessageId) {
        const parentMsg = await queryRunner.manager.findOne(MessageEntity, {
          where: { id: dto.replyToMessageId, conversationId: dto.conversationId },
          relations: ['sender'],
        });
        if (parentMsg) {
          repliedUserId = parentMsg.senderId;
          const decryptedParent = this.messageCryptoService.decryptForConversation(
            parentMsg.content,
            dto.conversationId,
          );
          replyPreview = {
            messageId: parentMsg.id,
            senderId: parentMsg.senderId,
            senderName: parentMsg.sender?.name,
            content:
              parentMsg.status === MessageStatusEnum.REMOVED
                ? '[Tin nhắn đã thu hồi]'
                : decryptedParent.slice(0, 200),
            type: parentMsg.type,
          };
        }
      }

      let attachments: MessageAttachmentMeta[] | undefined;
      if (dto.fileIds && dto.fileIds.length > 0) {
        const files = await queryRunner.manager.find(FileEntity, {
          where: { id: In(dto.fileIds) },
        });
        attachments = files.map((f) => ({
          fileId: f.id,
          url: f.url,
          thumbnailUrl: f.metadata?.thumbnailUrl as string | undefined,
          fileName: f.originalName,
          mimeType: f.mimeType,
          size: Number(f.size),
          width: f.metadata?.width as number | undefined,
          height: f.metadata?.height as number | undefined,
        }));
      }

      const cleanContent = (dto.content || '').trim();
      const encrypted = this.messageCryptoService.encryptForConversation(
        cleanContent,
        dto.conversationId,
      );

      const metadata: MessageMetadata = {
        ...(dto.metadata || {}),
        isEncrypted: encrypted.isEncrypted,
        encryptionAlg: encrypted.algorithm,
        ...(dto.isE2EE ? { isE2EE: true, e2eeKeyId: dto.e2eeKeyId } : {}),
        ...(dto.replyToMessageId ? { replyToMessageId: dto.replyToMessageId, replyPreview } : {}),
        ...(attachments ? { attachments } : {}),
      };

      const message = this.msgRepository.create({
        conversationId: dto.conversationId,
        senderId,
        content: encrypted.ciphertext,
        type: dto.type || MessageTypeEnum.TEXT,
        replyToMessageId: dto.replyToMessageId || null,
        clientTempId: dto.tempId ? dto.tempId.slice(0, 64) : null,
        isPinned: false,
        metadata,
        readBy: [senderId],
        deliveredTo: [senderId],
        status: MessageStatusEnum.SENT,
        createdAt: now,
        updatedAt: now,
      });
      const savedMessage = await queryRunner.manager.save(message);

      if (dto.fileIds && dto.fileIds.length > 0) {
        const files = await queryRunner.manager.find(FileEntity, {
          where: { id: In(dto.fileIds) },
        });
        await this.mediaService.attachFiles(
          files,
          savedMessage.id,
          MediaTypeEnum.MESSAGE_ATTACHMENT,
          queryRunner.manager,
        );
      }

      const lastMsgRaw =
        dto.type === MessageTypeEnum.TEXT || !dto.type ? cleanContent : `[${dto.type}]`;
      const encryptedLastMsg = this.messageCryptoService.encryptForConversation(
        lastMsgRaw,
        dto.conversationId,
      );

      await queryRunner.manager.update(ConversationEntity, dto.conversationId, {
        lastMessage: encryptedLastMsg.ciphertext,
        lastMessageSenderId: senderId,
        lastMessageAt: savedMessage.createdAt,
        lastMessageType: dto.type || MessageTypeEnum.TEXT,
      });

      await queryRunner.manager.update(ConversationParticipantEntity, participant.id, {
        lastReadAt: savedMessage.createdAt,
      });

      const participants = await this.partRepository.find({
        where: { conversationId: dto.conversationId },
        select: ['userId', 'isMuted'],
      });

      const conversation = await this.convRepository.findOne({
        where: { id: dto.conversationId },
        select: ['id', 'name', 'type'],
      });

      await queryRunner.commitTransaction();

      const finalMessage = await this.buildEnrichedMessageResponse(savedMessage.id);
      this.logger.debug(`${label} messageId -> ${JSON.stringify(message.id)}`);

      // Phát sự kiện thông báo cho các thành viên chưa tắt thông báo (isMuted = false)
      const unmutedRecipients = participants
        .filter((p) => p.userId !== senderId && !p.isMuted)
        .map((p) => p.userId);

      if (unmutedRecipients.length > 0 && finalMessage) {
        const senderName = finalMessage.sender?.name || 'Người dùng';
        const isGroup = conversation?.type === ConversationTypeEnum.GROUP;
        const previewText =
          dto.type === MessageTypeEnum.IMAGE
            ? 'đã gửi một hình ảnh'
            : dto.type === MessageTypeEnum.VIDEO
              ? 'đã gửi một video'
              : dto.type === MessageTypeEnum.AUDIO
                ? 'đã gửi một tin nhắn thoại'
                : dto.type === MessageTypeEnum.FILE
                  ? 'đã gửi một tệp đính kèm'
                  : cleanContent.slice(0, 120);

        // Nếu có người được reply trực tiếp thì gửi thông báo phản hồi riêng
        if (
          repliedUserId &&
          repliedUserId !== senderId &&
          unmutedRecipients.includes(repliedUserId)
        ) {
          this.eventEmitter.emit(
            NotificationEventEnum.DISPATCH,
            new NotificationDispatchEvent({
              recipientIds: [repliedUserId],
              actorId: senderId,
              type: NotificationTypeEnum.MESSAGE_REPLY,
              title: isGroup
                ? `${senderName} đã trả lời bạn trong ${conversation?.name || 'nhóm'}`
                : `${senderName} đã trả lời tin nhắn của bạn`,
              content: previewText,
              resourceType: NotificationResourceTypeEnum.CONVERSATION,
              resourceId: dto.conversationId,
              dedupeKey: `msg_unread:${dto.conversationId}`,
              metadata: {
                conversationId: dto.conversationId,
                conversationName: conversation?.name,
                conversationType: conversation?.type,
                messageId: savedMessage.id,
                messageType: savedMessage.type,
                actionUrl: `/chat/${dto.conversationId}`,
              },
            }),
          );
        }

        const normalRecipients = unmutedRecipients.filter((uid) => uid !== repliedUserId);
        if (normalRecipients.length > 0) {
          this.eventEmitter.emit(
            NotificationEventEnum.DISPATCH,
            new NotificationDispatchEvent({
              recipientIds: normalRecipients,
              actorId: senderId,
              type: NotificationTypeEnum.NEW_MESSAGE,
              title: isGroup
                ? `Tin nhắn mới trong ${conversation?.name || 'nhóm'}`
                : `Tin nhắn mới từ ${senderName}`,
              content: isGroup ? `${senderName}: ${previewText}` : previewText,
              resourceType: NotificationResourceTypeEnum.CONVERSATION,
              resourceId: dto.conversationId,
              dedupeKey: `msg_unread:${dto.conversationId}`,
              metadata: {
                conversationId: dto.conversationId,
                conversationName: conversation?.name,
                conversationType: conversation?.type,
                messageId: savedMessage.id,
                messageType: savedMessage.type,
                actionUrl: `/chat/${dto.conversationId}`,
              },
            }),
          );
        }
      }

      return {
        message: { ...finalMessage, tempId: dto.tempId },
        recipientIds: participants.map((p) => p.userId),
        isDuplicate: false,
      };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async uploadAndSendAttachmentMessage(params: {
    senderId: string;
    conversationId: string;
    files: BufferedFile[];
    content?: string;
    replyToMessageId?: string;
    tempId?: string;
  }) {
    await this.ensureParticipant(params.conversationId, params.senderId);

    const uploadedFiles = await this.mediaService.processMultipleUploads({
      files: params.files,
      targetId: params.conversationId,
      type: MediaTypeEnum.MESSAGE_ATTACHMENT,
      userId: params.senderId,
      options: {
        folder: `chat/${params.conversationId}`,
        optimize: true,
        generateThumbnail: true,
        deduplicate: true,
      },
    });

    const firstMime = uploadedFiles[0]?.mimeType || '';
    let detectedType = MessageTypeEnum.FILE;
    if (firstMime.startsWith('image/')) detectedType = MessageTypeEnum.IMAGE;
    else if (firstMime.startsWith('video/')) detectedType = MessageTypeEnum.VIDEO;
    else if (firstMime.startsWith('audio/')) detectedType = MessageTypeEnum.AUDIO;

    return this.sendMessage({
      senderId: params.senderId,
      dto: {
        conversationId: params.conversationId,
        content: params.content || uploadedFiles.map((f) => f.originalName).join(', '),
        type: detectedType,
        fileIds: uploadedFiles.map((f) => f.id),
        replyToMessageId: params.replyToMessageId,
        tempId: params.tempId,
      },
    });
  }

  async editMessage(payload: { userId: string; dto: EditMessageDto }) {
    const { userId, dto } = payload;
    await this.ensureParticipant(dto.conversationId, userId);

    const message = await this.msgRepository.findOne({
      where: { id: dto.messageId, conversationId: dto.conversationId },
    });
    if (!message) throw new NotFoundException('Message not found');
    if (message.senderId !== userId) {
      throw new ForbiddenException('Only the sender can edit this message');
    }
    if (message.status === MessageStatusEnum.REMOVED) {
      throw new BadRequestException('Cannot edit a recalled message');
    }

    const encrypted = this.messageCryptoService.encryptForConversation(
      dto.content.trim(),
      dto.conversationId,
    );

    message.content = encrypted.ciphertext;
    message.metadata = {
      ...(message.metadata || {}),
      isEncrypted: true,
      encryptionAlg: 'AES-256-GCM',
      isEdited: true,
      editedAt: new Date().toISOString(),
    };

    await this.msgRepository.save(message);

    const latestMsg = await this.msgRepository.findOne({
      where: { conversationId: dto.conversationId },
      order: { createdAt: 'DESC' },
      select: ['id'],
    });
    if (latestMsg && latestMsg.id === message.id) {
      await this.convRepository.update(dto.conversationId, {
        lastMessage: encrypted.ciphertext,
      });
    }

    const enriched = await this.buildEnrichedMessageResponse(message.id);
    const recipientIds = await this.getConversationMemberIds(dto.conversationId);

    return { message: enriched, recipientIds };
  }

  async recallMessage(payload: { userId: string; dto: RecallMessageDto }) {
    const { userId, dto } = payload;
    const participant = await this.ensureParticipant(dto.conversationId, userId);

    const message = await this.msgRepository.findOne({
      where: { id: dto.messageId, conversationId: dto.conversationId },
    });
    if (!message) throw new NotFoundException('Message not found');

    if (message.senderId !== userId && !participant.isAdmin) {
      throw new ForbiddenException('You do not have permission to recall this message');
    }

    const recalledPlaceholder = this.messageCryptoService.encryptForConversation(
      '[Tin nhắn đã được thu hồi]',
      dto.conversationId,
    );

    message.content = recalledPlaceholder.ciphertext;
    message.status = MessageStatusEnum.REMOVED;
    message.isPinned = false;
    message.metadata = {
      isEncrypted: true,
      encryptionAlg: 'AES-256-GCM',
      isPinned: false,
    };

    await this.msgRepository.save(message);

    const latestMsg = await this.msgRepository.findOne({
      where: { conversationId: dto.conversationId },
      order: { createdAt: 'DESC' },
      select: ['id'],
    });
    if (latestMsg && latestMsg.id === message.id) {
      await this.convRepository.update(dto.conversationId, {
        lastMessage: recalledPlaceholder.ciphertext,
      });
    }

    const recipientIds = await this.getConversationMemberIds(dto.conversationId);

    return {
      conversationId: dto.conversationId,
      messageId: message.id,
      recalledBy: userId,
      recalledAt: new Date().toISOString(),
      recipientIds,
    };
  }

  async toggleReaction(payload: { userId: string; dto: ReactMessageDto }) {
    const { userId, dto } = payload;
    await this.ensureParticipant(dto.conversationId, userId);

    const message = await this.msgRepository.findOne({
      where: { id: dto.messageId, conversationId: dto.conversationId },
    });
    if (!message) throw new NotFoundException('Message not found');

    const metadata: MessageMetadata = { ...(message.metadata || {}) };
    const reactions: Record<string, string[]> = { ...(metadata.reactions || {}) };
    const currentUsers = new Set(reactions[dto.emoji] || []);

    let action: 'added' | 'removed';
    if (currentUsers.has(userId)) {
      currentUsers.delete(userId);
      action = 'removed';
    } else {
      currentUsers.add(userId);
      action = 'added';
    }

    if (currentUsers.size === 0) {
      delete reactions[dto.emoji];
    } else {
      reactions[dto.emoji] = Array.from(currentUsers);
    }

    metadata.reactions = reactions;
    message.metadata = metadata;
    await this.msgRepository.save(message);

    if (action === 'added' && message.senderId !== userId) {
      const targetPart = await this.partRepository.findOne({
        where: { conversationId: dto.conversationId, userId: message.senderId },
        select: ['isMuted'],
      });

      if (!targetPart?.isMuted) {
        const users = await this.userService.getBasicUsersInfo([userId]);
        const actorName = users[0]?.name || 'Một người dùng';
        const decryptedPreview = this.messageCryptoService
          .decryptForConversation(message.content, dto.conversationId)
          .slice(0, 80);

        this.eventEmitter.emit(
          NotificationEventEnum.DISPATCH,
          new NotificationDispatchEvent({
            recipientIds: [message.senderId],
            actorId: userId,
            type: NotificationTypeEnum.MESSAGE_REACTION,
            title: `${actorName} đã bày tỏ cảm xúc ${dto.emoji}`,
            content: `Về tin nhắn của bạn: "${decryptedPreview}"`,
            resourceType: NotificationResourceTypeEnum.CONVERSATION,
            resourceId: dto.conversationId,
            dedupeKey: `react:${message.id}:${userId}`,
            metadata: {
              conversationId: dto.conversationId,
              messageId: message.id,
              emoji: dto.emoji,
              actionUrl: `/chat/${dto.conversationId}`,
            },
          }),
        );
      }
    }

    return {
      conversationId: dto.conversationId,
      messageId: message.id,
      userId,
      emoji: dto.emoji,
      action,
      reactions,
    };
  }

  async togglePinMessage(payload: { userId: string; dto: PinMessageDto }) {
    const { userId, dto } = payload;
    await this.ensureParticipant(dto.conversationId, userId);

    const message = await this.msgRepository.findOne({
      where: { id: dto.messageId, conversationId: dto.conversationId },
    });
    if (!message) throw new NotFoundException('Message not found');

    message.isPinned = dto.isPinned;
    message.metadata = {
      ...(message.metadata || {}),
      isPinned: dto.isPinned,
      pinnedBy: dto.isPinned ? userId : undefined,
      pinnedAt: dto.isPinned ? new Date().toISOString() : undefined,
    };

    await this.msgRepository.save(message);
    return {
      conversationId: dto.conversationId,
      messageId: message.id,
      isPinned: dto.isPinned,
      pinnedBy: userId,
    };
  }

  async recordCallHistoryMessage(params: {
    conversationId: string;
    initiatorId: string;
    callId: string;
    callType: CallTypeEnum;
    status: CallStatusEnum;
    durationSeconds: number;
    participantIds: string[];
  }) {
    const formatDuration = (sec: number) => {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m > 0 ? `${m} phút ${s} giây` : `${s} giây`;
    };

    const callLabel = params.callType === CallTypeEnum.VIDEO ? 'video' : 'thoại';
    let summaryText = `Cuộc gọi ${callLabel} nhỡ`;
    if (params.status === CallStatusEnum.COMPLETED) {
      summaryText = `Cuộc gọi ${callLabel} (${formatDuration(params.durationSeconds)})`;
    } else if (params.status === CallStatusEnum.REJECTED) {
      summaryText = `Cuộc gọi ${callLabel} đã bị từ chối`;
    } else if (params.status === CallStatusEnum.CANCELLED) {
      summaryText = `Cuộc gọi ${callLabel} đã hủy`;
    } else if (params.status === CallStatusEnum.BUSY) {
      summaryText = `Người nhận đang bận`;
    }

    const encrypted = this.messageCryptoService.encryptForConversation(
      summaryText,
      params.conversationId,
    );

    const now = new Date();
    const msg = this.msgRepository.create({
      conversationId: params.conversationId,
      senderId: params.initiatorId,
      content: encrypted.ciphertext,
      type: MessageTypeEnum.CALL,
      status: MessageStatusEnum.SENT,
      readBy: [params.initiatorId],
      deliveredTo: params.participantIds,
      createdAt: now,
      updatedAt: now,
      metadata: {
        isEncrypted: true,
        encryptionAlg: 'AES-256-GCM',
        callInfo: {
          callId: params.callId,
          callType: params.callType,
          status: params.status,
          durationSeconds: params.durationSeconds,
          initiatorId: params.initiatorId,
          participantIds: params.participantIds,
          endedAt: now.toISOString(),
        },
      },
    });

    const saved = await this.msgRepository.save(msg);
    await this.convRepository.update(params.conversationId, {
      lastMessage: encrypted.ciphertext,
      lastMessageSenderId: params.initiatorId,
      lastMessageAt: saved.createdAt,
      lastMessageType: MessageTypeEnum.CALL,
    });

    const enriched = await this.buildEnrichedMessageResponse(saved.id);

    // Thông báo cuộc gọi nhỡ cho người nhận
    if (params.status === CallStatusEnum.MISSED || params.status === CallStatusEnum.CANCELLED) {
      const targetIds = params.participantIds.filter((id) => id !== params.initiatorId);
      if (targetIds.length > 0) {
        const callerName = enriched?.sender?.name || 'Người dùng';
        this.eventEmitter.emit(
          NotificationEventEnum.DISPATCH,
          new NotificationDispatchEvent({
            recipientIds: targetIds,
            actorId: params.initiatorId,
            type: NotificationTypeEnum.MISSED_CALL,
            title: `Cuộc gọi ${callLabel} nhỡ`,
            content: `Bạn có cuộc gọi ${callLabel} nhỡ từ ${callerName}.`,
            resourceType: NotificationResourceTypeEnum.CONVERSATION,
            resourceId: params.conversationId,
            dedupeKey: `missed_call:${params.conversationId}:${params.initiatorId}`,
            metadata: {
              conversationId: params.conversationId,
              callId: params.callId,
              callType: params.callType,
              actionUrl: `/chat/${params.conversationId}`,
            },
          }),
        );
      }
    }

    return enriched;
  }

  async registerE2EEPublicKey(
    userId: string,
    dto: RegisterPublicKeyDto,
  ): Promise<UserPublicKeyBundle> {
    const bundle: UserPublicKeyBundle = {
      userId,
      publicKey: dto.publicKey,
      algorithm: dto.algorithm || 'ECDH-P256',
      keyId: dto.keyId,
      updatedAt: new Date().toISOString(),
    };
    await this.socketStateService.setPublicKeyBundle(bundle);
    return bundle;
  }

  async getConversationPublicKeys(
    conversationId: string,
    requesterId: string,
  ): Promise<Record<string, UserPublicKeyBundle>> {
    await this.ensureParticipant(conversationId, requesterId);
    const memberIds = await this.getConversationMemberIds(conversationId);
    return this.socketStateService.getPublicKeyBundles(memberIds);
  }

  getWebRtcIceServers(userId: string) {
    const chatConfig = envs.chat;
    return this.messageCryptoService.generateIceServers({
      userId,
      stunUrls: chatConfig.stunUrls,
      turnUrls: chatConfig.turnUrls,
      turnSecret: chatConfig.turnSecret,
      ttlSeconds: chatConfig.turnTtl,
    });
  }

  async addGroupMembers(params: {
    conversationId: string;
    requesterId: string;
    dto: AddGroupMembersDto;
  }) {
    const conv = await this.convRepository.findOne({ where: { id: params.conversationId } });
    if (!conv || conv.type !== ConversationTypeEnum.GROUP) {
      throw new BadRequestException('Target conversation is not a group chat');
    }

    const requesterPart = await this.ensureParticipant(params.conversationId, params.requesterId);
    if (!requesterPart.isAdmin) {
      throw new ForbiddenException('Only group admins can add members');
    }

    const existingParts = await this.partRepository.find({
      where: { conversationId: params.conversationId },
      select: ['userId'],
    });
    const existingSet = new Set(existingParts.map((p) => p.userId));
    const newMemberIds = [...new Set(params.dto.memberIds)].filter((id) => !existingSet.has(id));

    if (newMemberIds.length > 0) {
      const now = new Date();
      const entities = newMemberIds.map((uid) =>
        this.partRepository.create({
          conversationId: params.conversationId,
          userId: uid,
          isAdmin: false,
          joinedAt: now,
          lastReadAt: now,
        }),
      );
      await this.partRepository.save(entities);
      this.invalidateMembershipCache(params.conversationId);

      const users = await this.userService.getBasicUsersInfo([params.requesterId]);
      const requesterName = users[0]?.name || 'Quản trị viên';

      this.eventEmitter.emit(
        NotificationEventEnum.DISPATCH,
        new NotificationDispatchEvent({
          recipientIds: newMemberIds,
          actorId: params.requesterId,
          type: NotificationTypeEnum.GROUP_MEMBER_ADDED,
          title: 'Được thêm vào nhóm trò chuyện',
          content: `${requesterName} đã thêm bạn vào nhóm "${conv.name || 'Nhóm trò chuyện'}".`,
          resourceType: NotificationResourceTypeEnum.CONVERSATION,
          resourceId: params.conversationId,
          metadata: {
            conversationId: params.conversationId,
            conversationName: conv.name,
            actionUrl: `/chat/${params.conversationId}`,
          },
        }),
      );
    }

    return {
      conversationId: params.conversationId,
      addedMemberIds: newMemberIds,
    };
  }

  async removeGroupMember(params: {
    conversationId: string;
    requesterId: string;
    targetUserId: string;
  }) {
    const requesterPart = await this.ensureParticipant(params.conversationId, params.requesterId);
    if (params.requesterId !== params.targetUserId && !requesterPart.isAdmin) {
      throw new ForbiddenException('Only group admins can remove other members');
    }

    await this.partRepository.delete({
      conversationId: params.conversationId,
      userId: params.targetUserId,
    });
    this.invalidateMembershipCache(params.conversationId, params.targetUserId);

    return {
      conversationId: params.conversationId,
      removedUserId: params.targetUserId,
    };
  }

  async setMuteConversation(params: { conversationId: string; userId: string; isMuted: boolean }) {
    await this.ensureParticipant(params.conversationId, params.userId);
    await this.partRepository.update(
      { conversationId: params.conversationId, userId: params.userId },
      { isMuted: params.isMuted },
    );
    return { conversationId: params.conversationId, isMuted: params.isMuted };
  }

  private async buildEnrichedMessageResponse(messageId: string) {
    const fullMessage = await this.msgRepository
      .createQueryBuilder('m')
      .where('m.id = :id', { id: messageId })
      .leftJoinAndSelect('m.sender', 'sender')
      .addSelect(['sender.id', 'sender.name', 'sender.email'])
      .leftJoinAndMapOne(
        'sender.avatarMedia',
        MediaEntity,
        'media',
        'media.targetId = sender.id AND media.type = :avatarType',
        { avatarType: MediaTypeEnum.USER_AVATAR },
      )
      .leftJoinAndSelect('media.file', 'file')
      .getOne();

    if (!fullMessage) return null;

    const decryptedContent = this.messageCryptoService.decryptForConversation(
      fullMessage.content,
      fullMessage.conversationId,
    );

    const sender = fullMessage.sender as any;
    if (sender) {
      const avatarUrl = sender.avatarMedia?.file?.url || null;
      delete sender.avatarMedia;
      sender.avatar = avatarUrl;
    }

    return {
      ...fullMessage,
      createdAt: fullMessage.createdAt
        ? new Date(fullMessage.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: fullMessage.updatedAt
        ? new Date(fullMessage.updatedAt).toISOString()
        : new Date().toISOString(),
      content: decryptedContent,
      sender,
    };
  }

  async getMessages(payload: {
    conversationId: string;
    userId: string;
    pagination: PaginationOptions & { search?: string };
  }) {
    const { conversationId, userId, pagination } = payload;

    const isMember = await this.isParticipant(conversationId, userId);
    if (!isMember) throw new ForbiddenException('Not a member of this conversation');

    const helper = AdvancedQueryHelper.from(this.msgRepository, 'm')
      .filter({ conversationId })
      .leftJoinRelation('sender', 'sender')
      .addSelect(['sender.id', 'sender.name']);

    helper
      .leftJoinAndMapOne(
        'sender.avatarMedia',
        MediaEntity,
        'm_avatar',
        'm_avatar.targetId = sender.id AND m_avatar.type = :avatarType',
        { avatarType: MediaTypeEnum.USER_AVATAR },
      )
      .leftJoinAndSelect('m_avatar.file', 'f_avatar');

    const result = await helper.getPaginated(pagination);

    const readerIds = new Set<string>();
    result.data.forEach((msg: any) => {
      if (Array.isArray(msg.readBy)) {
        (msg.readBy as string[]).forEach((id: string) => {
          if (id !== userId) readerIds.add(id);
        });
      }
    });

    const userMap = new Map<string, UserEntity>();
    if (readerIds.size > 0) {
      const users = await this.userService.getBasicUsersInfo(Array.from(readerIds));
      users.forEach((u) => userMap.set(u.id, u));
    }

    let finalData = result.data.map((msg: any) => {
      const sender = msg.sender;
      const avatarUrl = sender?.avatarMedia?.file?.url || null;
      if (sender) delete sender.avatarMedia;
      const cleanSender = { ...sender, avatar: avatarUrl };

      const computedStatus = this.computeStatus(msg as MessageEntity, userId);
      const decryptedContent = this.messageCryptoService.decryptForConversation(
        msg.content as string,
        conversationId,
      );

      let readByUsers: { id: string; name: string; avatar: string | null }[] = [];

      if (Array.isArray(msg.readBy)) {
        readByUsers = (msg.readBy as string[])
          .map((id: string) => {
            const u = userMap.get(id);
            if (!u) return null;
            const userWithAvatar = u as any;

            return {
              id: u.id,
              name: u.name,
              avatar: userWithAvatar.avatarMedia?.file?.url || null,
            };
          })
          .filter(
            (item): item is { id: string; name: string; avatar: string | null } => item !== null,
          );
      }

      return {
        ...msg,
        createdAt: msg.createdAt ? new Date(msg.createdAt).toISOString() : new Date().toISOString(),
        updatedAt: msg.updatedAt ? new Date(msg.updatedAt).toISOString() : new Date().toISOString(),
        content: decryptedContent,
        sender: cleanSender,
        status: computedStatus,
        readByUsers,
      };
    });

    if (pagination.search) {
      const keyword = pagination.search.toLowerCase();
      finalData = finalData.filter((m: any) =>
        String(m.content || '')
          .toLowerCase()
          .includes(keyword),
      );
    }

    return { ...result, data: finalData };
  }

  async createGroupChat(payload: { creatorId: string; dto: CreateGroupDto }) {
    const { creatorId, dto } = payload;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const now = new Date();
      const conversation = this.convRepository.create({
        name: dto.name.trim(),
        type: ConversationTypeEnum.GROUP,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const savedConv = await queryRunner.manager.save(conversation);

      const uniqueIds = [...new Set([creatorId, ...dto.memberIds])];
      const participants = uniqueIds.map((uid) =>
        this.partRepository.create({
          conversationId: savedConv.id,
          userId: uid,
          isAdmin: uid === creatorId,
          joinedAt: now,
          lastReadAt: now,
        }),
      );

      await queryRunner.manager.save(participants);
      await queryRunner.commitTransaction();

      const invitedIds = uniqueIds.filter((uid) => uid !== creatorId);
      if (invitedIds.length > 0) {
        const users = await this.userService.getBasicUsersInfo([creatorId]);
        const creatorName = users[0]?.name || 'Một người dùng';

        this.eventEmitter.emit(
          NotificationEventEnum.DISPATCH,
          new NotificationDispatchEvent({
            recipientIds: invitedIds,
            actorId: creatorId,
            type: NotificationTypeEnum.GROUP_INVITE,
            title: 'Nhóm trò chuyện mới',
            content: `${creatorName} đã thêm bạn vào nhóm "${savedConv.name}".`,
            resourceType: NotificationResourceTypeEnum.CONVERSATION,
            resourceId: savedConv.id,
            metadata: {
              conversationId: savedConv.id,
              conversationName: savedConv.name,
              actionUrl: `/chat/${savedConv.id}`,
            },
          }),
        );
      }

      return savedConv;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async getUserInbox(payload: { userId: string; query: IBaseQuery }) {
    const { userId, query } = payload;

    const helper = AdvancedQueryHelper.from(this.convRepository, 'c');

    helper
      .joinRelation('participants', 'mp', {
        str: 'mp.userId = :userId',
        params: { userId },
      })
      .addSelect(['mp.isAdmin', 'mp.isMuted', 'mp.joinedAt', 'mp.lastReadAt'])
      .mapOneWithSubQuery({
        mapTo: 'partnerUser',
        entity: UserEntity,
        alias: 'u_partner',
        conditionBuilder: (sub, parentAlias) => {
          return sub
            .select('cp.userId')
            .from(ConversationParticipantEntity, 'cp')
            .where(`cp.conversationId = ${parentAlias}.id`)
            .andWhere('cp.userId != :userId');
        },
        extraCondition: 'c.type = :typeDirect',
        params: { userId, typeDirect: ConversationTypeEnum.DIRECT },
      })
      .leftJoinAndMapOne(
        'u_partner.avatarMedia',
        MediaEntity,
        'm_avatar',
        'm_avatar.targetId = u_partner.id AND m_avatar.type = :avatarType',
        { avatarType: MediaTypeEnum.USER_AVATAR },
      )
      .leftJoinAndSelect('m_avatar.file', 'f_avatar')
      .selectSubQuery('unreadCount', (sub, parentAlias) => {
        return sub
          .select('COUNT(m.id)', 'count')
          .from(MessageEntity, 'm')
          .where(`m.conversationId = ${parentAlias}.id`)
          .andWhere('m.senderId != :userId')
          .andWhere('m.status != :removedStatus', {
            removedStatus: MessageStatusEnum.REMOVED,
          })
          .andWhere('(mp.joinedAt IS NULL OR m.createdAt >= mp.joinedAt)')
          .andWhere('(mp.lastReadAt IS NULL OR m.createdAt > mp.lastReadAt)');
      });

    if (query.search) {
      helper.smartSearch(query.search, (builder) => {
        builder
          .matchCase(
            'c.type = :searchTypeDirect',
            { searchTypeDirect: ConversationTypeEnum.DIRECT },
            ['u_partner.name', 'u_partner.email'],
          )
          .matchCase('c.type = :searchTypeGroup', { searchTypeGroup: ConversationTypeEnum.GROUP }, [
            'c.name',
          ]);
      });
    }

    if (!query.sort) {
      query.sort = 'lastMessageAt:DESC';
    }

    const result = await helper.getPaginatedRaw(query, {
      unreadCount: 'int',
    });

    const partnerIds: string[] = result.data
      .filter((c: any) => c.type === ConversationTypeEnum.DIRECT && c.partnerUser)
      .map((c: any) => String(c.partnerUser.id));

    const onlineSet = await this.socketStateService.getOnlineUsers(partnerIds);

    const finalData = result.data.map((conv: any) => {
      const myParticipant = conv.participants?.[0];
      let isOnline = false;
      let avatar = conv.avatar || null;
      if (conv.type === ConversationTypeEnum.DIRECT && conv.partnerUser) {
        conv.name = conv.partnerUser.name;
        avatar = conv.partnerUser.avatarMedia?.file?.url || null;
        conv.partnerId = conv.partnerUser.id;
        isOnline = onlineSet.has(String(conv.partnerUser.id));
      }

      const decryptedLastMessage = conv.lastMessage
        ? this.messageCryptoService.decryptForConversation(
            conv.lastMessage as string,
            conv.id as string,
          )
        : null;

      delete conv.partner;
      delete conv.partnerUser;
      delete conv.participants;

      return {
        ...conv,
        unreadCount: Math.max(0, Number(conv.unreadCount || 0)),
        lastMessage: decryptedLastMessage,
        lastMessageAt: conv.lastMessageAt
          ? new Date(conv.lastMessageAt).toISOString()
          : conv.createdAt
            ? new Date(conv.createdAt).toISOString()
            : null,
        isOnline,
        avatar,
        isAdmin: myParticipant?.isAdmin || false,
        isMuted: myParticipant?.isMuted || false,
        joinedAt: myParticipant?.joinedAt
          ? new Date(myParticipant.joinedAt).toISOString()
          : new Date().toISOString(),
        lastReadAt: myParticipant?.lastReadAt
          ? new Date(myParticipant.lastReadAt).toISOString()
          : null,
      };
    });

    return { ...result, data: finalData };
  }

  async getRelatedUserIds(userId: string): Promise<string[]> {
    const partners = await this.partRepository
      .createQueryBuilder('p')
      .select('DISTINCT p.userId', 'userId')
      .innerJoin('conversation_participants', 'me', 'me.conversationId = p.conversationId')
      .where('me.userId = :userId', { userId })
      .andWhere('p.userId != :userId', { userId })
      .getRawMany<{ userId: string }>();

    return partners.map((p) => p.userId);
  }

  async getOrCreateDirectConversation(payload: { senderId: string; dto: CreateDirectChatDto }) {
    const { senderId, dto } = payload;
    const { receiverId } = dto;

    if (senderId === receiverId) {
      throw new BadRequestException('Không thể chat với chính mình');
    }

    await this.userService.findUserById({
      userId: receiverId,
    });

    const directKey = [senderId, receiverId].sort().join(':');

    const existingByKey = await this.convRepository.findOne({
      where: { directKey },
    });
    if (existingByKey) {
      return this.enrichConversationInfo(existingByKey, receiverId);
    }

    const existingConversation = await this.convRepository
      .createQueryBuilder('c')
      .innerJoin('c.participants', 'p1')
      .innerJoin('c.participants', 'p2')
      .where('c.type = :type', { type: ConversationTypeEnum.DIRECT })
      .andWhere('p1.userId = :senderId', { senderId })
      .andWhere('p2.userId = :receiverId', { receiverId })
      .getOne();

    if (existingConversation) {
      if (!existingConversation.directKey) {
        await this.convRepository
          .update(existingConversation.id, { directKey })
          .catch(() => undefined);
      }
      return this.enrichConversationInfo(existingConversation, receiverId);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const now = new Date();
      const newConv = this.convRepository.create({
        type: ConversationTypeEnum.DIRECT,
        directKey,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const savedConv = await queryRunner.manager.save(newConv);

      const participants = [senderId, receiverId].map((uid) =>
        this.partRepository.create({
          conversationId: savedConv.id,
          userId: uid,
          joinedAt: now,
          lastReadAt: now,
        }),
      );
      await queryRunner.manager.save(participants);

      await queryRunner.commitTransaction();

      return this.enrichConversationInfo(savedConv, receiverId);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      const raceWinner = await this.convRepository.findOne({ where: { directKey } });
      if (raceWinner) {
        return this.enrichConversationInfo(raceWinner, receiverId);
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async enrichConversationInfo(conversation: ConversationEntity, partnerId: string) {
    const partnerUsers = await this.userService.getBasicUsersInfo([partnerId]);
    const partner = partnerUsers[0] as any;
    const onlineSet = await this.socketStateService.getOnlineUsers([partnerId]);

    return {
      ...conversation,
      name: partner?.name || conversation.name,
      avatar: partner?.avatarMedia?.file?.url || conversation.avatar || null,
      partnerId,
      unreadCount: 0,
      isOnline: onlineSet.has(partnerId),
      lastMessage: conversation.lastMessage
        ? this.messageCryptoService.decryptForConversation(
            conversation.lastMessage,
            conversation.id,
          )
        : null,
      lastMessageAt: conversation.lastMessageAt
        ? new Date(conversation.lastMessageAt).toISOString()
        : new Date().toISOString(),
      partnerInfo: partner
        ? {
            id: partner.id,
            name: partner.name,
            avatar: partner?.avatarMedia?.file?.url || null,
          }
        : null,
    };
  }

  async markConversationAsRead(payload: { userId: string; conversationId: string }) {
    const label = '[markConversationAsRead]';
    const { conversationId, userId } = payload;
    this.logger.debug(`${label} conversationId -> ${conversationId}`);

    await this.ensureParticipant(conversationId, userId);
    const now = new Date();

    await this.partRepository.update({ conversationId, userId }, { lastReadAt: now });

    await this.msgRepository
      .createQueryBuilder()
      .update(MessageEntity)
      .set({
        readBy: () => `JSON_ARRAY_APPEND(COALESCE(readBy, JSON_ARRAY()), '$', :userId)`,
      })
      .where('conversationId = :conversationId', { conversationId })
      .andWhere('senderId != :userId', { userId })
      .andWhere(`NOT JSON_CONTAINS(COALESCE(readBy, JSON_ARRAY()), JSON_QUOTE(:userId), '$')`)
      .setParameters({ userId, conversationId })
      .execute();

    const users = await this.userService.getBasicUsersInfo([userId]);
    const user = users[0];

    const userReaderInfo = user
      ? {
          id: user.id,
          name: user.name,
          avatar: ((user as any).avatarMedia?.file?.url as string) || null,
        }
      : { id: userId, name: 'Unknown', avatar: null };

    const event = new ChatMessageReadEvent(conversationId, userId, now, userReaderInfo);
    this.eventEmitter.emit(ChatEventEnum.MESSAGE_READ, event);

    // Đồng bộ đánh dấu đã đọc các thông báo tin nhắn của hội thoại này
    this.eventEmitter.emit(
      NotificationEventEnum.MARK_CONVERSATION_READ,
      new NotificationConversationReadEvent(userId, conversationId),
    );

    return { success: true, lastReadAt: now.toISOString() };
  }

  async markAsDelivered(payload: { userId: string; messageId: string }) {
    const { userId, messageId } = payload;

    await this.msgRepository
      .createQueryBuilder()
      .update(MessageEntity)
      .set({
        deliveredTo: () => `JSON_ARRAY_APPEND(COALESCE(deliveredTo, JSON_ARRAY()), '$', :userId)`,
      })
      .where('id = :messageId', { messageId })
      .andWhere('senderId != :userId', { userId })
      .andWhere(`NOT JSON_CONTAINS(COALESCE(deliveredTo, JSON_ARRAY()), JSON_QUOTE(:userId), '$')`)
      .setParameters({ userId, messageId })
      .execute();

    return { success: true };
  }

  private computeStatus(msg: MessageEntity, currentUserId: string): MessageStatusEnum {
    if (msg.status === MessageStatusEnum.REMOVED) return MessageStatusEnum.REMOVED;
    if (msg.status === MessageStatusEnum.FAILED) return MessageStatusEnum.FAILED;

    if (msg.senderId !== currentUserId) return MessageStatusEnum.READ;

    const hasRead = msg.readBy?.some((id) => id !== currentUserId);
    if (hasRead) return MessageStatusEnum.READ;

    const hasDelivered = msg.deliveredTo?.some((id) => id !== currentUserId);
    if (hasDelivered) return MessageStatusEnum.DELIVERED;

    return MessageStatusEnum.SENT;
  }

  async processUndeliveredMessages(userId: string): Promise<Record<string, string[]>> {
    const pendingMessages = await this.msgRepository
      .createQueryBuilder('m')
      .select(['m.id', 'm.conversationId', 'm.senderId'])
      .innerJoin(
        ConversationParticipantEntity,
        'cp',
        'cp.conversationId = m.conversationId AND cp.userId = :userId',
        { userId },
      )
      .where('m.senderId != :userId', { userId })
      .andWhere(
        `NOT JSON_CONTAINS(COALESCE(m.deliveredTo, JSON_ARRAY()), JSON_QUOTE(:userId), '$')`,
      )
      .setParameters({ userId })
      .take(500)
      .getMany();

    if (pendingMessages.length === 0) return {};

    await this.msgRepository
      .createQueryBuilder()
      .update(MessageEntity)
      .set({
        deliveredTo: () => `JSON_ARRAY_APPEND(COALESCE(deliveredTo, JSON_ARRAY()), '$', :userId)`,
      })
      .whereInIds(pendingMessages.map((m) => m.id))
      .setParameters({ userId })
      .execute();

    const groupedResult: Record<string, string[]> = {};

    pendingMessages.forEach((msg) => {
      if (!groupedResult[msg.conversationId]) {
        groupedResult[msg.conversationId] = [];
      }
      groupedResult[msg.conversationId].push(msg.id);
    });

    return groupedResult;
  }
}
