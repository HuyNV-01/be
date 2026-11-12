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
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import { createHmac } from 'crypto';
import Redis from 'ioredis';
import {
  CallStatusEnum,
  CallTypeEnum,
  ChannelTypeEnum,
  ConversationSupportStatusEnum,
  ConversationTypeEnum,
  DataScopeEnum,
  GroupRoleEnum,
  MediaTypeEnum,
  MembershipStatusEnum,
  MessageStatusEnum,
  MessageTypeEnum,
  NotificationResourceTypeEnum,
  NotificationTypeEnum,
  ShopRoleEnum,
  WebhookIntegrationStatusEnum,
} from 'src/common/enum';
import { ContactStatusEnum } from 'src/common/enum';
import { AdvancedQueryHelper } from 'src/common/helper/query.helper';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SocketStateService, UserPublicKeyBundle } from 'src/common/websocket/socket-state.service';
import { envs } from 'src/config/envs/envs';
import { ChatEventEnum, ChatMessageReadEvent } from 'src/config/websocket/events/chat.events';
import {
  NotificationConversationReadEvent,
  NotificationDispatchEvent,
  NotificationEventEnum,
} from 'src/config/websocket/events/notification.events';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  AddGroupMembersDto,
  EditMessageDto,
  ForwardMessageDto,
  PinMessageDto,
  ReactMessageDto,
  RecallMessageDto,
  RegisterPublicKeyDto,
} from 'src/dto/chat/call-and-security.dto';
import {
  GetSharedAssetsQueryDto,
  UpdateConversationSettingsDto,
  UpdateDisappearingMessagesDto,
  UpdateParticipantNicknameDto,
} from 'src/dto/chat/call-and-security.dto';
import {
  ClosePollDto,
  CreateGroupDto,
  CreatePollDto,
  SendMessageDto,
  VotePollDto,
} from 'src/dto/chat/chat.dto';
import { CreateDirectChatDto } from 'src/dto/chat/create-direct-chat.dto';
import { ChannelIntegrationEntity } from 'src/entity/channel-integration.entity';
import { ContactEntity } from 'src/entity/contact.entity';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { FileEntity } from 'src/entity/file.entity';
import { MediaEntity } from 'src/entity/media.entity';
import { MessageDirectionEnum, MessageEntity } from 'src/entity/message.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { UserEntity } from 'src/entity/user.entity';
import { IBaseQuery } from 'src/interface';
import {
  MessageAttachmentMeta,
  MessageMetadata,
  MessageReplyPreview,
} from 'src/interface/message.interface';
import { PaginationOptions } from 'src/types/query.types';
import { DataSource, In, Repository } from 'typeorm';
import { LessThanOrEqual } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { BufferedFile } from '../files/files.service';
import { MediaService } from '../media/media.service';
import { UserService } from '../user/user.service';
import { LinkPreviewService } from './services/link-preview.service';
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
    @InjectRepository(ContactEntity)
    private contactRepository: Repository<ContactEntity>,
    @InjectRepository(ShopMemberEntity)
    private shopMemberRepository: Repository<ShopMemberEntity>,
    @InjectRepository(ChannelIntegrationEntity)
    private channelRepository: Repository<ChannelIntegrationEntity>,
    @InjectRedis() private readonly redis: Redis,
    private dataSource: DataSource,
    private readonly userService: UserService,
    private readonly mediaService: MediaService,
    private readonly socketStateService: SocketStateService,
    private readonly realtimeEmitter: RealtimeEmitterService,
    private readonly messageCryptoService: MessageCryptoService,
    private readonly linkPreviewService: LinkPreviewService,
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
    let participant = await this.partRepository.findOne({
      where: { conversationId, userId },
    });
    if (participant) {
      return participant;
    }

    const conv = await this.convRepository.findOne({
      where: { id: conversationId },
      select: ['id', 'shopId', 'assignedAgentId', 'channelIntegrationId'],
    });

    if (conv?.shopId) {
      const member = await this.shopMemberRepository.findOne({
        where: {
          shopId: conv.shopId,
          userId,
          membershipStatus: MembershipStatusEnum.ACTIVE,
        },
      });

      const isAllowedChannel =
        !conv.channelIntegrationId ||
        !member?.allowedChannelIdsJson ||
        member.allowedChannelIdsJson.length === 0 ||
        member.allowedChannelIdsJson.includes(conv.channelIntegrationId);

      const isAuthorizedScope =
        member &&
        isAllowedChannel &&
        (member.role === ShopRoleEnum.SHOP_OWNER ||
          member.role === ShopRoleEnum.SHOP_MANAGER ||
          member.dataScope === DataScopeEnum.ALL_SHOP ||
          member.dataScope === DataScopeEnum.TEAM_SHIFT ||
          conv.assignedAgentId === userId ||
          (member.dataScope === DataScopeEnum.ASSIGNED_PLUS_POOL && !conv.assignedAgentId));

      if (isAuthorizedScope) {
        participant = this.partRepository.create({
          conversationId,
          userId,
          role: GroupRoleEnum.MEMBER,
          isAdmin:
            member.role === ShopRoleEnum.SHOP_OWNER || member.role === ShopRoleEnum.SHOP_MANAGER,
          isHidden: false,
          joinedAt: new Date(),
        });
        participant = await this.partRepository.save(participant);
        this.invalidateMembershipCache(conversationId, userId);
        return participant;
      }
    }

    throw new ForbiddenException('You are not a member of this conversation');
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
    let isTransactionCommitted = false;

    try {
      const participant = await this.ensureParticipant(dto.conversationId, senderId);
      await this.assertNotBlockedInConversation(dto.conversationId, senderId);

      const conversation = await queryRunner.manager.findOne(ConversationEntity, {
        where: { id: dto.conversationId },
        select: [
          'id',
          'name',
          'type',
          'disappearingTtl',
          'shopId',
          'channelIntegrationId',
          'channelType',
          'externalThreadId',
          'interactionType',
          'supportStatus',
          'assignedAgentId',
          'lastAgentReplyAt',
          'lastCustomerMessageAt',
          'accountabilityTimelineJson',
        ],
      });

      const now = new Date();
      const disappearingTtl =
        conversation?.disappearingTtl && conversation.disappearingTtl > 0
          ? conversation.disappearingTtl
          : null;
      const expiresAt = disappearingTtl ? new Date(now.getTime() + disappearingTtl * 1000) : null;

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
        ...(dto.mentionedUserIds?.length ? { mentionedUserIds: dto.mentionedUserIds } : {}),
        ...(dto.mentionAll ? { mentionAll: true } : {}),
        ...(expiresAt
          ? { expiresAt: expiresAt.toISOString(), disappearingTtl: disappearingTtl! }
          : {}),
      };

      const isInternalNoteMsg = Boolean(dto.metadata?.isInternalNote);
      const message = this.msgRepository.create({
        conversationId: dto.conversationId,
        senderId,
        shopId: conversation?.shopId || null,
        direction: isInternalNoteMsg
          ? MessageDirectionEnum.INTERNAL_NOTE
          : MessageDirectionEnum.OUTBOUND,
        isInternalNote: isInternalNoteMsg,
        content: encrypted.ciphertext,
        type: dto.type || MessageTypeEnum.TEXT,
        replyToMessageId: dto.replyToMessageId || null,
        clientTempId: dto.tempId ? dto.tempId.slice(0, 64) : null,
        isPinned: false,
        metadata,
        readBy: [senderId],
        deliveredTo: [senderId],
        status: MessageStatusEnum.SENT,
        expiresAt,
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

      if (!isInternalNoteMsg) {
        const currentTimeline = Array.isArray(conversation?.accountabilityTimelineJson)
          ? [...conversation.accountabilityTimelineJson]
          : [];
        const hasFrtRecorded = currentTimeline.some(
          (item) => item.eventCode === 'FIRST_AGENT_REPLY_FRT',
        );
        if (conversation?.shopId && !hasFrtRecorded) {
          const elapsedSec = conversation.lastCustomerMessageAt
            ? Math.max(
                0,
                Math.round(
                  (now.getTime() - new Date(conversation.lastCustomerMessageAt).getTime()) / 1000,
                ),
              )
            : 0;
          currentTimeline.push({
            eventCode: 'FIRST_AGENT_REPLY_FRT',
            actorUserId: senderId,
            elapsedSecondsFromInbound: elapsedSec,
            note: `Phản hồi đầu tiên sau ${elapsedSec}s`,
            timestamp: now.toISOString(),
          });
        }

        await queryRunner.manager.update(
          ConversationEntity,
          dto.conversationId,
          conversation?.shopId
            ? {
                lastMessage: encryptedLastMsg.ciphertext,
                lastMessageSenderId: senderId,
                lastMessageAt: savedMessage.createdAt,
                lastMessageType: dto.type || MessageTypeEnum.TEXT,
                lastAgentReplyAt: savedMessage.createdAt,
                slaDeadlineAt: null,
                isSlaBreached: false,
                isGhostedByAgent: false,
                snoozedUntilAt: null,
                supportStatus: ConversationSupportStatusEnum.WAITING_CUSTOMER_REPLY,
                assignedAgentId: conversation.assignedAgentId || senderId,
                accountabilityTimelineJson: currentTimeline,
              }
            : {
                lastMessage: encryptedLastMsg.ciphertext,
                lastMessageSenderId: senderId,
                lastMessageAt: savedMessage.createdAt,
                lastMessageType: dto.type || MessageTypeEnum.TEXT,
              },
        );
      }

      await queryRunner.manager.update(
        ConversationParticipantEntity,
        { conversationId: dto.conversationId },
        { isHidden: false },
      );

      await queryRunner.manager.update(ConversationParticipantEntity, participant.id, {
        lastReadAt: savedMessage.createdAt,
      });

      const participants = await this.partRepository.find({
        where: { conversationId: dto.conversationId },
        select: ['userId', 'isMuted', 'isRestricted', 'nickname'],
      });

      await queryRunner.commitTransaction();
      isTransactionCommitted = true;

      if (
        conversation?.shopId &&
        conversation.supportStatus === ConversationSupportStatusEnum.WAITING_AGENT_REPLY
      ) {
        const targetAgent = conversation.assignedAgentId || senderId;
        const currentLoad = await this.redis.zscore(
          `routing:active_load:${conversation.shopId}`,
          targetAgent,
        );
        if (currentLoad && Number(currentLoad) > 0) {
          await this.redis.zincrby(`routing:active_load:${conversation.shopId}`, -1, targetAgent);
        }

        if (conversation.channelIntegrationId) {
          participants.forEach((p) => {
            this.realtimeEmitter.emitToUser(
              SOCKET_CONFIG.namespaces.CHAT,
              p.userId,
              SOCKET_CONFIG.events.CHANNELS.INTEGRATION_UPDATED,
              {
                shopId: conversation.shopId,
                action: 'AGENT_REPLIED',
                channelId: conversation.channelIntegrationId,
                conversationId: conversation.id,
              },
            );
          });
        }
      }

      if (
        !isInternalNoteMsg &&
        !dto.metadata?.skipPlatformDispatch &&
        conversation?.channelIntegrationId &&
        conversation.shopId
      ) {
        await this.dispatchOutboundConversationMessageToPlatform({
          conversation,
          savedMessage,
          cleanContent,
          senderId,
          commentReplyMode: dto.metadata?.commentReplyMode,
          autoHideCommentOnReply: Boolean(dto.metadata?.autoHideCommentOnReply),
        }).catch((dispatchErr) => {
          this.logger.warn(
            `[sendMessage] Outbound platform dispatch warning: ${String(dispatchErr)}`,
          );
        });
      }

      const finalMessage = await this.buildEnrichedMessageResponse(savedMessage.id);
      this.logger.debug(`${label} messageId -> ${JSON.stringify(message.id)}`);

      const senderPart = participants.find((p) => p.userId === senderId);
      const unmutedRecipients = participants
        .filter((p) => p.userId !== senderId && !p.isMuted && !p.isRestricted)
        .map((p) => p.userId);

      if (unmutedRecipients.length > 0 && finalMessage) {
        const senderName = senderPart?.nickname || finalMessage.sender?.name || 'User';
        const isGroup = conversation?.type === ConversationTypeEnum.GROUP;
        const msgType = dto.type || MessageTypeEnum.TEXT;
        const previewText =
          msgType === MessageTypeEnum.IMAGE
            ? 'đã gửi một hình ảnh'
            : msgType === MessageTypeEnum.VIDEO
              ? 'đã gửi một video'
              : msgType === MessageTypeEnum.AUDIO
                ? 'đã gửi một tin nhắn thoại'
                : msgType === MessageTypeEnum.FILE
                  ? 'đã gửi một tệp đính kèm'
                  : cleanContent.slice(0, 120);

        const contentKey =
          msgType === MessageTypeEnum.IMAGE
            ? 'i18n.preview.image'
            : msgType === MessageTypeEnum.VIDEO
              ? 'i18n.preview.video'
              : msgType === MessageTypeEnum.AUDIO
                ? 'i18n.preview.audio'
                : msgType === MessageTypeEnum.FILE
                  ? 'i18n.preview.file'
                  : isGroup
                    ? 'i18n.newMessage.groupContent'
                    : 'i18n.newMessage.directContent';

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
                titleKey: isGroup
                  ? 'i18n.messageReply.groupTitle'
                  : 'i18n.messageReply.directTitle',
                contentKey,
                i18nParams: {
                  senderName,
                  conversationName: conversation?.name || '',
                  isGroup,
                  messageType: savedMessage.type,
                  preview: cleanContent.slice(0, 120),
                },
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
                titleKey: isGroup ? 'i18n.newMessage.groupTitle' : 'i18n.newMessage.directTitle',
                contentKey,
                i18nParams: {
                  senderName,
                  conversationName: conversation?.name || '',
                  isGroup,
                  messageType: savedMessage.type,
                  preview: cleanContent.slice(0, 120),
                },
              },
            }),
          );
        }
      }

      const isGroup = conversation?.type === ConversationTypeEnum.GROUP;
      if (
        (isGroup || Boolean(conversation?.shopId) || isInternalNoteMsg) &&
        finalMessage &&
        (dto.mentionAll || (dto.mentionedUserIds && dto.mentionedUserIds.length > 0))
      ) {
        const senderPart = participants.find((p) => p.userId === senderId);
        const senderName = senderPart?.nickname || finalMessage.sender?.name || 'Thành viên';
        const mentionedSet = new Set(dto.mentionedUserIds || []);

        const mentionTargets = participants
          .filter(
            (p) =>
              p.userId !== senderId &&
              !p.isRestricted &&
              (dto.mentionAll || mentionedSet.has(p.userId)),
          )
          .map((p) => p.userId);

        if (mentionTargets.length > 0) {
          this.eventEmitter.emit(
            NotificationEventEnum.DISPATCH,
            new NotificationDispatchEvent({
              recipientIds: mentionTargets,
              actorId: senderId,
              type: NotificationTypeEnum.MESSAGE_MENTION,
              title: `${senderName} đã nhắc đến bạn trong ${conversation?.name || 'nhóm'}`,
              content: cleanContent.slice(0, 120),
              resourceType: NotificationResourceTypeEnum.CONVERSATION,
              resourceId: dto.conversationId,
              dedupeKey: `msg_mention:${savedMessage.id}`,
              metadata: {
                conversationId: dto.conversationId,
                conversationName: conversation?.name,
                conversationType: conversation?.type,
                messageId: savedMessage.id,
                messageType: savedMessage.type,
                actionUrl: `/chat/${dto.conversationId}?messageId=${savedMessage.id}`,
                titleKey: 'i18n.messageMention.title',
                contentKey: 'i18n.messageMention.content',
                i18nParams: {
                  senderName,
                  conversationName: conversation?.name || '',
                  preview: cleanContent.slice(0, 120),
                },
              },
            }),
          );
        }
      }

      if ((dto.type === MessageTypeEnum.TEXT || !dto.type) && !metadata.linkPreview) {
        const firstUrl = this.linkPreviewService.extractFirstUrl(cleanContent);
        if (firstUrl) {
          void this.enrichMessageWithLinkPreview(savedMessage.id, dto.conversationId, firstUrl);
        }
      }

      return {
        message: { ...finalMessage, tempId: dto.tempId },
        recipientIds: participants.map((p) => p.userId),
        isDuplicate: false,
      };
    } catch (err) {
      if (!isTransactionCommitted) {
        await queryRunner.rollbackTransaction().catch(() => undefined);
      }
      throw err;
    } finally {
      await queryRunner.release().catch(() => undefined);
    }
  }

  private async enrichMessageWithLinkPreview(
    messageId: string,
    conversationId: string,
    url: string,
  ): Promise<void> {
    try {
      const preview = await this.linkPreviewService.fetchLinkPreview(url);
      if (!preview) return;

      const msg = await this.msgRepository.findOne({
        where: { id: messageId, conversationId },
      });
      if (!msg || msg.status === MessageStatusEnum.REMOVED) return;

      msg.metadata = {
        ...(msg.metadata || {}),
        linkPreview: preview,
      };
      await this.msgRepository.save(msg);

      this.eventEmitter.emit('chat.link_preview.ready', {
        conversationId,
        messageId,
        linkPreview: preview,
      });
    } catch (err) {
      this.logger.debug(`Async link preview enrichment skipped: ${String(err)}`);
    }
  }

  async createPollMessage(params: { senderId: string; dto: CreatePollDto }) {
    const { senderId, dto } = params;
    await this.ensureParticipant(dto.conversationId, senderId);
    await this.assertNotBlockedInConversation(dto.conversationId, senderId);

    const cleanOptions = dto.options
      .map((opt) => opt.trim())
      .filter(Boolean)
      .map((text) => ({
        id: uuidv4(),
        text,
        voterIds: [] as string[],
      }));

    if (cleanOptions.length < 2) {
      throw new BadRequestException('Cuộc bình chọn phải có ít nhất 2 phương án hợp lệ');
    }

    const sendRes = await this.sendMessage({
      senderId,
      dto: {
        conversationId: dto.conversationId,
        content: `📊 ${dto.question.trim()}`,
        type: MessageTypeEnum.POLL,
        metadata: {
          ...(dto.isPinned
            ? {
                isPinned: true,
                pinnedBy: senderId,
                pinnedAt: new Date().toISOString(),
              }
            : {}),
          poll: {
            question: dto.question.trim(),
            options: cleanOptions,
            allowMultipleAnswers: Boolean(dto.allowMultipleAnswers),
            isAnonymous: Boolean(dto.isAnonymous),
            isClosed: false,
          },
        },
      },
    });

    if (dto.isPinned && sendRes.message?.id) {
      await this.msgRepository.update(sendRes.message.id, { isPinned: true });
      sendRes.message.isPinned = true;
    }

    return sendRes;
  }

  async votePollMessage(params: { userId: string; dto: VotePollDto }) {
    const { userId, dto } = params;
    await this.ensureParticipant(dto.conversationId, userId);

    const message = await this.msgRepository.findOne({
      where: {
        id: dto.messageId,
        conversationId: dto.conversationId,
        type: MessageTypeEnum.POLL,
      },
    });

    if (!message || !message.metadata?.poll) {
      throw new NotFoundException('Không tìm thấy cuộc bình chọn');
    }

    const poll = message.metadata.poll;
    if (poll.isClosed) {
      throw new BadRequestException('Cuộc bình chọn này đã kết thúc');
    }

    const selectedSet = new Set(dto.optionIds);
    if (!poll.allowMultipleAnswers && selectedSet.size > 1) {
      throw new BadRequestException('Cuộc bình chọn này chỉ cho phép chọn 1 phương án');
    }

    const updatedOptions = poll.options.map((opt) => {
      const voters = new Set(opt.voterIds || []);
      if (selectedSet.has(opt.id)) {
        voters.add(userId);
      } else {
        voters.delete(userId);
      }
      return {
        ...opt,
        voterIds: Array.from(voters),
      };
    });

    const updatedPoll = {
      ...poll,
      options: updatedOptions,
    };

    message.metadata = {
      ...(message.metadata || {}),
      poll: updatedPoll,
    };

    await this.msgRepository.save(message);

    return {
      conversationId: dto.conversationId,
      messageId: message.id,
      poll: updatedPoll,
      votedBy: userId,
    };
  }

  async closePollMessage(params: { userId: string; dto: ClosePollDto }) {
    const { userId, dto } = params;
    const participant = await this.ensureParticipant(dto.conversationId, userId);

    const message = await this.msgRepository.findOne({
      where: {
        id: dto.messageId,
        conversationId: dto.conversationId,
        type: MessageTypeEnum.POLL,
      },
    });

    if (!message || !message.metadata?.poll) {
      throw new NotFoundException('Không tìm thấy cuộc bình chọn');
    }

    if (message.senderId !== userId && !participant.isAdmin) {
      throw new ForbiddenException(
        'Chỉ người tạo bình chọn hoặc Quản trị viên mới có thể khóa bình chọn',
      );
    }

    const updatedPoll = {
      ...message.metadata.poll,
      isClosed: true,
      closedAt: new Date().toISOString(),
      closedBy: userId,
    };

    message.metadata = {
      ...(message.metadata || {}),
      poll: updatedPoll,
    };

    await this.msgRepository.save(message);

    return {
      conversationId: dto.conversationId,
      messageId: message.id,
      poll: updatedPoll,
      closedBy: userId,
    };
  }

  async getOrCreateSavedMessages(userId: string) {
    const directKey = `self:${userId}`;
    const existing = await this.convRepository.findOne({
      where: { directKey },
    });

    if (existing) {
      await this.partRepository.update(
        { conversationId: existing.id, userId },
        { isHidden: false },
      );
      return this.enrichSavedMessagesInfo(existing, userId);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const now = new Date();
      const conv = this.convRepository.create({
        type: ConversationTypeEnum.DIRECT,
        name: 'Cloud của tôi',
        directKey,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const savedConv = await queryRunner.manager.save(conv);

      const selfParticipant = this.partRepository.create({
        conversationId: savedConv.id,
        userId,
        isAdmin: true,
        joinedAt: now,
        lastReadAt: now,
      });
      await queryRunner.manager.save(selfParticipant);
      await queryRunner.commitTransaction();

      return this.enrichSavedMessagesInfo(savedConv, userId);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      const fallback = await this.convRepository.findOne({ where: { directKey } });
      if (fallback) return this.enrichSavedMessagesInfo(fallback, userId);
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  private enrichSavedMessagesInfo(conversation: ConversationEntity, userId: string) {
    return {
      ...conversation,
      name: conversation.name || 'Cloud của tôi',
      partnerId: userId,
      isSavedMessages: true,
      isOnline: true,
      unreadCount: 0,
      lastMessage: conversation.lastMessage
        ? this.messageCryptoService.decryptForConversation(
            conversation.lastMessage,
            conversation.id,
          )
        : null,
      lastMessageAt: conversation.lastMessageAt
        ? new Date(conversation.lastMessageAt).toISOString()
        : new Date().toISOString(),
    };
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
    await this.assertNotBlockedInConversation(params.conversationId, params.senderId);

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

  /**
   * Tạo URL ảnh đại diện định danh theo tên khách hàng khi nền tảng ngoại vi (Meta PSID / Zalo OA)
   * không trả về `profile_pic`, giúp khung hội thoại luôn hiển thị avatar khách hàng đồng nhất.
   */
  public buildCustomerFallbackAvatarUrl(name?: string | null): string {
    const cleanName = (name || 'Khách hàng').trim();
    return `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(cleanName)}&backgroundType=gradientLinear`;
  }

  async editMessage(payload: { userId: string; dto: EditMessageDto }) {
    const { userId, dto } = payload;
    await this.ensureParticipant(dto.conversationId, userId);

    const [message, conversation] = await Promise.all([
      this.msgRepository.findOne({
        where: { id: dto.messageId, conversationId: dto.conversationId },
      }),
      this.convRepository.findOne({
        where: { id: dto.conversationId },
      }),
    ]);
    if (!message) throw new NotFoundException('Message not found');
    if (message.senderId !== userId) {
      throw new ForbiddenException('Only the sender can edit this message');
    }
    if (message.status === MessageStatusEnum.REMOVED) {
      throw new BadRequestException('Cannot edit a recalled message');
    }

    const cleanContent = dto.content.trim();
    const previousPlaintext = this.messageCryptoService.decryptForConversation(
      message.content,
      dto.conversationId,
    );
    const encrypted = this.messageCryptoService.encryptForConversation(
      cleanContent,
      dto.conversationId,
    );

    const nowIso = new Date().toISOString();
    message.content = encrypted.ciphertext;
    message.metadata = {
      ...(message.metadata || {}),
      isEncrypted: true,
      encryptionAlg: 'AES-256-GCM',
      isEdited: true,
      editedAt: nowIso,
      originalTextBeforePlatformEdit:
        message.metadata?.originalTextBeforePlatformEdit || previousPlaintext,
    };

    await this.msgRepository.save(message);

    // Lý do nghiệp vụ: Khi người bán sửa tin nhắn/bình luận đã gửi cho khách hàng trên hội thoại đa kênh
    // (Facebook Messenger, Bình luận bài viết, Instagram, Zalo OA), hệ thống phải tự động đẩy nội dung cập nhật
    // ra nền tảng ngoại vi để khách hàng thực sự nhận được nội dung đã sửa.
    const isInternalNoteMsg = Boolean(
      message.isInternalNote ||
        message.metadata?.isInternalNote ||
        message.direction === MessageDirectionEnum.INTERNAL_NOTE,
    );
    if (
      !isInternalNoteMsg &&
      conversation?.channelIntegrationId &&
      conversation.shopId &&
      message.direction !== MessageDirectionEnum.INBOUND
    ) {
      await this.dispatchOutboundEditedMessageToPlatform({
        conversation,
        message,
        cleanContent,
      });
    }

    const latestMsg = await this.msgRepository.findOne({
      where: { conversationId: dto.conversationId },
      order: { createdAt: 'DESC' },
      select: ['id'],
    });
    const isLastMessage = Boolean(latestMsg && latestMsg.id === message.id);
    if (isLastMessage) {
      await this.convRepository.update(dto.conversationId, {
        lastMessage: encrypted.ciphertext,
      });
    }

    const enriched = await this.buildEnrichedMessageResponse(message.id);
    const recipientIds = await this.getConversationMemberIds(dto.conversationId);

    return {
      message: enriched ? { ...enriched, isLastMessage } : enriched,
      recipientIds,
    };
  }

  async recallMessage(payload: { userId: string; dto: RecallMessageDto }) {
    const { userId, dto } = payload;
    const participant = await this.ensureParticipant(dto.conversationId, userId);

    const [message, conversation] = await Promise.all([
      this.msgRepository.findOne({
        where: { id: dto.messageId, conversationId: dto.conversationId },
      }),
      this.convRepository.findOne({
        where: { id: dto.conversationId },
      }),
    ]);
    if (!message) throw new NotFoundException('Message not found');

    if (message.senderId !== userId && !participant.isAdmin) {
      throw new ForbiddenException('You do not have permission to recall this message');
    }

    // Nếu thu hồi một bình luận phản hồi đã gửi ra bài viết Facebook/Instagram, tự động xóa luôn bình luận đó trên nền tảng
    const externalTargetToDelete =
      message.metadata?.platformEditedExternalId ||
      message.metadata?.platformExternalId ||
      message.externalMessageId;
    if (
      conversation?.channelIntegrationId &&
      conversation.shopId &&
      (conversation.interactionType === 'COMMENT' ||
        conversation.interactionType === 'LIVESTREAM') &&
      externalTargetToDelete &&
      !externalTargetToDelete.startsWith('ext_')
    ) {
      await this.executePlatformHttpCall({
        channelIntegrationId: conversation.channelIntegrationId,
        shopId: conversation.shopId,
        actionType: 'DELETE_COMMENT',
        targetExternalId: externalTargetToDelete,
      }).catch(() => null);
    }

    const recalledPlaceholder = this.messageCryptoService.encryptForConversation(
      '[Tin nhắn đã được thu hồi]',
      dto.conversationId,
    );

    message.content = recalledPlaceholder.ciphertext;
    message.status = MessageStatusEnum.REMOVED;
    message.isPinned = false;
    message.metadata = {
      ...(message.metadata || {}),
      isEncrypted: true,
      encryptionAlg: 'AES-256-GCM',
      isPinned: false,
      attachments: [],
    };

    await this.msgRepository.save(message);

    const latestMsg = await this.msgRepository.findOne({
      where: { conversationId: dto.conversationId },
      order: { createdAt: 'DESC' },
      select: ['id'],
    });
    const isLastMessage = Boolean(latestMsg && latestMsg.id === message.id);
    if (isLastMessage) {
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
      isLastMessage,
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
              titleKey: 'i18n.messageReaction.title',
              contentKey: 'i18n.messageReaction.content',
              i18nParams: {
                actorName,
                emoji: dto.emoji,
                preview: decryptedPreview,
              },
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
              titleKey: 'i18n.missedCall.title',
              contentKey: 'i18n.missedCall.content',
              i18nParams: {
                callerName,
                callType: params.callType,
              },
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
            titleKey: 'i18n.groupMemberAdded.title',
            contentKey: 'i18n.groupMemberAdded.content',
            i18nParams: {
              requesterName,
              conversationName: conv.name || '',
            },
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
    const targetPart = await this.ensureParticipant(params.conversationId, params.targetUserId);

    const requesterRole = this.resolveEffectiveRole(requesterPart);
    const targetRole = this.resolveEffectiveRole(targetPart);
    const isSelfLeave = params.requesterId === params.targetUserId;

    if (!isSelfLeave) {
      if (!this.isModeratorOrOwner(requesterPart)) {
        throw new ForbiddenException(
          'Chỉ Trưởng nhóm hoặc Quản trị viên mới có quyền xóa thành viên',
        );
      }
      if (targetRole === GroupRoleEnum.OWNER) {
        throw new ForbiddenException('Không thể xóa Trưởng nhóm khỏi cuộc trò chuyện');
      }
      if (requesterRole === GroupRoleEnum.ADMIN && targetRole === GroupRoleEnum.ADMIN) {
        throw new ForbiddenException('Chỉ Trưởng nhóm mới có quyền xóa Quản trị viên khác');
      }
    }

    let newOwnerUserId: string | null = null;
    if (isSelfLeave && requesterRole === GroupRoleEnum.OWNER) {
      const remainingMembers = await this.partRepository.find({
        where: { conversationId: params.conversationId },
        order: { isAdmin: 'DESC', joinedAt: 'ASC' },
      });
      const candidate = remainingMembers.find((m) => m.userId !== params.requesterId);
      if (candidate) {
        candidate.role = GroupRoleEnum.OWNER;
        candidate.isAdmin = true;
        await this.partRepository.save(candidate);
        newOwnerUserId = candidate.userId;
      }
    }

    await this.partRepository.delete({
      conversationId: params.conversationId,
      userId: params.targetUserId,
    });
    this.invalidateMembershipCache(params.conversationId, params.targetUserId);

    return {
      conversationId: params.conversationId,
      removedUserId: params.targetUserId,
      newOwnerUserId,
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

    let sender = fullMessage.sender as any;
    if (sender) {
      const avatarUrl = sender.avatarMedia?.file?.url || null;
      delete sender.avatarMedia;
      sender.avatar = avatarUrl;
    } else {
      const conv = await this.convRepository.findOne({
        where: { id: fullMessage.conversationId },
        select: ['id', 'name', 'avatar'],
      });
      const fallbackExtName =
        (fullMessage.metadata as any)?.externalCustomerName ||
        (fullMessage.metadata as any)?.marketplaceOrder?.buyerUsername ||
        conv?.name ||
        'Khách hàng';
      const fallbackExtAvatar =
        (fullMessage.metadata as any)?.externalCustomerAvatar ||
        conv?.avatar ||
        this.buildCustomerFallbackAvatarUrl(fallbackExtName);
      sender = {
        id: fullMessage.senderId,
        name: fallbackExtName,
        originalName: fallbackExtName,
        email: '',
        nickname: null,
        avatar: fallbackExtAvatar,
      };
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

    const [myPart, convInfo, allParts] = await Promise.all([
      this.ensureParticipant(conversationId, userId),
      this.convRepository.findOne({
        where: { id: conversationId },
        select: ['id', 'name', 'avatar', 'channelType', 'interactionType'],
      }),
      this.partRepository.find({
        where: { conversationId },
        select: ['userId', 'nickname', 'readReceiptsEnabled', 'isRestricted'],
      }),
    ]);
    const nicknameMap = new Map<string, string>();
    const privacyHideReadSet = new Set<string>();
    allParts.forEach((p) => {
      if (p.nickname) nicknameMap.set(p.userId, p.nickname);
      if (!p.readReceiptsEnabled || p.isRestricted) {
        privacyHideReadSet.add(p.userId);
      }
    });

    const helper = AdvancedQueryHelper.from(this.msgRepository, 'm')
      .filter({ conversationId })
      .leftJoinRelation('sender', 'sender')
      .addSelect(['sender.id', 'sender.name']);

    if (myPart.clearedAt) {
      helper.getBuilder().andWhere('m.createdAt > :clearedAt', {
        clearedAt: myPart.clearedAt,
      });
    }

    helper.getBuilder().andWhere('(m.expiresAt IS NULL OR m.expiresAt > :nowTime)', {
      nowTime: new Date(),
    });

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
          if (id !== userId && !privacyHideReadSet.has(id)) {
            readerIds.add(id);
          }
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
      const senderNickname = sender?.id ? nicknameMap.get(sender.id) : null;
      const fallbackExtName =
        (msg.metadata as any)?.externalCustomerName ||
        (msg.metadata as any)?.marketplaceOrder?.buyerUsername ||
        convInfo?.name ||
        'Khách hàng';
      const fallbackExtAvatar =
        (msg.metadata as any)?.externalCustomerAvatar ||
        convInfo?.avatar ||
        this.buildCustomerFallbackAvatarUrl(fallbackExtName);
      const cleanSender = sender?.id
        ? {
            ...sender,
            name: senderNickname || sender?.name,
            originalName: sender?.name,
            nickname: senderNickname || null,
            avatar: avatarUrl,
          }
        : {
            id: msg.senderId,
            name: fallbackExtName,
            originalName: fallbackExtName,
            email: '',
            nickname: null,
            avatar: fallbackExtAvatar,
          };

      const computedStatus = this.computeStatus(
        msg as MessageEntity,
        userId,
        Boolean(myPart.readReceiptsEnabled && !myPart.isRestricted),
        privacyHideReadSet,
      );
      const decryptedContent = this.messageCryptoService.decryptForConversation(
        msg.content as string,
        conversationId,
      );

      let readByUsers: { id: string; name: string; avatar: string | null }[] = [];

      if (myPart.readReceiptsEnabled && Array.isArray(msg.readBy)) {
        readByUsers = (msg.readBy as string[])
          .filter((id) => !privacyHideReadSet.has(id))
          .map((id: string) => {
            const u = userMap.get(id);
            if (!u) return null;
            const userWithAvatar = u as any;
            return {
              id: u.id,
              name: nicknameMap.get(u.id) || u.name,
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
        expiresAt: msg.expiresAt ? new Date(msg.expiresAt).toISOString() : null,
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
          role: uid === creatorId ? GroupRoleEnum.OWNER : GroupRoleEnum.MEMBER,
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
              titleKey: 'i18n.groupInvite.title',
              contentKey: 'i18n.groupInvite.content',
              i18nParams: {
                creatorName,
                conversationName: savedConv.name || '',
              },
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
    const nowTime = new Date();

    const helper = AdvancedQueryHelper.from(this.convRepository, 'c');

    helper
      .joinRelation('participants', 'mp', {
        str: 'mp.userId = :userId AND (mp.isHidden = false OR mp.isHidden IS NULL)',
        params: { userId },
      })
      .addSelect([
        'mp.isAdmin',
        'mp.isMuted',
        'mp.soundEnabled',
        'mp.readReceiptsEnabled',
        'mp.isRestricted',
        'mp.nickname',
        'mp.clearedAt',
        'mp.joinedAt',
        'mp.lastReadAt',
      ])
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
      .leftJoinEntity(
        ConversationParticipantEntity,
        'cp_partner',
        'cp_partner.conversationId = c.id AND cp_partner.userId != :userId AND c.type = :typeDirect',
        { userId, typeDirect: ConversationTypeEnum.DIRECT },
      )
      .leftJoinEntity(
        ContactEntity,
        'c_contact',
        'c_contact.userId = :userId AND c_contact.contactId = u_partner.id AND c_contact.deletedAt IS NULL',
        { userId },
      )
      .selectSubQuery('unreadCount', (sub, parentAlias) => {
        return sub
          .select('COUNT(m.id)', 'count')
          .from(MessageEntity, 'm')
          .where(`m.conversationId = ${parentAlias}.id`)
          .andWhere('m.senderId != :userId')
          .andWhere('m.status != :removedStatus', {
            removedStatus: MessageStatusEnum.REMOVED,
          })
          .andWhere('(m.expiresAt IS NULL OR m.expiresAt > :nowTime)', { nowTime })
          .andWhere('(mp.clearedAt IS NULL OR m.createdAt > mp.clearedAt)')
          .andWhere('(mp.joinedAt IS NULL OR m.createdAt >= mp.joinedAt)')
          .andWhere('(mp.lastReadAt IS NULL OR m.createdAt > mp.lastReadAt)');
      });

    if (query.search) {
      // Lý do nghiệp vụ:
      // 1. Trò chuyện 1-1 (DIRECT): Tìm kiếm theo 3 trường (tên hiển thị, biệt danh hội thoại/danh bạ, email) và ẩn người dùng đang chặn/bị chặn.
      // 2. Trò chuyện nhóm (GROUP): Chỉ tìm kiếm theo tên nhóm (c.name), tuyệt đối không tìm theo email hay biệt danh thành viên.
      helper.smartSearch(query.search, (builder) => {
        builder
          .matchCase(
            `c.type = :searchTypeDirect AND NOT EXISTS (
              SELECT 1 FROM contacts c_blk
              WHERE c_blk.deleted_at IS NULL
                AND c_blk.status = :blockedStatusSearch
                AND (
                  (c_blk.userId = :userId AND c_blk.contactId = u_partner.id)
                  OR (c_blk.userId = u_partner.id AND c_blk.contactId = :userId)
                )
            )`,
            {
              searchTypeDirect: ConversationTypeEnum.DIRECT,
              blockedStatusSearch: ContactStatusEnum.BLOCKED,
              userId,
            },
            ['u_partner.name', 'cp_partner.nickname', 'c_contact.alias', 'u_partner.email'],
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

    const convIds: string[] = result.data.map((c: any) => String(c.id));
    const partnerIds: string[] = result.data
      .filter((c: any) => c.type === ConversationTypeEnum.DIRECT && c.partnerUser)
      .map((c: any) => String(c.partnerUser.id));

    const [onlineSet, allConvParticipants, blockRecords] = await Promise.all([
      this.socketStateService.getOnlineUsers(partnerIds),
      convIds.length > 0
        ? this.partRepository.find({
            where: { conversationId: In(convIds) },
            select: ['conversationId', 'userId', 'nickname', 'isRestricted', 'readReceiptsEnabled'],
          })
        : Promise.resolve([]),
      partnerIds.length > 0
        ? this.contactRepository.find({
            where: [
              { userId, contactId: In(partnerIds), status: ContactStatusEnum.BLOCKED },
              { userId: In(partnerIds), contactId: userId, status: ContactStatusEnum.BLOCKED },
            ],
            select: ['userId', 'contactId', 'status'],
          })
        : Promise.resolve([]),
    ]);

    const partnerPartMap = new Map<string, ConversationParticipantEntity>();
    const privacyHideReadByConv = new Map<string, Set<string>>();

    allConvParticipants.forEach((p) => {
      if (p.userId !== userId) {
        partnerPartMap.set(`${p.conversationId}:${p.userId}`, p);
      }
      if (!p.readReceiptsEnabled || p.isRestricted) {
        const set = privacyHideReadByConv.get(p.conversationId) || new Set<string>();
        set.add(p.userId);
        privacyHideReadByConv.set(p.conversationId, set);
      }
    });

    const blockedPartnerSet = new Set<string>();
    const blockedByMeSet = new Set<string>();
    const blockedByPartnerSet = new Set<string>();
    blockRecords.forEach((r) => {
      if (r.userId === userId) {
        blockedByMeSet.add(r.contactId);
        blockedPartnerSet.add(r.contactId);
      } else {
        blockedByPartnerSet.add(r.userId);
        blockedPartnerSet.add(r.userId);
      }
    });

    // Truy vấn tin nhắn hợp lệ mới nhất (chưa hết hạn tự hủy & sau thời điểm clearedAt)
    const latestValidMsgByConv = new Map<string, MessageEntity>();
    if (convIds.length > 0) {
      await Promise.all(
        result.data.map(async (conv: any) => {
          const myPart = conv.participants?.[0];
          const qb = this.msgRepository
            .createQueryBuilder('m')
            .where('m.conversationId = :convId', { convId: conv.id })
            .andWhere('(m.expiresAt IS NULL OR m.expiresAt > :nowTime)', { nowTime });

          if (myPart?.clearedAt) {
            qb.andWhere('m.createdAt > :clearedAt', { clearedAt: myPart.clearedAt });
          }

          const latestMsg = await qb.orderBy('m.createdAt', 'DESC').getOne();
          if (latestMsg) {
            latestValidMsgByConv.set(String(conv.id), latestMsg);
          }
        }),
      );
    }

    const finalData = result.data.map((conv: any) => {
      const myParticipant = conv.participants?.[0];
      let isOnline = false;
      let avatar =
        conv.avatar ||
        (conv.shopId && conv.name ? this.buildCustomerFallbackAvatarUrl(conv.name) : null);
      let originalName: string | undefined;
      let partnerNickname: string | null = null;
      let partnerEmail: string | null = null;
      let isBlocked = false;
      let blockedByMe = false;
      let blockedByPartner = false;

      const isSavedMessages = conv.directKey === `self:${userId}`;
      if (isSavedMessages) {
        conv.name = conv.name || 'Cloud của tôi';
        conv.partnerId = userId;
        isOnline = true;
      } else if (conv.type === ConversationTypeEnum.DIRECT && conv.partnerUser) {
        const partnerIdStr = String(conv.partnerUser.id);
        const partnerPart = partnerPartMap.get(`${conv.id}:${partnerIdStr}`);
        partnerNickname = partnerPart?.nickname || null;
        originalName = conv.partnerUser.name;
        partnerEmail = conv.partnerUser.email || null;
        blockedByMe = blockedByMeSet.has(partnerIdStr);
        blockedByPartner = blockedByPartnerSet.has(partnerIdStr);
        isBlocked = blockedByMe || blockedByPartner;
        // Ưu tiên hiển thị biệt danh được đặt trong hội thoại 1-1
        conv.name = partnerNickname || conv.partnerUser.name;
        avatar = conv.partnerUser.avatarMedia?.file?.url || null;
        conv.partnerId = partnerIdStr;

        // Lý do nghiệp vụ: Khi đối phương bật hạn chế (partnerPart.isRestricted) hoặc có chặn 2 chiều,
        // ẩn trạng thái Online của đối phương đối với người dùng hiện tại.
        // Ngược lại, nếu chính mình hạn chế đối phương (myParticipant.isRestricted), mình vẫn thấy đối phương Online.
        const isPartnerHidingPresence =
          Boolean(partnerPart?.isRestricted) || blockedPartnerSet.has(partnerIdStr);
        isOnline = isPartnerHidingPresence ? false : onlineSet.has(partnerIdStr);
      }

      const validLatestMsg = latestValidMsgByConv.get(String(conv.id));
      let decryptedLastMessage: string | null = null;
      let effectiveLastMessageAt: string | null = conv.createdAt
        ? new Date(conv.createdAt).toISOString()
        : null;
      let effectiveLastMessageType: string | null = null;
      let effectiveLastMessageSenderId: string | null = null;
      let effectiveLastMessageStatus: MessageStatusEnum | null = null;
      let lastMessageExpiresAt: string | null = null;

      if (validLatestMsg) {
        const rawDecrypted = this.messageCryptoService.decryptForConversation(
          validLatestMsg.content,
          String(conv.id),
        );
        decryptedLastMessage =
          validLatestMsg.status === MessageStatusEnum.REMOVED
            ? '[Tin nhắn đã được thu hồi]'
            : validLatestMsg.type === MessageTypeEnum.TEXT ||
                validLatestMsg.type === MessageTypeEnum.CALL ||
                validLatestMsg.type === MessageTypeEnum.POLL
              ? rawDecrypted
              : `[${validLatestMsg.type}] ${rawDecrypted || ''}`.trim();
        effectiveLastMessageAt = validLatestMsg.createdAt
          ? new Date(validLatestMsg.createdAt).toISOString()
          : effectiveLastMessageAt;
        effectiveLastMessageType = validLatestMsg.type;
        effectiveLastMessageSenderId = validLatestMsg.senderId;
        lastMessageExpiresAt = validLatestMsg.expiresAt
          ? new Date(validLatestMsg.expiresAt).toISOString()
          : null;
        effectiveLastMessageStatus = this.computeStatus(
          validLatestMsg,
          userId,
          Boolean((myParticipant?.readReceiptsEnabled ?? true) && !myParticipant?.isRestricted),
          privacyHideReadByConv.get(String(conv.id)),
        );
      }

      delete conv.partner;
      delete conv.partnerUser;
      delete conv.participants;

      return {
        ...conv,
        originalName,
        partnerNickname,
        partnerEmail,
        isBlocked,
        blockedByMe,
        blockedByPartner,
        isSavedMessages,
        unreadCount: Math.max(0, Number(conv.unreadCount || 0)),
        lastMessage: decryptedLastMessage,
        lastMessageAt: effectiveLastMessageAt,
        lastMessageType: effectiveLastMessageType,
        lastMessageSenderId: effectiveLastMessageSenderId,
        lastMessageStatus: effectiveLastMessageStatus,
        lastMessageExpiresAt,
        isOnline,
        avatar,
        isAdmin: myParticipant?.isAdmin || false,
        isMuted: myParticipant?.isMuted || false,
        soundEnabled: myParticipant?.soundEnabled ?? true,
        readReceiptsEnabled: myParticipant?.readReceiptsEnabled ?? true,
        isRestricted: myParticipant?.isRestricted || false,
        disappearingTtl: conv.disappearingTtl || null,
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

  async getVisiblePresenceRecipientIds(userId: string): Promise<string[]> {
    const allRelatedIds = await this.getRelatedUserIds(userId);
    if (allRelatedIds.length === 0) return [];

    const restrictedRows = await this.partRepository
      .createQueryBuilder('target')
      .select('DISTINCT target.userId', 'userId')
      .innerJoin(
        ConversationParticipantEntity,
        'me',
        'me.conversationId = target.conversationId AND me.userId = :userId AND me.isRestricted = :isRestricted',
        { userId, isRestricted: true },
      )
      .innerJoin(ConversationEntity, 'c', 'c.id = target.conversationId AND c.type = :directType', {
        directType: ConversationTypeEnum.DIRECT,
      })
      .where('target.userId != :userId', { userId })
      .getRawMany<{ userId: string }>();

    const blockRecords = await this.contactRepository.find({
      where: [
        { userId, contactId: In(allRelatedIds), status: ContactStatusEnum.BLOCKED },
        { userId: In(allRelatedIds), contactId: userId, status: ContactStatusEnum.BLOCKED },
      ],
      select: ['userId', 'contactId'],
    });

    const hiddenSet = new Set<string>(restrictedRows.map((r) => r.userId));
    blockRecords.forEach((b) => {
      hiddenSet.add(b.userId === userId ? b.contactId : b.userId);
    });

    return allRelatedIds.filter((id) => !hiddenSet.has(id));
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

    const existingBlock = await this.contactRepository.findOne({
      where: [
        { userId: senderId, contactId: receiverId, status: ContactStatusEnum.BLOCKED },
        { userId: receiverId, contactId: senderId, status: ContactStatusEnum.BLOCKED },
      ],
    });
    if (existingBlock) {
      throw new ForbiddenException(
        existingBlock.userId === senderId
          ? 'Bạn đã chặn người dùng này. Hãy bỏ chặn để bắt đầu cuộc trò chuyện.'
          : 'Bạn không thể nhắn tin cho người dùng này.',
      );
    }

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
    const [partnerUsers, onlineSet, partnerPart, latestValidMsg] = await Promise.all([
      this.userService.getBasicUsersInfo([partnerId]),
      this.socketStateService.getOnlineUsers([partnerId]),
      this.partRepository.findOne({
        where: { conversationId: conversation.id, userId: partnerId },
        select: ['nickname', 'isRestricted'],
      }),
      this.msgRepository
        .createQueryBuilder('m')
        .where('m.conversationId = :convId', { convId: conversation.id })
        .andWhere('(m.expiresAt IS NULL OR m.expiresAt > :nowTime)', { nowTime: new Date() })
        .orderBy('m.createdAt', 'DESC')
        .getOne(),
    ]);
    const partner = partnerUsers[0] as any;
    const displayName = partnerPart?.nickname || partner?.name || conversation.name;
    const isPartnerOnline = partnerPart?.isRestricted ? false : onlineSet.has(partnerId);

    return {
      ...conversation,
      name: displayName,
      originalName: partner?.name || conversation.name,
      partnerNickname: partnerPart?.nickname || null,
      avatar: partner?.avatarMedia?.file?.url || conversation.avatar || null,
      partnerId,
      unreadCount: 0,
      isOnline: isPartnerOnline,
      lastMessage: latestValidMsg
        ? this.messageCryptoService.decryptForConversation(latestValidMsg.content, conversation.id)
        : null,
      lastMessageAt: latestValidMsg?.createdAt
        ? new Date(latestValidMsg.createdAt).toISOString()
        : conversation.lastMessageAt
          ? new Date(conversation.lastMessageAt).toISOString()
          : new Date().toISOString(),
      lastMessageExpiresAt: latestValidMsg?.expiresAt
        ? new Date(latestValidMsg.expiresAt).toISOString()
        : null,
      partnerInfo: partner
        ? {
            id: partner.id,
            name: partner.name,
            nickname: partnerPart?.nickname || null,
            avatar: partner?.avatarMedia?.file?.url || null,
          }
        : null,
    };
  }

  async markConversationAsRead(payload: { userId: string; conversationId: string }) {
    const { conversationId, userId } = payload;
    const participant = await this.ensureParticipant(conversationId, userId);
    const now = new Date();

    await this.partRepository.update({ conversationId, userId }, { lastReadAt: now });

    await this.convRepository
      .createQueryBuilder()
      .update(ConversationEntity)
      .set({
        firstSeenAt: now,
        firstSeenByAgentId: userId,
      })
      .where('id = :conversationId', { conversationId })
      .andWhere('shop_id IS NOT NULL')
      .andWhere('first_seen_at IS NULL')
      .execute();

    this.eventEmitter.emit(
      NotificationEventEnum.MARK_CONVERSATION_READ,
      new NotificationConversationReadEvent(userId, conversationId),
    );

    await this.msgRepository
      .createQueryBuilder()
      .update(MessageEntity)
      .set({
        deliveredTo: () => `JSON_ARRAY_APPEND(COALESCE(deliveredTo, JSON_ARRAY()), '$', :userId)`,
      })
      .where('conversationId = :conversationId', { conversationId })
      .andWhere('senderId != :userId', { userId })
      .andWhere(`NOT JSON_CONTAINS(COALESCE(deliveredTo, JSON_ARRAY()), JSON_QUOTE(:userId), '$')`)
      .setParameters({ userId, conversationId })
      .execute();

    if (!participant.readReceiptsEnabled || participant.isRestricted) {
      return {
        success: true,
        lastReadAt: now.toISOString(),
        readReceiptSent: false,
      };
    }

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

    const [users, memberIds] = await Promise.all([
      this.userService.getBasicUsersInfo([userId]),
      this.getConversationMemberIds(conversationId),
    ]);
    const user = users[0];

    const userReaderInfo = user
      ? {
          id: user.id,
          name: participant.nickname || user.name,
          avatar: ((user as any).avatarMedia?.file?.url as string) || null,
        }
      : { id: userId, name: 'Unknown', avatar: null };

    const event = new ChatMessageReadEvent(conversationId, userId, now, userReaderInfo, memberIds);
    this.eventEmitter.emit(ChatEventEnum.MESSAGE_READ, event);

    return {
      success: true,
      lastReadAt: now.toISOString(),
      readReceiptSent: true,
    };
  }

  async markAsDelivered(payload: { userId: string; messageId: string }) {
    const { userId, messageId } = payload;

    const msg = await this.msgRepository.findOne({
      where: { id: messageId },
      select: ['id', 'senderId', 'conversationId'],
    });
    if (!msg || msg.senderId === userId) {
      return { success: true, senderId: null };
    }

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

    return {
      success: true,
      senderId: msg.senderId,
      conversationId: msg.conversationId,
    };
  }

  private computeStatus(
    msg: MessageEntity,
    currentUserId: string,
    canSeeReadReceipts = true,
    privacyHideReadSet?: Set<string>,
  ): MessageStatusEnum {
    if (msg.status === MessageStatusEnum.REMOVED) return MessageStatusEnum.REMOVED;
    if (msg.status === MessageStatusEnum.FAILED) return MessageStatusEnum.FAILED;

    if (msg.senderId !== currentUserId) return MessageStatusEnum.READ;

    const hasVisibleRead =
      canSeeReadReceipts &&
      msg.readBy?.some((id) => id !== currentUserId && !privacyHideReadSet?.has(id));
    if (hasVisibleRead) return MessageStatusEnum.READ;

    const hasDelivered =
      msg.deliveredTo?.some((id) => id !== currentUserId) ||
      msg.readBy?.some((id) => id !== currentUserId);
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

  async checkDirectBlockStatus(
    conversationId: string,
    requesterId: string,
  ): Promise<{
    isBlocked: boolean;
    blockedByMe: boolean;
    blockedByPartner: boolean;
    partnerId: string | null;
  }> {
    const conv = await this.convRepository.findOne({
      where: { id: conversationId },
      select: ['id', 'type'],
    });
    if (!conv || conv.type !== ConversationTypeEnum.DIRECT) {
      return { isBlocked: false, blockedByMe: false, blockedByPartner: false, partnerId: null };
    }

    const parts = await this.partRepository.find({
      where: { conversationId },
      select: ['userId'],
    });
    const partner = parts.find((p) => p.userId !== requesterId);
    if (!partner) {
      return { isBlocked: false, blockedByMe: false, blockedByPartner: false, partnerId: null };
    }

    const blockRecords = await this.contactRepository.find({
      where: [
        { userId: requesterId, contactId: partner.userId, status: ContactStatusEnum.BLOCKED },
        { userId: partner.userId, contactId: requesterId, status: ContactStatusEnum.BLOCKED },
      ],
    });

    const blockedByMe = blockRecords.some((r) => r.userId === requesterId);
    const blockedByPartner = blockRecords.some((r) => r.userId === partner.userId);

    return {
      isBlocked: blockedByMe || blockedByPartner,
      blockedByMe,
      blockedByPartner,
      partnerId: partner.userId,
    };
  }

  async assertNotBlockedInConversation(conversationId: string, userId: string): Promise<void> {
    const blockState = await this.checkDirectBlockStatus(conversationId, userId);
    if (blockState.blockedByMe) {
      throw new ForbiddenException(
        'You have blocked this user. Unblock them to continue messaging or calling.',
      );
    }
    if (blockState.blockedByPartner) {
      throw new ForbiddenException('You cannot send messages or make calls to this user.');
    }
  }

  async getPinnedMessages(conversationId: string, userId: string) {
    const myPart = await this.ensureParticipant(conversationId, userId);
    const qb = this.msgRepository
      .createQueryBuilder('m')
      .where('m.conversationId = :conversationId', { conversationId })
      .andWhere('m.isPinned = :isPinned', { isPinned: true })
      .andWhere('m.status != :removed', { removed: MessageStatusEnum.REMOVED })
      .andWhere('(m.expiresAt IS NULL OR m.expiresAt > :now)', { now: new Date() })
      .leftJoinAndSelect('m.sender', 'sender')
      .orderBy('m.updatedAt', 'DESC')
      .take(20);

    if (myPart.clearedAt) {
      qb.andWhere('m.createdAt > :clearedAt', { clearedAt: myPart.clearedAt });
    }

    const list = await qb.getMany();
    return list.map((msg) => ({
      ...msg,
      content: this.messageCryptoService.decryptForConversation(msg.content, conversationId),
      createdAt: msg.createdAt ? new Date(msg.createdAt).toISOString() : new Date().toISOString(),
    }));
  }

  async getConversationSharedAssets(params: {
    conversationId: string;
    userId: string;
    query: GetSharedAssetsQueryDto;
  }) {
    const { conversationId, userId, query } = params;
    const myPart = await this.ensureParticipant(conversationId, userId);

    const qb = this.msgRepository
      .createQueryBuilder('m')
      .where('m.conversationId = :conversationId', { conversationId })
      .andWhere('m.status != :removed', { removed: MessageStatusEnum.REMOVED })
      .andWhere('(m.expiresAt IS NULL OR m.expiresAt > :now)', { now: new Date() })
      .leftJoinAndSelect('m.sender', 'sender')
      .orderBy('m.createdAt', 'DESC')
      .take(300);

    if (myPart.clearedAt) {
      qb.andWhere('m.createdAt > :clearedAt', { clearedAt: myPart.clearedAt });
    }

    const messages = await qb.getMany();
    const mediaItems: any[] = [];
    const fileItems: any[] = [];
    const linkItems: any[] = [];

    const urlRegex = /https?:\/\/[^\s<>"'`]+/gi;

    for (const msg of messages) {
      const attachments = msg.metadata?.attachments || [];
      const senderName = msg.sender?.name || 'User';
      const createdAt = msg.createdAt ? new Date(msg.createdAt).toISOString() : '';

      if (msg.type === MessageTypeEnum.IMAGE || msg.type === MessageTypeEnum.VIDEO) {
        for (const att of attachments) {
          mediaItems.push({
            messageId: msg.id,
            fileId: att.fileId,
            url: att.url,
            thumbnailUrl: att.thumbnailUrl || att.url,
            fileName: att.fileName,
            mimeType: att.mimeType,
            size: att.size,
            type: msg.type,
            senderId: msg.senderId,
            senderName,
            createdAt,
          });
        }
      } else if (msg.type === MessageTypeEnum.FILE || msg.type === MessageTypeEnum.AUDIO) {
        for (const att of attachments) {
          fileItems.push({
            messageId: msg.id,
            fileId: att.fileId,
            url: att.url,
            fileName: att.fileName,
            mimeType: att.mimeType,
            size: att.size,
            type: msg.type,
            senderId: msg.senderId,
            senderName,
            createdAt,
          });
        }
      }

      if (msg.type === MessageTypeEnum.TEXT && msg.content) {
        const decrypted = this.messageCryptoService.decryptForConversation(
          msg.content,
          conversationId,
        );
        const matches = decrypted.match(urlRegex);
        if (matches) {
          for (const rawUrl of matches) {
            try {
              const parsed = new URL(rawUrl);
              if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                linkItems.push({
                  messageId: msg.id,
                  url: parsed.toString(),
                  hostname: parsed.hostname,
                  previewText: decrypted.slice(0, 150),
                  senderId: msg.senderId,
                  senderName,
                  createdAt,
                });
              }
            } catch {
              /* empty */
            }
          }
        }
      }
    }

    return {
      media: mediaItems,
      files: fileItems,
      links: linkItems,
      activeTab: query.tab || 'MEDIA',
    };
  }

  async updateParticipantNickname(params: {
    conversationId: string;
    requesterId: string;
    dto: UpdateParticipantNicknameDto;
  }) {
    const conv = await this.convRepository.findOne({
      where: { id: params.conversationId },
      select: ['id', 'type'],
    });
    if (!conv) {
      throw new NotFoundException('Conversation not found');
    }
    // Lý do nghiệp vụ: Chỉ cho phép đặt biệt danh trong hội thoại 1-1 (DIRECT)
    if (conv.type !== ConversationTypeEnum.DIRECT) {
      throw new BadRequestException('Chỉ hỗ trợ đặt biệt danh trong cuộc trò chuyện 1-1');
    }

    await this.ensureParticipant(params.conversationId, params.requesterId);
    const targetPart = await this.ensureParticipant(params.conversationId, params.dto.targetUserId);

    const cleanNickname = params.dto.nickname ? params.dto.nickname.trim().slice(0, 80) : null;
    targetPart.nickname = cleanNickname;
    await this.partRepository.save(targetPart);

    if (params.requesterId !== params.dto.targetUserId) {
      await this.contactRepository
        .update(
          { userId: params.requesterId, contactId: params.dto.targetUserId },
          { alias: cleanNickname },
        )
        .catch(() => undefined);
    }

    const [targetUsers, memberIds] = await Promise.all([
      this.userService.getBasicUsersInfo([params.dto.targetUserId]),
      this.getConversationMemberIds(params.conversationId),
    ]);
    const originalName = targetUsers[0]?.name || null;

    return {
      conversationId: params.conversationId,
      targetUserId: params.dto.targetUserId,
      nickname: cleanNickname,
      originalName,
      displayName: cleanNickname || originalName,
      updatedBy: params.requesterId,
      recipientIds: memberIds,
    };
  }

  async updateConversationSettings(params: {
    conversationId: string;
    userId: string;
    dto: UpdateConversationSettingsDto;
  }) {
    const part = await this.ensureParticipant(params.conversationId, params.userId);
    const conv = await this.convRepository.findOne({
      where: { id: params.conversationId },
      select: ['id', 'type'],
    });

    const wasRestricted = Boolean(part.isRestricted);

    if (typeof params.dto.isMuted === 'boolean') part.isMuted = params.dto.isMuted;
    if (typeof params.dto.soundEnabled === 'boolean') part.soundEnabled = params.dto.soundEnabled;
    if (typeof params.dto.readReceiptsEnabled === 'boolean') {
      part.readReceiptsEnabled = params.dto.readReceiptsEnabled;
    }
    if (typeof params.dto.isRestricted === 'boolean') {
      part.isRestricted = params.dto.isRestricted;
      if (params.dto.isRestricted) {
        part.isMuted = true;
        part.soundEnabled = false;
      }
    }

    await this.partRepository.save(part);

    let partnerId: string | null = null;
    let isUserCurrentlyOnline = false;
    let shouldBroadcastPresenceChange = false;

    if (
      conv?.type === ConversationTypeEnum.DIRECT &&
      typeof params.dto.isRestricted === 'boolean' &&
      wasRestricted !== part.isRestricted
    ) {
      const members = await this.getConversationMemberIds(params.conversationId);
      partnerId = members.find((id) => id !== params.userId) || null;
      if (partnerId) {
        const blockState = await this.checkDirectBlockStatus(params.conversationId, params.userId);
        if (!blockState.isBlocked) {
          shouldBroadcastPresenceChange = true;
          isUserCurrentlyOnline = part.isRestricted
            ? false
            : await this.socketStateService.isUserOnline(params.userId);
        }
      }
    }

    return {
      conversationId: params.conversationId,
      isMuted: part.isMuted,
      soundEnabled: part.soundEnabled,
      readReceiptsEnabled: part.readReceiptsEnabled,
      isRestricted: part.isRestricted,
      partnerId,
      shouldBroadcastPresenceChange,
      isUserCurrentlyOnline,
    };
  }

  async updateDisappearingMessages(params: {
    conversationId: string;
    userId: string;
    dto: UpdateDisappearingMessagesDto;
  }) {
    const part = await this.ensureParticipant(params.conversationId, params.userId);
    const conv = await this.convRepository.findOne({ where: { id: params.conversationId } });
    if (!conv) throw new NotFoundException('Conversation not found');

    if (conv.type === ConversationTypeEnum.GROUP && !part.isAdmin) {
      throw new ForbiddenException(
        'Chỉ quản trị viên nhóm mới có thể thay đổi cài đặt tin nhắn tự huỷ',
      );
    }

    const nextTtl =
      params.dto.disappearingTtl && params.dto.disappearingTtl > 0
        ? params.dto.disappearingTtl
        : null;

    conv.disappearingTtl = nextTtl;
    await this.convRepository.save(conv);

    return {
      conversationId: params.conversationId,
      disappearingTtl: nextTtl,
      updatedBy: params.userId,
    };
  }

  async deleteConversationForUser(params: { conversationId: string; userId: string }) {
    const part = await this.ensureParticipant(params.conversationId, params.userId);
    const now = new Date();
    part.clearedAt = now;
    part.isHidden = true;
    part.lastReadAt = now;
    await this.partRepository.save(part);

    return {
      conversationId: params.conversationId,
      clearedAt: now.toISOString(),
      isHidden: true,
    };
  }

  async getConversationDetails(conversationId: string, userId: string) {
    const myPart = await this.ensureParticipant(conversationId, userId);
    const conv = await this.convRepository.findOne({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('Conversation not found');

    const participants = await this.partRepository.find({
      where: { conversationId },
      order: { joinedAt: 'ASC' },
    });
    const memberIds = participants.map((p) => p.userId);
    const users = await this.userService.getBasicUsersInfo(memberIds);
    const userMap = new Map(users.map((u: any) => [u.id, u]));

    const hasExplicitOwner = participants.some((p) => p.role === GroupRoleEnum.OWNER);
    const firstAdminUserId = participants.find((p) => p.isAdmin)?.userId;

    const members = participants.map((p) => {
      const u = userMap.get(p.userId);
      let effectiveRole = this.resolveEffectiveRole(p);
      if (
        conv.type === ConversationTypeEnum.GROUP &&
        !hasExplicitOwner &&
        p.userId === firstAdminUserId
      ) {
        effectiveRole = GroupRoleEnum.OWNER;
      }

      return {
        userId: p.userId,
        name: u?.name || 'User',
        email: u?.email || '',
        avatar: u?.avatarMedia?.file?.url || null,
        nickname: p.nickname || null,
        isAdmin: p.isAdmin || effectiveRole !== GroupRoleEnum.MEMBER,
        role: effectiveRole,
        joinedAt: p.joinedAt,
      };
    });

    const blockState = await this.checkDirectBlockStatus(conversationId, userId);
    const partnerMember =
      conv.type === ConversationTypeEnum.DIRECT
        ? members.find((m) => m.userId !== userId)
        : undefined;
    const resolvedName =
      conv.type === ConversationTypeEnum.DIRECT
        ? partnerMember?.nickname || partnerMember?.name || conv.name
        : conv.name;

    if (conv.shopId) {
      const shopMembers = await this.shopMemberRepository.find({
        where: { shopId: conv.shopId, membershipStatus: MembershipStatusEnum.ACTIVE },
        select: ['userId', 'role'],
      });
      const missingColleagueIds = shopMembers
        .map((sm) => sm.userId)
        .filter((uid) => !memberIds.includes(uid));
      if (missingColleagueIds.length > 0) {
        const extraUsers = await this.userService.getBasicUsersInfo(missingColleagueIds);
        for (const eu of extraUsers as any[]) {
          members.push({
            userId: eu.id,
            name: eu.name || 'Nhân sự',
            email: eu.email || '',
            avatar: eu.avatarMedia?.file?.url || null,
            nickname: null,
            isAdmin: false,
            role: GroupRoleEnum.MEMBER,
            joinedAt: conv.createdAt,
          });
        }
      }
    }

    const resolvedAvatar =
      conv.avatar ||
      partnerMember?.avatar ||
      (conv.shopId && resolvedName ? this.buildCustomerFallbackAvatarUrl(resolvedName) : null);

    return {
      conversationId,
      type: conv.type,
      name: resolvedName,
      avatar: resolvedAvatar,
      disappearingTtl: conv.disappearingTtl,
      shopId: conv.shopId,
      channelType: conv.channelType,
      channelIntegrationId: conv.channelIntegrationId,
      interactionType: conv.interactionType,
      supportStatus: conv.supportStatus,
      assignedAgentId: conv.assignedAgentId,
      isGhostedByAgent: conv.isGhostedByAgent,
      isSlaBreached: conv.isSlaBreached,
      slaDeadlineAt: conv.slaDeadlineAt ? conv.slaDeadlineAt.toISOString() : null,
      snoozedUntilAt: conv.snoozedUntilAt ? conv.snoozedUntilAt.toISOString() : null,
      snoozeNote: conv.snoozeNote,
      activeTagIdsJson: conv.activeTagIdsJson || [],
      sourceAdId: conv.sourceAdId,
      sourcePostId: conv.sourcePostId,
      ctwaClickId: conv.ctwaClickId,
      accountabilityTimelineJson: conv.accountabilityTimelineJson || [],
      mySettings: {
        isMuted: myPart.isMuted,
        soundEnabled: myPart.soundEnabled ?? true,
        readReceiptsEnabled: myPart.readReceiptsEnabled ?? true,
        isRestricted: myPart.isRestricted ?? false,
        nickname: myPart.nickname || null,
      },
      blockState,
      members,
    };
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async cleanupExpiredDisappearingMessages(): Promise<void> {
    try {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

      const expiredRows = await this.msgRepository
        .createQueryBuilder('m')
        .select('DISTINCT m.conversationId', 'conversationId')
        .where('m.createdAt >= :thirtyDaysAgo', { thirtyDaysAgo })
        .andWhere('m.expiresAt IS NOT NULL AND m.expiresAt <= :now', { now })
        .getRawMany<{ conversationId: string }>();

      const affectedConvIds = expiredRows.map((r) => r.conversationId);

      await this.msgRepository
        .createQueryBuilder()
        .delete()
        .from(MessageEntity)
        .where('created_at >= :thirtyDaysAgo', { thirtyDaysAgo })
        .andWhere('expires_at IS NOT NULL AND expires_at <= :now', { now })
        .execute();

      for (const convId of affectedConvIds) {
        const latestRemaining = await this.msgRepository
          .createQueryBuilder('m')
          .where('m.conversationId = :convId', { convId })
          .andWhere('(m.expiresAt IS NULL OR m.expiresAt > :now)', { now })
          .orderBy('m.createdAt', 'DESC')
          .getOne();

        if (latestRemaining) {
          await this.convRepository.update(convId, {
            lastMessage: latestRemaining.content,
            lastMessageSenderId: latestRemaining.senderId,
            lastMessageAt: latestRemaining.createdAt,
            lastMessageType: latestRemaining.type,
          });
        } else {
          await this.convRepository
            .createQueryBuilder()
            .update(ConversationEntity)
            .set({
              lastMessage: () => 'NULL',
              lastMessageSenderId: () => 'NULL',
              lastMessageType: () => 'NULL',
            })
            .where('id = :convId', { convId })
            .execute();
        }
      }
    } catch (err) {
      this.logger.warn(`Failed cleaning expired messages: ${String(err)}`);
    }
  }

  private resolveEffectiveRole(part: ConversationParticipantEntity): GroupRoleEnum {
    if (part.role === GroupRoleEnum.OWNER) return GroupRoleEnum.OWNER;
    if (part.role === GroupRoleEnum.ADMIN || part.isAdmin) return GroupRoleEnum.ADMIN;
    return GroupRoleEnum.MEMBER;
  }

  private isModeratorOrOwner(part: ConversationParticipantEntity): boolean {
    const role = this.resolveEffectiveRole(part);
    return role === GroupRoleEnum.OWNER || role === GroupRoleEnum.ADMIN;
  }

  async updateGroupMemberRole(params: {
    conversationId: string;
    requesterId: string;
    targetUserId: string;
    role: GroupRoleEnum;
  }) {
    const conv = await this.convRepository.findOne({ where: { id: params.conversationId } });
    if (!conv || conv.type !== ConversationTypeEnum.GROUP) {
      throw new BadRequestException('Cuộc trò chuyện này không phải là nhóm');
    }

    if (params.requesterId === params.targetUserId) {
      throw new BadRequestException('Không thể tự thay đổi vai trò của chính mình');
    }

    const allParts = await this.partRepository.find({
      where: { conversationId: params.conversationId },
      order: { joinedAt: 'ASC' },
    });

    const requesterPart = allParts.find((p) => p.userId === params.requesterId);
    const targetPart = allParts.find((p) => p.userId === params.targetUserId);

    if (!requesterPart || !targetPart) {
      throw new NotFoundException('Không tìm thấy thành viên trong nhóm');
    }

    const hasExplicitOwner = allParts.some((p) => p.role === GroupRoleEnum.OWNER);
    const isRequesterOwner =
      requesterPart.role === GroupRoleEnum.OWNER || (!hasExplicitOwner && requesterPart.isAdmin);

    if (!isRequesterOwner) {
      throw new ForbiddenException('Chỉ Trưởng nhóm mới có quyền phân quyền thành viên');
    }

    if (params.role === GroupRoleEnum.OWNER) {
      requesterPart.role = GroupRoleEnum.ADMIN;
      requesterPart.isAdmin = true;
      targetPart.role = GroupRoleEnum.OWNER;
      targetPart.isAdmin = true;
      await this.partRepository.save([requesterPart, targetPart]);
    } else {
      targetPart.role = params.role;
      targetPart.isAdmin = params.role === GroupRoleEnum.ADMIN;
      if (!hasExplicitOwner) {
        requesterPart.role = GroupRoleEnum.OWNER;
        requesterPart.isAdmin = true;
        await this.partRepository.save([requesterPart, targetPart]);
      } else {
        await this.partRepository.save(targetPart);
      }
    }

    return {
      conversationId: params.conversationId,
      targetUserId: params.targetUserId,
      role: targetPart.role,
      isAdmin: targetPart.isAdmin,
      updatedBy: params.requesterId,
    };
  }

  async forwardMessage(params: { senderId: string; dto: ForwardMessageDto }) {
    const { senderId, dto } = params;
    await this.ensureParticipant(dto.sourceConversationId, senderId);

    const originalMsg = await this.msgRepository.findOne({
      where: { id: dto.messageId, conversationId: dto.sourceConversationId },
      relations: ['sender'],
    });

    if (!originalMsg || originalMsg.status === MessageStatusEnum.REMOVED) {
      throw new NotFoundException('Tin nhắn gốc không tồn tại hoặc đã bị thu hồi');
    }

    const decryptedContent = this.messageCryptoService.decryptForConversation(
      originalMsg.content,
      dto.sourceConversationId,
    );
    const fileIds = (originalMsg.metadata?.attachments || []).map((a) => a.fileId);
    const uniqueTargetIds = [...new Set(dto.targetConversationIds)];

    const forwardedResults: Array<{
      conversationId: string;
      message: any;
      recipientIds: string[];
    }> = [];

    for (const targetConvId of uniqueTargetIds) {
      const res = await this.sendMessage({
        senderId,
        dto: {
          conversationId: targetConvId,
          content: decryptedContent,
          type: originalMsg.type,
          fileIds: fileIds.length > 0 ? fileIds : undefined,
          metadata: {
            forwardedFrom: {
              messageId: originalMsg.id,
              senderId: originalMsg.senderId,
              senderName: originalMsg.sender?.name || 'Người dùng',
            },
          },
        },
      });
      forwardedResults.push({
        conversationId: targetConvId,
        message: res.message,
        recipientIds: res.recipientIds,
      });
    }

    return forwardedResults;
  }

  /**
   * F03.5: Tạo Ghi chú nội bộ (Alt+N) — Chỉ lưu nội bộ và gửi thông báo cho đồng nghiệp được @mention,
   * tuyệt đối không gửi ra Graph API Facebook/Zalo bên ngoài.
   */
  async createInternalNote(params: {
    senderId: string;
    conversationId: string;
    content: string;
    mentionedUserIds?: string[];
    replyToMessageId?: string;
  }) {
    const conv = await this.convRepository.findOne({
      where: { id: params.conversationId },
      select: ['id', 'shopId', 'name'],
    });
    if (!conv) {
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    if (conv.shopId && params.mentionedUserIds && params.mentionedUserIds.length > 0) {
      for (const mentionedUid of params.mentionedUserIds) {
        await this.ensureParticipant(params.conversationId, mentionedUid).catch(() => undefined);
      }
    }

    return this.sendMessage({
      senderId: params.senderId,
      dto: {
        conversationId: params.conversationId,
        content: params.content,
        type: MessageTypeEnum.TEXT,
        replyToMessageId: params.replyToMessageId,
        mentionedUserIds: params.mentionedUserIds,
        metadata: {
          isInternalNote: true,
          mentionedUserIds: params.mentionedUserIds || [],
        },
      },
    });
  }

  /**
   * Điều tốc Token Bucket trên Redis cho Meta Private Replies API & Comment Actions (Tối đa 750 lệnh/giờ/Page)
   */
  private async consumeMetaGraphActionQuota(
    bucketScope: string,
    maxCallsPerHour = 750,
  ): Promise<void> {
    const hourSlot = Math.floor(Date.now() / 3_600_000);
    const redisKey = `ratelimit:meta_comment_action:${bucketScope}:${hourSlot}`;
    try {
      const used = await this.redis.incr(redisKey);
      if (used === 1) {
        await this.redis.expire(redisKey, 3660);
      }
      if (used > maxCallsPerHour) {
        throw new BadRequestException('META_PRIVATE_REPLY_RATE_LIMIT_EXCEEDED');
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
    }
  }

  /**
   * Phân giải chính xác mã định danh người nhận ngoại vi (`customerPsid` và `latestCommentId`) cho một cuộc hội thoại:
   * - Ưu tiên lấy `externalCustomerPsid` đã lưu trong `metadata` của tin nhắn `INBOUND` gần nhất.
   * - Nếu `externalThreadId` có dạng `inbox_{psid}` hoặc `zalo_{userId}`, bóc tách phần định danh sau tiền tố.
   * - Nếu `externalThreadId` có dạng `cmt_{postId}_{commenterId}`, bóc tách chính xác phần `commenterId` ở cuối (loại bỏ `postId`).
   * - Nếu cuộc hội thoại `INBOX` được tạo liên kết từ `sendPrivateReplyFromComment` mà chưa có `externalThreadId`,
   *   tự động tra cứu sang cuộc hội thoại gốc cùng khách hàng trong cùng kênh để lấy đúng `psid` và `externalCommentId`.
   */
  private async resolveCustomerRecipientForConversation(conversation: ConversationEntity): Promise<{
    recipientPsid: string | null;
    latestCommentId: string | null;
  }> {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    const extractPsidFromThreadId = (threadId?: string | null): string | null => {
      if (!threadId) return null;
      const trimmed = threadId.trim();
      if (!trimmed || uuidRegex.test(trimmed)) return null;
      if (trimmed.startsWith('inbox_') || trimmed.startsWith('zalo_')) {
        const stripped = trimmed.replace(/^(inbox_|zalo_)/, '').trim();
        return stripped && !uuidRegex.test(stripped) ? stripped : null;
      }
      if (trimmed.startsWith('cmt_')) {
        const parts = trimmed.split('_').filter(Boolean);
        const lastPart = parts.length >= 3 ? parts[parts.length - 1] : null;
        return lastPart && !uuidRegex.test(lastPart) ? lastPart : null;
      }
      if (!trimmed.startsWith('thread_') && !trimmed.startsWith('priv_')) {
        return trimmed;
      }
      return null;
    };

    const latestInbound = await this.msgRepository.findOne({
      where: {
        conversationId: conversation.id,
        direction: MessageDirectionEnum.INBOUND,
      },
      order: { createdAt: 'DESC' },
    });

    const metaPsid = (latestInbound?.metadata as any)?.externalCustomerPsid
      ? String((latestInbound?.metadata as any).externalCustomerPsid).trim()
      : null;

    let latestCommentId =
      latestInbound?.metadata?.externalCommentId ||
      (conversation.interactionType === 'COMMENT' || conversation.interactionType === 'LIVESTREAM'
        ? latestInbound?.externalMessageId || null
        : null);

    let recipientPsid = metaPsid || extractPsidFromThreadId(conversation.externalThreadId);

    // Nếu hội thoại hiện tại chưa có recipientPsid (VD: hội thoại INBOX tạo từ Private Reply của bình luận),
    // tra cứu sang các hội thoại cùng khách hàng trên cùng kênh tích hợp
    if ((!recipientPsid || !latestCommentId) && conversation.shopId && conversation.name) {
      const siblingConvs = await this.convRepository.find({
        where: {
          shopId: conversation.shopId,
          ...(conversation.channelIntegrationId
            ? { channelIntegrationId: conversation.channelIntegrationId }
            : {}),
          name: conversation.name,
        },
        order: { lastMessageAt: 'DESC' },
        take: 5,
      });

      for (const sib of siblingConvs) {
        if (!recipientPsid) {
          recipientPsid = extractPsidFromThreadId(sib.externalThreadId);
        }
        const sibInbound = await this.msgRepository.findOne({
          where: {
            conversationId: sib.id,
            direction: MessageDirectionEnum.INBOUND,
          },
          order: { createdAt: 'DESC' },
        });
        if (!recipientPsid && (sibInbound?.metadata as any)?.externalCustomerPsid) {
          recipientPsid = String((sibInbound?.metadata as any).externalCustomerPsid).trim();
        }
        if (!latestCommentId && sibInbound?.metadata?.externalCommentId) {
          latestCommentId = String(sibInbound.metadata.externalCommentId).trim();
        }
        if (recipientPsid && latestCommentId) break;
      }

      if (recipientPsid && !conversation.externalThreadId) {
        const nextThreadId =
          conversation.channelType === ChannelTypeEnum.ZALO_OA
            ? `zalo_${recipientPsid}`
            : `inbox_${recipientPsid}`;
        conversation.externalThreadId = nextThreadId;
        await this.convRepository
          .update(conversation.id, { externalThreadId: nextThreadId })
          .catch(() => undefined);
      }
    }

    return {
      recipientPsid,
      latestCommentId: latestCommentId || null,
    };
  }

  /**
   * Thực thi gọi API thực tế ra nền tảng ngoài (Facebook Graph API, Instagram, Zalo OA, TikTok Shop, Shopee)
   * với cơ chế:
   * 1. Mỗi lần thử dùng một `AbortController` độc lập (timeout 6000ms) để không bị hủy dây chuyền khi thương lượng phiên bản API.
   * 2. Tự động đính kèm `access_token` trên cả Query String lẫn Body JSON.
   * 3. Tự động thử lại KHÔNG kèm `appsecret_proof` (`attemptRequest(false)`) khi người dùng sử dụng Token từ Graph API Explorer
   *    hoặc khi `appSecret` trong cấu hình khác với ứng dụng phát hành Token (khắc phục lỗi OAuthException #100 Invalid appsecret_proof).
   * 4. Tự động fallback sang `/me/messages`, `HUMAN_AGENT` Message Tag (7 ngày) hoặc `comment_id` Private Reply khi cần.
   */
  /**
   * Tự động khôi phục & vĩnh viễn hóa Page Access Token ngay trong luồng gửi tin nhắn (`Self-Healing Outbound Token Recovery`):
   * Khi người bán gửi tin nhắn tới người mua nhưng Page Access Token bị hết hạn (OAuthException 190 / Zalo -216),
   * phương thức này tự động:
   * 1. Đổi qua `fb_exchange_token` (nếu có `appId` + `appSecret`).
   * 2. Hoặc dùng `userLongLivedTokenEncrypted` / `refreshTokenEncrypted` đã lưu để gọi `GET /{externalPageId}?fields=access_token`
   *    và `GET /me/accounts` nhằm rút trích **Never-Expiring Page Access Token** mới.
   * 3. Hoặc khôi phục chéo từ Fanpage anh em cùng cửa hàng (`Sibling Channel Recovery`).
   * 4. Lưu Page Access Token mới vào DB và trả về ngay cho `executePlatformHttpCall` để gửi lại tin nhắn tức thì.
   */
  private async recoverExpiredChannelPageTokenInline(
    channel: ChannelIntegrationEntity,
    currentAppSecret: string,
    apiVersion: string,
  ): Promise<string | null> {
    try {
      let appId = (
        channel.appId ||
        channel.platformConfigJson?.appId ||
        envs.omnichannelSaas?.metaAppId ||
        ''
      ).trim();
      let appSecret = currentAppSecret.trim();

      if ((!appId || !appSecret) && channel.shopId) {
        const shop = await this.dataSource
          .getRepository(ShopWorkspaceEntity)
          .findOne({ where: { id: channel.shopId }, select: ['id', 'saasAppProfilesJson'] })
          .catch(() => null);
        const profiles = Array.isArray(shop?.saasAppProfilesJson) ? shop.saasAppProfilesJson : [];
        const matchedProf =
          (channel.saasAppProfileId
            ? profiles.find((p) => p.id === channel.saasAppProfileId)
            : null) ||
          profiles.find(
            (p) => p.channelType === channel.channelType && p.isDefault && p.isActive !== false,
          ) ||
          profiles.find((p) => p.channelType === channel.channelType && p.isActive !== false) ||
          null;
        if (matchedProf) {
          if (!appId && matchedProf.appId) appId = matchedProf.appId.trim();
          if (!appSecret && matchedProf.appSecretEncrypted) {
            appSecret = this.messageCryptoService
              .decryptForConversation(matchedProf.appSecretEncrypted, channel.shopId)
              .trim();
          }
        }
      }

      if (channel.channelType === ChannelTypeEnum.ZALO_OA) {
        const zaloRefresh = channel.refreshTokenEncrypted
          ? this.messageCryptoService
              .decryptForConversation(channel.refreshTokenEncrypted, channel.shopId)
              .trim()
          : '';
        const zaloAppId = appId || envs.omnichannelSaas?.zaloAppId || '';
        const zaloSecret = appSecret || envs.omnichannelSaas?.zaloAppSecret || '';
        if (!zaloRefresh || !zaloAppId || !zaloSecret) return null;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const body = new URLSearchParams({
          refresh_token: zaloRefresh,
          app_id: zaloAppId,
          grant_type: 'refresh_token',
        });
        const res = await fetch('https://oauth.zaloapp.com/v4/oa/access_token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            secret_key: zaloSecret,
          },
          body: body.toString(),
          signal: controller.signal,
        }).catch(() => null);
        clearTimeout(timeoutId);
        if (!res || !res.ok) return null;
        const json = (await res.json().catch(() => ({}))) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
        };
        if (!json.access_token) return null;
        const nextAccess = String(json.access_token).trim();
        const nextRefresh = json.refresh_token ? String(json.refresh_token).trim() : zaloRefresh;
        channel.accessTokenEncrypted = this.messageCryptoService.encryptForConversation(
          nextAccess,
          channel.shopId,
        ).ciphertext;
        channel.refreshTokenEncrypted = this.messageCryptoService.encryptForConversation(
          nextRefresh,
          channel.shopId,
        ).ciphertext;
        channel.tokenExpiresAt = new Date(Date.now() + Number(json.expires_in || 90000) * 1000);
        channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
        channel.lastErrorMessage = null;
        await this.channelRepository.save(channel);
        return nextAccess;
      }

      // Nhánh Facebook Fanpage / Instagram Business
      const storedUserTok = channel.platformConfigJson?.userLongLivedTokenEncrypted
        ? this.messageCryptoService
            .decryptForConversation(
              channel.platformConfigJson.userLongLivedTokenEncrypted,
              channel.shopId,
            )
            .trim()
        : '';
      const storedRefreshTok = channel.refreshTokenEncrypted
        ? this.messageCryptoService
            .decryptForConversation(channel.refreshTokenEncrypted, channel.shopId)
            .trim()
        : '';
      const currentPageTok = channel.accessTokenEncrypted
        ? this.messageCryptoService
            .decryptForConversation(channel.accessTokenEncrypted, channel.shopId)
            .trim()
        : '';

      const siblingChannels = await this.channelRepository.find({
        where: {
          shopId: channel.shopId,
          channelType: In([ChannelTypeEnum.FACEBOOK_PAGE, ChannelTypeEnum.INSTAGRAM]),
          isActive: true,
        },
        take: 10,
      });

      const siblingTokens: string[] = [];
      for (const sib of siblingChannels) {
        if (sib.id === channel.id) continue;
        if (sib.platformConfigJson?.userLongLivedTokenEncrypted) {
          siblingTokens.push(
            this.messageCryptoService
              .decryptForConversation(
                sib.platformConfigJson.userLongLivedTokenEncrypted,
                sib.shopId,
              )
              .trim(),
          );
        }
        if (sib.refreshTokenEncrypted) {
          siblingTokens.push(
            this.messageCryptoService
              .decryptForConversation(sib.refreshTokenEncrypted, sib.shopId)
              .trim(),
          );
        }
      }

      const candidateSourceTokens = Array.from(
        new Set(
          [storedUserTok, storedRefreshTok, currentPageTok, ...siblingTokens].filter(
            (t) => Boolean(t) && !/^(oauth2_|rft_|sandbox_)/i.test(t),
          ),
        ),
      );

      const exchangeLongLived = async (tok: string): Promise<string> => {
        if (!appId || !appSecret) return tok;
        const qs = new URLSearchParams({
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: tok,
        });
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4500);
        const res = await fetch(
          `https://graph.facebook.com/${apiVersion}/oauth/access_token?${qs.toString()}`,
          { signal: controller.signal },
        ).catch(() => null);
        clearTimeout(timeoutId);
        if (!res || !res.ok) return tok;
        const json = (await res.json().catch(() => ({}))) as { access_token?: string };
        return json.access_token ? String(json.access_token).trim() : tok;
      };

      const tryDerivePageToken = async (srcTok: string): Promise<string | null> => {
        const exchangedTok = await exchangeLongLived(srcTok);
        const proof = appSecret
          ? createHmac('sha256', appSecret).update(exchangedTok).digest('hex')
          : null;

        // 1. Gọi trực tiếp /{externalPageId}?fields=id,access_token
        const directQs = new URLSearchParams({
          fields: 'id,access_token',
          access_token: exchangedTok,
          ...(proof ? { appsecret_proof: proof } : {}),
        });
        const controller1 = new AbortController();
        const t1 = setTimeout(() => controller1.abort(), 4500);
        const directRes = await fetch(
          `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(channel.externalPageId)}?${directQs.toString()}`,
          { signal: controller1.signal },
        ).catch(() => null);
        clearTimeout(t1);
        if (directRes && directRes.ok) {
          const directJson = (await directRes.json().catch(() => ({}))) as {
            id?: string;
            access_token?: string;
          };
          if (directJson.access_token && String(directJson.id) === channel.externalPageId) {
            return String(directJson.access_token).trim();
          }
        }

        // 2. Gọi /me/accounts để trích xuất đúng Never-Expiring Page Token của externalPageId
        const accQs = new URLSearchParams({
          fields: 'id,name,access_token,instagram_business_account{id}',
          limit: '100',
          access_token: exchangedTok,
          ...(proof ? { appsecret_proof: proof } : {}),
        });
        const controller2 = new AbortController();
        const t2 = setTimeout(() => controller2.abort(), 4500);
        const accRes = await fetch(
          `https://graph.facebook.com/${apiVersion}/me/accounts?${accQs.toString()}`,
          { signal: controller2.signal },
        ).catch(() => null);
        clearTimeout(t2);
        if (accRes && accRes.ok) {
          const accJson = (await accRes.json().catch(() => ({}))) as {
            data?: Array<{
              id: string;
              access_token?: string;
              instagram_business_account?: { id: string };
            }>;
          };
          const matched = (accJson.data || []).find(
            (item) =>
              String(item.id) === channel.externalPageId ||
              String(item.instagram_business_account?.id || '') === channel.externalPageId,
          );
          if (matched?.access_token) {
            return String(matched.access_token).trim();
          }
        }

        return exchangedTok !== srcTok ? exchangedTok : null;
      };

      for (const candidate of candidateSourceTokens) {
        const derivedPageTok = await tryDerivePageToken(candidate);
        if (derivedPageTok) {
          const nowIso = new Date().toISOString();
          channel.accessTokenEncrypted = this.messageCryptoService.encryptForConversation(
            derivedPageTok,
            channel.shopId,
          ).ciphertext;
          channel.tokenExpiresAt = null;
          channel.webhookStatus = WebhookIntegrationStatusEnum.HEALTHY;
          channel.lastErrorMessage = null;
          channel.platformConfigJson = {
            ...(channel.platformConfigJson || {}),
            isNeverExpiringPageToken: true,
            lastTokenRefreshedAt: nowIso,
            autoRefreshPageTokenEnabled: true,
            tokenRecoverySource: 'FB_EXCHANGE_NEVER_EXPIRING',
          };
          await this.channelRepository.save(channel);
          this.logger.log(
            `[ChatService] Self-healed Page Access Token inline for channel "${channel.pageName}" (${channel.externalPageId}) during outbound send.`,
          );
          return derivedPageTok;
        }
      }
    } catch (err) {
      this.logger.warn(`Inline Page Token recovery failed: ${String(err)}`);
    }
    return null;
  }

  private async executePlatformHttpCall(params: {
    channelIntegrationId?: string | null;
    shopId?: string | null;
    actionType:
      | 'SEND_INBOX_MESSAGE'
      | 'REPLY_PUBLIC_COMMENT'
      | 'EDIT_COMMENT'
      | 'SEND_PRIVATE_REPLY'
      | 'HIDE_UNHIDE_COMMENT'
      | 'LIKE_UNLIKE_COMMENT'
      | 'DELETE_COMMENT';
    targetExternalId: string;
    bodyPayload?: Record<string, unknown>;
  }): Promise<{
    deliveryStatus: 'DISPATCHED' | 'SIMULATED_SANDBOX';
    externalId: string;
  }> {
    const fallbackExternalId = `ext_${params.actionType.toLowerCase()}_${Date.now()}`;
    if (!params.channelIntegrationId || !params.shopId) {
      return {
        deliveryStatus: 'SIMULATED_SANDBOX',
        externalId: fallbackExternalId,
      };
    }

    const channel = await this.channelRepository.findOne({
      where: { id: params.channelIntegrationId, shopId: params.shopId },
    });
    if (!channel || !channel.accessTokenEncrypted) {
      return {
        deliveryStatus: 'SIMULATED_SANDBOX',
        externalId: fallbackExternalId,
      };
    }

    let rawToken = this.messageCryptoService
      .decryptForConversation(channel.accessTokenEncrypted, channel.shopId)
      .trim()
      .replace(/^Bearer\s+/i, '');
    if (!rawToken || rawToken.startsWith('oauth2_tok_') || rawToken.startsWith('sandbox_')) {
      return {
        deliveryStatus: 'SIMULATED_SANDBOX',
        externalId: fallbackExternalId,
      };
    }

    try {
      if (
        channel.channelType === ChannelTypeEnum.FACEBOOK_PAGE ||
        channel.channelType === ChannelTypeEnum.INSTAGRAM
      ) {
        const rawVer = (
          channel.apiVersion ||
          channel.platformConfigJson?.apiVersion ||
          envs.omnichannelSaas?.metaGraphApiVersion ||
          'v22.0'
        )
          .trim()
          .replace(/^v\.?/i, '');
        const preferredVer = /^\d+(\.\d+)?$/.test(rawVer) ? `v${rawVer}` : 'v22.0';
        const candidateVersions = Array.from(
          new Set([preferredVer, 'v22.0', 'v21.0', 'v20.0', 'v19.0']),
        );

        let appSecret = (envs.omnichannelSaas?.metaAppSecret || '').trim();
        if (channel.appSecretEncrypted) {
          const decryptedSecret = this.messageCryptoService.decryptForConversation(
            channel.appSecretEncrypted,
            channel.shopId,
          );
          if (decryptedSecret && !decryptedSecret.startsWith('enc_')) {
            appSecret = decryptedSecret.trim();
          }
        }
        let appSecretProof = appSecret
          ? createHmac('sha256', appSecret).update(rawToken).digest('hex')
          : undefined;
        let hasAttemptedTokenAutoHeal = false;

        const cleanTargetId = params.targetExternalId.replace(/^(inbox_|zalo_)/, '').trim();

        const executeSingleGraphRequest = async (reqConfig: {
          ver: string;
          endpointPath: string;
          method: 'POST' | 'DELETE';
          bodyObj?: Record<string, unknown>;
          includeProof: boolean;
        }): Promise<{
          ok: boolean;
          externalId?: string;
          errorCode?: number;
          errorSubcode?: number;
          errorMessage?: string;
        }> => {
          const queryParams = new URLSearchParams({ access_token: rawToken });
          if (reqConfig.includeProof && appSecretProof) {
            queryParams.set('appsecret_proof', appSecretProof);
          }

          const cleanPath = reqConfig.endpointPath.replace(/^\/+/, '');
          const url = `https://graph.facebook.com/${reqConfig.ver}/${cleanPath}?${queryParams.toString()}`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 6000);

          try {
            const payloadWithAuth =
              reqConfig.method === 'DELETE' || !reqConfig.bodyObj
                ? undefined
                : {
                    ...reqConfig.bodyObj,
                    access_token: rawToken,
                    ...(reqConfig.includeProof && appSecretProof
                      ? { appsecret_proof: appSecretProof }
                      : {}),
                  };

            const res = await fetch(url, {
              method: reqConfig.method,
              headers:
                reqConfig.method === 'DELETE' ? undefined : { 'Content-Type': 'application/json' },
              body: payloadWithAuth ? JSON.stringify(payloadWithAuth) : undefined,
              signal: controller.signal,
            });
            clearTimeout(timeoutId);

            const json = (await res.json().catch(() => ({}))) as {
              id?: string;
              message_id?: string;
              success?: boolean;
              error?: { message?: string; code?: number; error_subcode?: number };
            };

            if (res.ok && !json.error) {
              return {
                ok: true,
                externalId: String(json.message_id || json.id || fallbackExternalId),
              };
            }

            return {
              ok: false,
              errorCode: json?.error?.code,
              errorSubcode: json?.error?.error_subcode,
              errorMessage: String(json?.error?.message || `HTTP_${res.status}`),
            };
          } catch (err) {
            clearTimeout(timeoutId);
            return {
              ok: false,
              errorCode: 0,
              errorMessage: err instanceof Error ? err.message : String(err),
            };
          }
        };

        const runWithProofFallback = async (reqConfig: {
          ver: string;
          endpointPath: string;
          method: 'POST' | 'DELETE';
          bodyObj?: Record<string, unknown>;
        }) => {
          const firstAttempt = await executeSingleGraphRequest({
            ...reqConfig,
            includeProof: Boolean(appSecretProof),
          });
          if (firstAttempt.ok) {
            return firstAttempt;
          }

          let latestAttempt = firstAttempt;

          // 1. Nếu Token được lấy từ Graph API Explorer hoặc App Secret không khớp với Token,
          // tự động thử lại ngay lập tức không đính kèm appsecret_proof
          if (
            appSecretProof &&
            firstAttempt.errorMessage &&
            (firstAttempt.errorMessage.toLowerCase().includes('appsecret_proof') ||
              firstAttempt.errorCode === 100)
          ) {
            const retryNoProof = await executeSingleGraphRequest({
              ...reqConfig,
              includeProof: false,
            });
            if (retryNoProof.ok) {
              return retryNoProof;
            }
            latestAttempt = retryNoProof;
          }

          // 2. Cơ chế Self-Healing Outbound Retry khi Page Access Token hết hạn (OAuthException code 190 / subcode 463, 467, 460):
          // Tự động lấy lại Never-Expiring Page Access Token từ Long-Lived User Token / fb_exchange_token / kênh anh em cùng Shop
          // và gửi lại tin nhắn cho người mua ngay trong cùng 1 request mà không làm gián đoạn việc nhắn tin của người bán!
          const isTokenExpiredError =
            latestAttempt.errorCode === 190 ||
            latestAttempt.errorSubcode === 463 ||
            latestAttempt.errorSubcode === 467 ||
            latestAttempt.errorSubcode === 460 ||
            /access token|session has expired|validating access token|token has expired/i.test(
              latestAttempt.errorMessage || '',
            );

          if (isTokenExpiredError && !hasAttemptedTokenAutoHeal) {
            hasAttemptedTokenAutoHeal = true;
            const healedToken = await this.recoverExpiredChannelPageTokenInline(
              channel,
              appSecret,
              reqConfig.ver,
            );
            if (healedToken && healedToken !== rawToken) {
              rawToken = healedToken;
              appSecretProof = appSecret
                ? createHmac('sha256', appSecret).update(rawToken).digest('hex')
                : undefined;

              const retryAfterHeal = await executeSingleGraphRequest({
                ...reqConfig,
                includeProof: Boolean(appSecretProof),
              });
              if (retryAfterHeal.ok) {
                return retryAfterHeal;
              }
              if (appSecretProof) {
                const retryAfterHealNoProof = await executeSingleGraphRequest({
                  ...reqConfig,
                  includeProof: false,
                });
                if (retryAfterHealNoProof.ok) {
                  return retryAfterHealNoProof;
                }
              }
            }
          }

          return latestAttempt;
        };

        for (const ver of candidateVersions) {
          if (params.actionType === 'SEND_INBOX_MESSAGE') {
            const attachmentUrl = params.bodyPayload?.attachmentUrl as string | undefined;
            const attachmentType =
              (params.bodyPayload?.attachmentType as string | undefined) || 'image';
            const textContent = String(params.bodyPayload?.text || '').trim();
            const fallbackCommentId = params.bodyPayload?.fallbackCommentId as string | undefined;

            const messagePayload = attachmentUrl
              ? {
                  attachment: {
                    type: attachmentType,
                    payload: { url: attachmentUrl, is_reusable: true },
                  },
                }
              : { text: textContent };

            // 1. Gửi chuẩn RESPONSE tới /{externalPageId}/messages
            const primaryRes = await runWithProofFallback({
              ver,
              endpointPath: `${encodeURIComponent(channel.externalPageId)}/messages`,
              method: 'POST',
              bodyObj: {
                recipient: { id: cleanTargetId },
                messaging_type: 'RESPONSE',
                message: messagePayload,
              },
            });
            if (primaryRes.ok && primaryRes.externalId) {
              return {
                deliveryStatus: 'DISPATCHED',
                externalId: primaryRes.externalId,
              };
            }

            // 2. Nếu lỗi ngoài cửa sổ 24h (code 10 / subcode 2018278), tự động dùng HUMAN_AGENT tag (7 ngày)
            const errMsgLower = (primaryRes.errorMessage || '').toLowerCase();
            if (
              primaryRes.errorCode === 10 ||
              primaryRes.errorSubcode === 2018278 ||
              errMsgLower.includes('outside of allowed window') ||
              errMsgLower.includes('24 hour')
            ) {
              const humanAgentRes = await runWithProofFallback({
                ver,
                endpointPath: `${encodeURIComponent(channel.externalPageId)}/messages`,
                method: 'POST',
                bodyObj: {
                  recipient: { id: cleanTargetId },
                  messaging_type: 'MESSAGE_TAG',
                  tag: 'HUMAN_AGENT',
                  message: messagePayload,
                },
              });
              if (humanAgentRes.ok && humanAgentRes.externalId) {
                return {
                  deliveryStatus: 'DISPATCHED',
                  externalId: humanAgentRes.externalId,
                };
              }
            }

            // 3. Fallback gọi qua /me/messages nếu externalPageId khác biệt
            const meRes = await runWithProofFallback({
              ver,
              endpointPath: 'me/messages',
              method: 'POST',
              bodyObj: {
                recipient: { id: cleanTargetId },
                messaging_type: 'RESPONSE',
                message: messagePayload,
              },
            });
            if (meRes.ok && meRes.externalId) {
              return {
                deliveryStatus: 'DISPATCHED',
                externalId: meRes.externalId,
              };
            }

            // 4. Nếu khách hàng đến từ bình luận bài viết và chưa nhắn tin vào hộp thư Page lần nào
            // (khiến PSID chưa mở luồng Messenger trực tiếp), tự động gửi qua Private Reply `recipient: { comment_id }`
            if (fallbackCommentId && textContent) {
              const privateFallbackRes = await runWithProofFallback({
                ver,
                endpointPath: `${encodeURIComponent(channel.externalPageId)}/messages`,
                method: 'POST',
                bodyObj: {
                  recipient: { comment_id: fallbackCommentId },
                  message: { text: textContent },
                },
              });
              if (privateFallbackRes.ok && privateFallbackRes.externalId) {
                return {
                  deliveryStatus: 'DISPATCHED',
                  externalId: privateFallbackRes.externalId,
                };
              }
            }

            const isVersionErr =
              primaryRes.errorCode === 12 ||
              primaryRes.errorCode === 2635 ||
              /unknown path components|unsupported post request|invalid version|version/i.test(
                primaryRes.errorMessage || '',
              );
            if (!isVersionErr) {
              break;
            }
          } else if (params.actionType === 'REPLY_PUBLIC_COMMENT') {
            const endpointPath =
              channel.channelType === ChannelTypeEnum.INSTAGRAM
                ? `${encodeURIComponent(params.targetExternalId)}/replies`
                : `${encodeURIComponent(params.targetExternalId)}/comments`;
            const replyRes = await runWithProofFallback({
              ver,
              endpointPath,
              method: 'POST',
              bodyObj: {
                message: String(params.bodyPayload?.text || ''),
                ...(params.bodyPayload?.attachmentUrl
                  ? { attachment_url: String(params.bodyPayload.attachmentUrl) }
                  : {}),
              },
            });
            if (replyRes.ok && replyRes.externalId) {
              return {
                deliveryStatus: 'DISPATCHED',
                externalId: replyRes.externalId,
              };
            }

            const isVersionErr =
              replyRes.errorCode === 12 ||
              replyRes.errorCode === 2635 ||
              /unknown path components|unsupported post request|invalid version|version/i.test(
                replyRes.errorMessage || '',
              );
            if (!isVersionErr) {
              break;
            }
          } else if (params.actionType === 'EDIT_COMMENT') {
            const editRes = await runWithProofFallback({
              ver,
              endpointPath: encodeURIComponent(params.targetExternalId),
              method: 'POST',
              bodyObj: {
                message: String(params.bodyPayload?.text || ''),
              },
            });
            if (editRes.ok && editRes.externalId) {
              return {
                deliveryStatus: 'DISPATCHED',
                externalId: editRes.externalId,
              };
            }

            // Nếu nền tảng không cho phép sửa trực tiếp comment, tự động đăng bình luận phản hồi đính chính dưới bình luận gốc
            const fallbackParentCommentId = params.bodyPayload?.fallbackParentCommentId as
              | string
              | undefined;
            if (fallbackParentCommentId) {
              const fallbackReplyPath =
                channel.channelType === ChannelTypeEnum.INSTAGRAM
                  ? `${encodeURIComponent(fallbackParentCommentId)}/replies`
                  : `${encodeURIComponent(fallbackParentCommentId)}/comments`;
              const fallbackReplyRes = await runWithProofFallback({
                ver,
                endpointPath: fallbackReplyPath,
                method: 'POST',
                bodyObj: {
                  message: String(params.bodyPayload?.text || ''),
                },
              });
              if (fallbackReplyRes.ok && fallbackReplyRes.externalId) {
                return {
                  deliveryStatus: 'DISPATCHED',
                  externalId: fallbackReplyRes.externalId,
                };
              }
            }

            const isVersionErr =
              editRes.errorCode === 12 ||
              editRes.errorCode === 2635 ||
              /unknown path components|unsupported post request|invalid version|version/i.test(
                editRes.errorMessage || '',
              );
            if (!isVersionErr) {
              break;
            }
          } else if (params.actionType === 'SEND_PRIVATE_REPLY') {
            const privRes = await runWithProofFallback({
              ver,
              endpointPath: `${encodeURIComponent(channel.externalPageId)}/messages`,
              method: 'POST',
              bodyObj: {
                recipient: { comment_id: params.targetExternalId },
                message: { text: String(params.bodyPayload?.text || '') },
              },
            });
            if (privRes.ok && privRes.externalId) {
              return {
                deliveryStatus: 'DISPATCHED',
                externalId: privRes.externalId,
              };
            }

            const privMeRes = await runWithProofFallback({
              ver,
              endpointPath: 'me/messages',
              method: 'POST',
              bodyObj: {
                recipient: { comment_id: params.targetExternalId },
                message: { text: String(params.bodyPayload?.text || '') },
              },
            });
            if (privMeRes.ok && privMeRes.externalId) {
              return {
                deliveryStatus: 'DISPATCHED',
                externalId: privMeRes.externalId,
              };
            }

            const isVersionErr =
              privRes.errorCode === 12 ||
              privRes.errorCode === 2635 ||
              /unknown path components|unsupported post request|invalid version|version/i.test(
                privRes.errorMessage || '',
              );
            if (!isVersionErr) {
              break;
            }
          } else if (params.actionType === 'HIDE_UNHIDE_COMMENT') {
            const hideRes = await runWithProofFallback({
              ver,
              endpointPath: encodeURIComponent(params.targetExternalId),
              method: 'POST',
              bodyObj:
                channel.channelType === ChannelTypeEnum.INSTAGRAM
                  ? { hide: Boolean(params.bodyPayload?.isHidden) }
                  : { is_hidden: Boolean(params.bodyPayload?.isHidden) },
            });
            if (hideRes.ok) {
              return {
                deliveryStatus: 'DISPATCHED',
                externalId: hideRes.externalId || params.targetExternalId,
              };
            }
            break;
          } else if (params.actionType === 'LIKE_UNLIKE_COMMENT') {
            const likeRes = await runWithProofFallback({
              ver,
              endpointPath: `${encodeURIComponent(params.targetExternalId)}/likes`,
              method: params.bodyPayload?.isLiked ? 'POST' : 'DELETE',
              bodyObj: {},
            });
            if (likeRes.ok) {
              return {
                deliveryStatus: 'DISPATCHED',
                externalId: likeRes.externalId || params.targetExternalId,
              };
            }
            break;
          } else if (params.actionType === 'DELETE_COMMENT') {
            const delRes = await runWithProofFallback({
              ver,
              endpointPath: encodeURIComponent(params.targetExternalId),
              method: 'DELETE',
            });
            if (delRes.ok) {
              return {
                deliveryStatus: 'DISPATCHED',
                externalId: delRes.externalId || params.targetExternalId,
              };
            }
            break;
          }
        }
      } else if (
        channel.channelType === ChannelTypeEnum.ZALO_OA &&
        params.actionType === 'SEND_INBOX_MESSAGE'
      ) {
        const cleanZaloUserId = params.targetExternalId.replace(/^zalo_/, '').trim();
        const sendZaloRequest = async (tokenToUse: string) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          try {
            const res = await fetch('https://openapi.zalo.me/v3.0/oa/message/cs', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                access_token: tokenToUse,
              },
              body: JSON.stringify({
                recipient: { user_id: cleanZaloUserId },
                message: { text: String(params.bodyPayload?.text || '') },
              }),
              signal: controller.signal,
            }).catch(() => null);
            clearTimeout(timeoutId);
            if (!res) return { ok: false, errorCode: -1, messageId: null };
            const json = (await res.json().catch(() => ({}))) as {
              error?: number;
              message?: string;
              data?: { message_id?: string };
            };
            if (res.ok && (!json.error || json.error === 0)) {
              return {
                ok: true,
                errorCode: 0,
                messageId: String(json.data?.message_id || fallbackExternalId),
              };
            }
            return { ok: false, errorCode: Number(json.error ?? -1), messageId: null };
          } catch {
            clearTimeout(timeoutId);
            return { ok: false, errorCode: -1, messageId: null };
          }
        };

        const firstZaloRes = await sendZaloRequest(rawToken);
        if (firstZaloRes.ok && firstZaloRes.messageId) {
          return {
            deliveryStatus: 'DISPATCHED',
            externalId: firstZaloRes.messageId,
          };
        }

        // Nếu Zalo OA Access Token hết hạn (-216 hoặc -124), tự động dùng Refresh Token xoay vòng và gửi lại ngay lập tức
        if (firstZaloRes.errorCode === -216 || firstZaloRes.errorCode === -124) {
          const healedZaloToken = await this.recoverExpiredChannelPageTokenInline(
            channel,
            '',
            'v3.0',
          );
          if (healedZaloToken && healedZaloToken !== rawToken) {
            const retryZaloRes = await sendZaloRequest(healedZaloToken);
            if (retryZaloRes.ok && retryZaloRes.messageId) {
              return {
                deliveryStatus: 'DISPATCHED',
                externalId: retryZaloRes.messageId,
              };
            }
          }
        }
      }
    } catch {
      // Bảo toàn luồng hoạt động khi môi trường không kết nối Internet
    }

    return {
      deliveryStatus: 'SIMULATED_SANDBOX',
      externalId: fallbackExternalId,
    };
  }

  /**
   * Điều phối gửi tin nhắn trả lời của nhân viên Sale ra đúng kênh ngoại vi (Inbox hoặc Trả lời Bình luận công khai)
   * và tự động ẩn bình luận gốc của khách nếu bật cờ autoHideCommentOnReply.
   */
  private async dispatchOutboundConversationMessageToPlatform(params: {
    conversation: ConversationEntity;
    savedMessage: MessageEntity;
    cleanContent: string;
    senderId: string;
    commentReplyMode?: string;
    autoHideCommentOnReply?: boolean;
  }): Promise<void> {
    const { conversation, savedMessage, cleanContent, senderId } = params;
    const isCommentConv =
      conversation.interactionType === 'COMMENT' || conversation.interactionType === 'LIVESTREAM';

    const { recipientPsid, latestCommentId } =
      await this.resolveCustomerRecipientForConversation(conversation);

    let targetExternalId = recipientPsid || conversation.externalThreadId || conversation.id;
    let latestInboundComment: MessageEntity | null = null;

    if (isCommentConv) {
      if (savedMessage.replyToMessageId) {
        latestInboundComment = await this.msgRepository.findOne({
          where: {
            id: savedMessage.replyToMessageId,
            conversationId: conversation.id,
          },
        });
      }
      if (!latestInboundComment) {
        latestInboundComment = await this.msgRepository.findOne({
          where: {
            conversationId: conversation.id,
            direction: MessageDirectionEnum.INBOUND,
          },
          order: { createdAt: 'DESC' },
        });
      }
      if (latestInboundComment) {
        targetExternalId =
          latestInboundComment.metadata?.externalCommentId ||
          latestInboundComment.externalMessageId ||
          latestCommentId ||
          targetExternalId;
      }
    }

    await this.consumeMetaGraphActionQuota(
      conversation.channelIntegrationId || conversation.shopId || conversation.id,
      750,
    );

    const firstAttachment = savedMessage.metadata?.attachments?.[0];
    const attachmentUrl = firstAttachment?.url || undefined;
    const attachmentType = firstAttachment?.mimeType?.startsWith('video/')
      ? 'video'
      : firstAttachment?.mimeType?.startsWith('audio/')
        ? 'audio'
        : firstAttachment?.mimeType?.startsWith('image/')
          ? 'image'
          : 'file';

    const requestedReplyMode = params.commentReplyMode || 'REPLY_COMMENT_ONLY';
    let dispatchRes: {
      deliveryStatus: 'DISPATCHED' | 'SIMULATED_SANDBOX';
      externalId: string;
    };

    if (isCommentConv && requestedReplyMode === 'SEND_PRIVATE_REPLY_ONLY') {
      dispatchRes = await this.executePlatformHttpCall({
        channelIntegrationId: conversation.channelIntegrationId,
        shopId: conversation.shopId,
        actionType: 'SEND_PRIVATE_REPLY',
        targetExternalId,
        bodyPayload: { text: cleanContent },
      });
    } else {
      dispatchRes = await this.executePlatformHttpCall({
        channelIntegrationId: conversation.channelIntegrationId,
        shopId: conversation.shopId,
        actionType: isCommentConv ? 'REPLY_PUBLIC_COMMENT' : 'SEND_INBOX_MESSAGE',
        targetExternalId,
        bodyPayload: {
          text: cleanContent,
          attachmentUrl,
          attachmentType,
          fallbackCommentId: latestCommentId || undefined,
        },
      });
    }

    const updatedMeta: MessageMetadata = {
      ...(savedMessage.metadata || {}),
      platformDeliveryStatus: dispatchRes.deliveryStatus,
      platformExternalId: dispatchRes.externalId,
    };

    await this.msgRepository.update(
      { id: savedMessage.id, createdAt: savedMessage.createdAt },
      {
        externalMessageId: dispatchRes.externalId,
        metadata: updatedMeta as any,
      },
    );
    savedMessage.externalMessageId = dispatchRes.externalId;
    savedMessage.metadata = updatedMeta;

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      conversation.id,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.OUTBOUND_DELIVERY_STATUS,
      {
        conversationId: conversation.id,
        messageId: savedMessage.id,
        platformDeliveryStatus: dispatchRes.deliveryStatus,
        platformExternalId: dispatchRes.externalId,
        timestamp: new Date().toISOString(),
      },
    );

    if (
      isCommentConv &&
      params.autoHideCommentOnReply &&
      latestInboundComment &&
      !latestInboundComment.metadata?.isHiddenOnPlatform
    ) {
      const visibilityRes = await this.toggleCommentVisibilityOnPlatform({
        userId: senderId,
        conversationId: conversation.id,
        messageId: latestInboundComment.id,
        isHidden: true,
      }).catch(() => null);

      if (visibilityRes) {
        this.realtimeEmitter.emitToConversation(
          SOCKET_CONFIG.namespaces.CHAT,
          conversation.id,
          SOCKET_CONFIG.events.OMNICHANNEL_INBOX.COMMENT_VISIBILITY_UPDATED,
          visibilityRes,
        );
      }
    }
  }

  /**
   * Đồng bộ nội dung tin nhắn / bình luận mà người bán vừa chỉnh sửa (`editMessage`) ra nền tảng ngoại vi:
   * - Với luồng Bình luận (`COMMENT` / `LIVESTREAM`): Gọi `POST /{apiVersion}/{comment_id}` (`EDIT_COMMENT`) để sửa trực tiếp
   *   bình luận của Fanpage trên bài viết; nếu nền tảng từ chối sửa trực tiếp thì tự động đăng bình luận đính chính dưới bình luận khách.
   * - Với luồng Tin nhắn (`INBOX` trên Messenger / Instagram DM / Zalo OA): Tự động gửi ngay bản tin cập nhật (`SEND_INBOX_MESSAGE`)
   *   vào hộp thư của khách hàng để khách nhận được nội dung mới tức thì trên điện thoại.
   */
  private async dispatchOutboundEditedMessageToPlatform(params: {
    conversation: ConversationEntity;
    message: MessageEntity;
    cleanContent: string;
  }): Promise<void> {
    const { conversation, message, cleanContent } = params;
    const isCommentConv =
      conversation.interactionType === 'COMMENT' || conversation.interactionType === 'LIVESTREAM';

    await this.consumeMetaGraphActionQuota(
      conversation.channelIntegrationId || conversation.shopId || conversation.id,
      750,
    );

    const { recipientPsid, latestCommentId } =
      await this.resolveCustomerRecipientForConversation(conversation);

    let dispatchRes: {
      deliveryStatus: 'DISPATCHED' | 'SIMULATED_SANDBOX';
      externalId: string;
    };

    if (isCommentConv) {
      const existingPlatformCommentId =
        message.metadata?.platformEditedExternalId ||
        message.metadata?.platformExternalId ||
        message.externalMessageId;

      if (existingPlatformCommentId && !existingPlatformCommentId.startsWith('ext_')) {
        dispatchRes = await this.executePlatformHttpCall({
          channelIntegrationId: conversation.channelIntegrationId,
          shopId: conversation.shopId,
          actionType: 'EDIT_COMMENT',
          targetExternalId: existingPlatformCommentId,
          bodyPayload: {
            text: cleanContent,
            fallbackParentCommentId: latestCommentId || undefined,
          },
        });
      } else {
        const parentTargetId = latestCommentId || conversation.externalThreadId || conversation.id;

        dispatchRes = await this.executePlatformHttpCall({
          channelIntegrationId: conversation.channelIntegrationId,
          shopId: conversation.shopId,
          actionType: 'REPLY_PUBLIC_COMMENT',
          targetExternalId: parentTargetId,
          bodyPayload: { text: cleanContent },
        });
      }
    } else {
      const targetExternalId = recipientPsid || conversation.externalThreadId || conversation.id;
      dispatchRes = await this.executePlatformHttpCall({
        channelIntegrationId: conversation.channelIntegrationId,
        shopId: conversation.shopId,
        actionType: 'SEND_INBOX_MESSAGE',
        targetExternalId,
        bodyPayload: {
          text: cleanContent,
          fallbackCommentId: latestCommentId || undefined,
        },
      });
    }

    const nowIso = new Date().toISOString();
    const updatedMeta: MessageMetadata = {
      ...(message.metadata || {}),
      platformDeliveryStatus: dispatchRes.deliveryStatus,
      platformEditedExternalId:
        dispatchRes.externalId || message.metadata?.platformExternalId || null,
      platformEditSyncedAt: nowIso,
    };

    await this.msgRepository.update(
      { id: message.id, createdAt: message.createdAt },
      {
        metadata: updatedMeta as any,
      },
    );
    message.metadata = updatedMeta;

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      conversation.id,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.OUTBOUND_DELIVERY_STATUS,
      {
        conversationId: conversation.id,
        messageId: message.id,
        platformDeliveryStatus: dispatchRes.deliveryStatus,
        platformExternalId: updatedMeta.platformEditedExternalId,
        platformEditSyncedAt: nowIso,
        timestamp: nowIso,
      },
    );
  }

  /**
   * F03.3 & F03.4: Ẩn hoặc hiện bình luận của khách trên nền tảng gốc (Facebook / Instagram / TikTok)
   */
  async toggleCommentVisibilityOnPlatform(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    isHidden: boolean;
  }) {
    await this.ensureParticipant(params.conversationId, params.userId);
    const [msg, conv, recipientIds] = await Promise.all([
      this.msgRepository.findOne({
        where: { id: params.messageId, conversationId: params.conversationId },
      }),
      this.convRepository.findOne({
        where: { id: params.conversationId },
        select: ['id', 'shopId', 'channelIntegrationId'],
      }),
      this.getConversationMemberIds(params.conversationId),
    ]);
    if (!msg) {
      throw new NotFoundException('COMMENT_MESSAGE_NOT_FOUND');
    }

    const externalCommentId = msg.metadata?.externalCommentId || msg.externalMessageId || msg.id;

    const dispatchRes = await this.executePlatformHttpCall({
      channelIntegrationId: conv?.channelIntegrationId,
      shopId: conv?.shopId,
      actionType: 'HIDE_UNHIDE_COMMENT',
      targetExternalId: externalCommentId,
      bodyPayload: { isHidden: params.isHidden },
    });

    const nowIso = new Date().toISOString();
    msg.metadata = {
      ...(msg.metadata || {}),
      isHiddenOnPlatform: params.isHidden,
      hiddenByAgentId: params.isHidden ? params.userId : undefined,
      hiddenAt: params.isHidden ? nowIso : undefined,
      platformDeliveryStatus: dispatchRes.deliveryStatus,
    };
    await this.msgRepository.save(msg);

    return {
      conversationId: params.conversationId,
      messageId: msg.id,
      isHiddenOnPlatform: params.isHidden,
      hiddenByAgentId: params.isHidden ? params.userId : null,
      hiddenAt: params.isHidden ? nowIso : null,
      platformDeliveryStatus: dispatchRes.deliveryStatus,
      recipientIds,
    };
  }

  /**
   * F03.3 & F03.4: Thả tim / Thích bình luận của khách dưới tư cách Fanpage.
   */
  async toggleCommentLikeOnPlatform(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    isLiked: boolean;
  }) {
    await this.ensureParticipant(params.conversationId, params.userId);
    const [msg, conv, recipientIds] = await Promise.all([
      this.msgRepository.findOne({
        where: { id: params.messageId, conversationId: params.conversationId },
      }),
      this.convRepository.findOne({
        where: { id: params.conversationId },
        select: ['id', 'shopId', 'channelIntegrationId'],
      }),
      this.getConversationMemberIds(params.conversationId),
    ]);
    if (!msg) {
      throw new NotFoundException('COMMENT_MESSAGE_NOT_FOUND');
    }

    const externalCommentId = msg.metadata?.externalCommentId || msg.externalMessageId || msg.id;

    const dispatchRes = await this.executePlatformHttpCall({
      channelIntegrationId: conv?.channelIntegrationId,
      shopId: conv?.shopId,
      actionType: 'LIKE_UNLIKE_COMMENT',
      targetExternalId: externalCommentId,
      bodyPayload: { isLiked: params.isLiked },
    });

    msg.metadata = {
      ...(msg.metadata || {}),
      isLikedByPage: params.isLiked,
      likedByAgentId: params.isLiked ? params.userId : undefined,
      platformDeliveryStatus: dispatchRes.deliveryStatus,
    };
    await this.msgRepository.save(msg);

    return {
      conversationId: params.conversationId,
      messageId: msg.id,
      isLikedByPage: params.isLiked,
      likedByAgentId: params.isLiked ? params.userId : null,
      platformDeliveryStatus: dispatchRes.deliveryStatus,
      recipientIds,
    };
  }

  /**
   * F03.3 & F03.4: Xóa bình luận trên nền tảng gốc (DELETE /{comment_id}) khi nhân viên xử lý spam/rải link,
   * đồng thời giữ lại bản ghi trong DB với cờ `isDeletedOnPlatform = true` và `deletedByActor = 'AGENT'` để kiểm toán.
   */
  async deleteCommentOnPlatform(params: {
    userId: string;
    conversationId: string;
    messageId: string;
  }) {
    await this.ensureParticipant(params.conversationId, params.userId);
    const [msg, conv, recipientIds] = await Promise.all([
      this.msgRepository.findOne({
        where: { id: params.messageId, conversationId: params.conversationId },
      }),
      this.convRepository.findOne({
        where: { id: params.conversationId },
        select: ['id', 'shopId', 'channelIntegrationId'],
      }),
      this.getConversationMemberIds(params.conversationId),
    ]);
    if (!msg) {
      throw new NotFoundException('COMMENT_MESSAGE_NOT_FOUND');
    }

    const externalCommentId = msg.metadata?.externalCommentId || msg.externalMessageId || msg.id;

    const dispatchRes = await this.executePlatformHttpCall({
      channelIntegrationId: conv?.channelIntegrationId,
      shopId: conv?.shopId,
      actionType: 'DELETE_COMMENT',
      targetExternalId: externalCommentId,
    });

    const nowIso = new Date().toISOString();
    msg.metadata = {
      ...(msg.metadata || {}),
      isDeletedOnPlatform: true,
      deletedByActor: 'AGENT',
      deletedByAgentId: params.userId,
      deletedOnPlatformAt: nowIso,
      platformDeliveryStatus: dispatchRes.deliveryStatus,
    };
    await this.msgRepository.save(msg);

    return {
      conversationId: params.conversationId,
      messageId: msg.id,
      isDeletedOnPlatform: true,
      deletedByActor: 'AGENT' as const,
      deletedByAgentId: params.userId,
      deletedOnPlatformAt: nowIso,
      platformDeliveryStatus: dispatchRes.deliveryStatus,
      recipientIds,
    };
  }

  /**
   * F03.3 & F03.4: Gửi Tin Nhắn Riêng (Private Reply Inbox) từ một Bình luận công khai (Comment / Livestream).
   * Kiểm tra chặt chẽ giới hạn của Meta Graph API:
   * 1. Bình luận phải nằm trong cửa sổ 7 ngày (7 * 24h) kể từ thời điểm khách đăng bình luận.
   * 2. Mỗi `comment_id` chỉ được phép gửi duy nhất 1 Private Reply.
   */
  async sendPrivateReplyFromComment(params: {
    senderId: string;
    conversationId: string;
    commentMessageId: string;
    content: string;
    autoHideComment?: boolean;
    autoLikeComment?: boolean;
  }) {
    await this.ensureParticipant(params.conversationId, params.senderId);

    const commentMsg = await this.msgRepository.findOne({
      where: { id: params.commentMessageId, conversationId: params.conversationId },
    });
    if (!commentMsg) {
      throw new NotFoundException('COMMENT_MESSAGE_NOT_FOUND');
    }

    if (commentMsg.metadata?.privateReplySentAt) {
      throw new BadRequestException('PRIVATE_REPLY_ALREADY_SENT_FOR_COMMENT');
    }

    const sevenDaysMs = 7 * 24 * 3600 * 1000;
    const commentAgeMs = Date.now() - new Date(commentMsg.createdAt).getTime();
    if (commentAgeMs > sevenDaysMs) {
      throw new BadRequestException('PRIVATE_REPLY_7DAY_WINDOW_EXPIRED');
    }

    const parentConv = await this.convRepository.findOne({
      where: { id: params.conversationId },
    });
    if (!parentConv) {
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    await this.consumeMetaGraphActionQuota(
      parentConv.channelIntegrationId || parentConv.shopId || parentConv.id,
      750,
    );

    const externalCommentId =
      commentMsg.metadata?.externalCommentId || commentMsg.externalMessageId || commentMsg.id;

    const privateReplyDispatch = await this.executePlatformHttpCall({
      channelIntegrationId: parentConv.channelIntegrationId,
      shopId: parentConv.shopId,
      actionType: 'SEND_PRIVATE_REPLY',
      targetExternalId: externalCommentId,
      bodyPayload: { text: params.content.trim() },
    });

    if (params.autoHideComment) {
      await this.executePlatformHttpCall({
        channelIntegrationId: parentConv.channelIntegrationId,
        shopId: parentConv.shopId,
        actionType: 'HIDE_UNHIDE_COMMENT',
        targetExternalId: externalCommentId,
        bodyPayload: { isHidden: true },
      });
    }

    if (params.autoLikeComment) {
      await this.executePlatformHttpCall({
        channelIntegrationId: parentConv.channelIntegrationId,
        shopId: parentConv.shopId,
        actionType: 'LIKE_UNLIKE_COMMENT',
        targetExternalId: externalCommentId,
        bodyPayload: { isLiked: true },
      });
    }

    const { recipientPsid } = await this.resolveCustomerRecipientForConversation(parentConv);
    const derivedInboxThreadId = recipientPsid
      ? `inbox_${recipientPsid}`
      : `inbox_${parentConv.id.slice(0, 12)}`;

    let inboxConv = await this.convRepository.findOne({
      where: {
        shopId: parentConv.shopId || undefined,
        channelIntegrationId: parentConv.channelIntegrationId || undefined,
        interactionType: 'INBOX',
        name: parentConv.name,
      },
    });

    const now = new Date();
    if (!inboxConv) {
      inboxConv = this.convRepository.create({
        type: ConversationTypeEnum.DIRECT,
        name: parentConv.name,
        avatar: parentConv.avatar,
        shopId: parentConv.shopId,
        channelType: parentConv.channelType,
        channelIntegrationId: parentConv.channelIntegrationId,
        externalThreadId: derivedInboxThreadId,
        interactionType: 'INBOX',
        customerId: parentConv.customerId,
        assignedAgentId: params.senderId,
        supportStatus: ConversationSupportStatusEnum.WAITING_CUSTOMER_REPLY,
        sourcePostId: parentConv.sourcePostId,
        sourceAdId: parentConv.sourceAdId,
        lastMessageAt: now,
        lastAgentReplyAt: now,
        createdAt: now,
        updatedAt: now,
      });
      inboxConv = await this.convRepository.save(inboxConv);

      const parentMemberIds = await this.getConversationMemberIds(parentConv.id);
      const uniquePartIds = Array.from(new Set([params.senderId, ...parentMemberIds]));
      const partEntities = uniquePartIds.map((uid) =>
        this.partRepository.create({
          conversationId: inboxConv!.id,
          userId: uid,
          isAdmin: uid === params.senderId,
          joinedAt: now,
          lastReadAt: now,
        }),
      );
      await this.partRepository.save(partEntities).catch(() => undefined);
    } else if (!inboxConv.externalThreadId && derivedInboxThreadId) {
      inboxConv.externalThreadId = derivedInboxThreadId;
      await this.convRepository
        .update(inboxConv.id, { externalThreadId: derivedInboxThreadId })
        .catch(() => undefined);
    }

    const decryptedCommentPreview = this.messageCryptoService
      .decryptForConversation(commentMsg.content, params.conversationId)
      .slice(0, 160);

    // Đánh dấu skipPlatformDispatch: true vì SEND_PRIVATE_REPLY đã được chuyển phát ở bước trên
    const inboxMsgRes = await this.sendMessage({
      senderId: params.senderId,
      dto: {
        conversationId: inboxConv.id,
        content: params.content.trim(),
        type: MessageTypeEnum.TEXT,
        metadata: {
          skipPlatformDispatch: true,
          commentReplyMode: 'SEND_PRIVATE_REPLY_ONLY',
          externalCommentId,
          externalPostId: parentConv.sourcePostId || undefined,
          externalCustomerPsid: recipientPsid || undefined,
          platformDeliveryStatus: privateReplyDispatch.deliveryStatus,
          platformExternalId: privateReplyDispatch.externalId,
          replyPreview: {
            messageId: commentMsg.id,
            senderId: commentMsg.senderId,
            senderName: parentConv.name || 'Khách hàng',
            content: `[Bình luận bài viết]: ${decryptedCommentPreview}`,
            type: MessageTypeEnum.TEXT,
          },
        },
      },
    });

    if (inboxMsgRes.message) {
      this.realtimeEmitter.emitToConversation(
        SOCKET_CONFIG.namespaces.CHAT,
        inboxConv.id,
        SOCKET_CONFIG.events.CHAT.NEW_MESSAGE,
        inboxMsgRes.message,
      );
      inboxMsgRes.recipientIds.forEach((uid) => {
        this.realtimeEmitter.emitToUser(
          SOCKET_CONFIG.namespaces.CHAT,
          uid,
          SOCKET_CONFIG.events.CHAT.NEW_MESSAGE,
          inboxMsgRes.message,
        );
      });
    }

    const nowIso = now.toISOString();
    commentMsg.metadata = {
      ...(commentMsg.metadata || {}),
      privateReplySentAt: nowIso,
      privateReplyByAgentId: params.senderId,
      linkedInboxConversationId: inboxConv.id,
      platformDeliveryStatus: privateReplyDispatch.deliveryStatus,
      platformExternalId: privateReplyDispatch.externalId,
      ...(params.autoHideComment
        ? { isHiddenOnPlatform: true, hiddenByAgentId: params.senderId, hiddenAt: nowIso }
        : {}),
      ...(params.autoLikeComment ? { isLikedByPage: true, likedByAgentId: params.senderId } : {}),
    };
    await this.msgRepository.save(commentMsg);

    const recipientIds = await this.getConversationMemberIds(params.conversationId);

    return {
      conversationId: params.conversationId,
      commentMessageId: commentMsg.id,
      linkedInboxConversationId: inboxConv.id,
      privateReplySentAt: nowIso,
      privateReplyByAgentId: params.senderId,
      isHiddenOnPlatform: Boolean(commentMsg.metadata.isHiddenOnPlatform),
      isLikedByPage: Boolean(commentMsg.metadata.isLikedByPage),
      platformDeliveryStatus: privateReplyDispatch.deliveryStatus,
      recipientIds,
    };
  }
}
