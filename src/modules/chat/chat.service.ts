/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import {
  ConversationTypeEnum,
  MediaTypeEnum,
  MessageStatusEnum,
  MessageTypeEnum,
} from 'src/common/enum';
import { AdvancedQueryHelper } from 'src/common/helper/query.helper';
import { SocketStateService } from 'src/common/websocket/socket-state.service';
import { ChatEventEnum, ChatMessageReadEvent } from 'src/config/websocket/events/chat.events';
import { CreateGroupDto, SendMessageDto } from 'src/dto/chat/chat.dto';
import { CreateDirectChatDto } from 'src/dto/chat/create-direct-chat.dto';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { MediaEntity } from 'src/entity/media.entity';
import { MessageEntity } from 'src/entity/message.entity';
import { UserEntity } from 'src/entity/user.entity';
import { IBaseQuery } from 'src/interface';
import { PaginationOptions } from 'src/types/query.types';
import { DataSource, Repository } from 'typeorm';

import { UserService } from '../user/user.service';

@Injectable()
export class ChatService {
  constructor(
    @InjectRepository(ConversationEntity)
    private convRepository: Repository<ConversationEntity>,
    @InjectRepository(MessageEntity)
    private msgRepository: Repository<MessageEntity>,
    @InjectRepository(ConversationParticipantEntity)
    private partRepository: Repository<ConversationParticipantEntity>,
    private dataSource: DataSource,
    private readonly userService: UserService,
    private readonly socketStateService: SocketStateService,
    private readonly eventEmitter: EventEmitter2,
  ) {}
  private readonly logger = new Logger(ChatService.name, {
    timestamp: true,
  });

  async sendMessage(payload: { senderId: string; dto: SendMessageDto }) {
    const label = '[sendMessage]';
    const { senderId, dto } = payload;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const participant = await this.partRepository.findOne({
        where: { conversationId: dto.conversationId, userId: senderId },
      });
      if (!participant) throw new ForbiddenException('Not a member of this chat');

      const message = this.msgRepository.create({
        conversationId: dto.conversationId,
        senderId,
        content: dto.content,
        type: dto.type,
        metadata: dto.metadata,
        readBy: [],
        deliveredTo: [],
        status: MessageStatusEnum.SENT,
      });
      const savedMessage = await queryRunner.manager.save(message);

      await queryRunner.manager.update(ConversationEntity, dto.conversationId, {
        lastMessage: dto.type === MessageTypeEnum.TEXT ? dto.content : `[${dto.type}]`,
        lastMessageSenderId: senderId,
        lastMessageAt: savedMessage.createdAt,
        lastMessageType: dto.type,
      });

      await queryRunner.manager.update(ConversationParticipantEntity, participant.id, {
        lastReadAt: savedMessage.createdAt,
      });

      const participants = await this.partRepository.find({
        where: { conversationId: dto.conversationId },
        select: ['userId'],
      });

      await queryRunner.commitTransaction();

      const fullMessage = await this.msgRepository
        .createQueryBuilder('m')
        .where('m.id = :id', { id: savedMessage.id })
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
      let finalMessage: any = fullMessage;

      if (fullMessage && fullMessage.sender) {
        const sender = fullMessage.sender as any;
        const avatarUrl = sender.avatarMedia?.file?.url || null;

        delete sender.avatarMedia;

        sender.avatar = avatarUrl;
        finalMessage = { ...fullMessage, sender };
      }
      this.logger.debug(`${label} messageId -> ${JSON.stringify(message.id)}`);
      return {
        message: { ...finalMessage, tempId: dto.tempId },
        recipientIds: participants.map((p) => p.userId),
      };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async getMessages(payload: {
    conversationId: string;
    userId: string;
    pagination: PaginationOptions;
  }) {
    const { conversationId, userId, pagination } = payload;

    const isMember = await this.partRepository.exists({
      where: { conversationId, userId },
    });
    if (!isMember) throw new ForbiddenException();

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

    const finalData = result.data.map((msg: any) => {
      const sender = msg.sender;
      const avatarUrl = sender?.avatarMedia?.file?.url || null;
      if (sender) delete sender.avatarMedia;
      const cleanSender = { ...sender, avatar: avatarUrl };

      const computedStatus = this.computeStatus(msg, userId);

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
        sender: cleanSender,
        status: computedStatus,
        readByUsers: readByUsers,
      };
    });

    return { ...result, data: finalData };
  }

  async createGroupChat(payload: { creatorId: string; dto: CreateGroupDto }) {
    const { creatorId, dto } = payload;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const conversation = this.convRepository.create({
        name: dto.name,
        type: ConversationTypeEnum.GROUP,
        lastMessageAt: new Date(),
      });
      const savedConv = await queryRunner.manager.save(conversation);

      const uniqueIds = [...new Set([creatorId, ...dto.memberIds])];
      const participants = uniqueIds.map((uid) =>
        this.partRepository.create({
          conversationId: savedConv.id,
          userId: uid,
          isAdmin: uid === creatorId,
          joinedAt: new Date(),
        }),
      );

      await queryRunner.manager.save(participants);
      await queryRunner.commitTransaction();

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
          .andWhere('m.createdAt > mp.lastReadAt');
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

    const result = await helper.getPaginatedRaw(query);

    const partnerIds = result.data
      .filter((c: any) => c.type === ConversationTypeEnum.DIRECT && c.partnerUser)
      .map((c: any) => c.partnerUser.id);

    const onlineSet = await this.socketStateService.getOnlineUsers(partnerIds);

    const finalData = result.data.map((conv: any) => {
      const myParticipant = conv.participants?.[0];
      let isOnline = false;
      let avatar = null;
      if (conv.type === ConversationTypeEnum.DIRECT && conv.partnerUser) {
        conv.name = conv.partnerUser.name;
        avatar = conv.partnerUser.avatarMedia?.file?.url || null;
        conv.partnerId = conv.partnerUser.id;
        isOnline = onlineSet.has(conv.partnerUser.id);
      }

      delete conv.partner;
      delete conv.partnerUser;
      delete conv.participants;

      return {
        ...conv,
        isOnline,
        avatar,
        isAdmin: myParticipant?.isAdmin || false,
        isMuted: myParticipant?.isMuted || false,
        joinedAt: myParticipant?.joinedAt || new Date(),
        lastReadAt: myParticipant?.lastReadAt,
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
      .getRawMany();

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

    const existingConversation = await this.convRepository
      .createQueryBuilder('c')
      .innerJoin('c.participants', 'p1')
      .innerJoin('c.participants', 'p2')
      .where('c.type = :type', { type: ConversationTypeEnum.DIRECT })
      .andWhere('p1.userId = :senderId', { senderId })
      .andWhere('p2.userId = :receiverId', { receiverId })
      .getOne();

    if (existingConversation) {
      return this.enrichConversationInfo(existingConversation, receiverId);
    }

    const queryRunner = this.dataSource.createQueryBuilder().connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const newConv = this.convRepository.create({
        type: ConversationTypeEnum.DIRECT,
        lastMessageAt: new Date(),
      });
      const savedConv = await queryRunner.manager.save(newConv);

      const participants = [senderId, receiverId].map((uid) =>
        this.partRepository.create({
          conversationId: savedConv.id,
          userId: uid,
          joinedAt: new Date(),
        }),
      );
      await queryRunner.manager.save(participants);

      await queryRunner.commitTransaction();

      return this.enrichConversationInfo(savedConv, receiverId);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async enrichConversationInfo(conversation: ConversationEntity, partnerId: string) {
    const partner = await this.dataSource.getRepository(UserEntity).findOne({
      where: { id: partnerId },
      select: ['id', 'name', 'email', 'status'],
    });

    return {
      ...conversation,
      partnerInfo: partner,
    };
  }

  async markConversationAsRead(payload: { userId: string; conversationId: string }) {
    const label = '[markConversationAsRead]';
    const { conversationId, userId } = payload;
    this.logger.debug(`${label} conversationId -> ${conversationId}`);

    const now = new Date();

    await this.partRepository.update({ conversationId, userId }, { lastReadAt: now });

    await this.msgRepository
      .createQueryBuilder()
      .update(MessageEntity)
      .set({
        readBy: () => `JSON_ARRAY_APPEND(COALESCE(readBy, JSON_ARRAY()), '$', '${userId}')`,
      })
      .where('conversationId = :conversationId', { conversationId })
      .andWhere('senderId != :userId', { userId })
      .andWhere(`NOT JSON_CONTAINS(readBy, '"${userId}"', '$')`)
      .execute();

    const users = await this.userService.getBasicUsersInfo([userId]);
    const user = users[0];

    const userReaderInfo = user
      ? {
          id: user.id,
          name: user.name,
          avatar: (user as any).avatarMedia?.file?.url || null,
        }
      : { id: userId, name: 'Unknown', avatar: null };

    const event = new ChatMessageReadEvent(conversationId, userId, now, userReaderInfo);
    this.eventEmitter.emit(ChatEventEnum.MESSAGE_READ, event);

    return { success: true };
  }

  async markAsDelivered(payload: { userId: string; messageId: string }) {
    const { userId, messageId } = payload;

    await this.msgRepository
      .createQueryBuilder()
      .update(MessageEntity)
      .set({
        deliveredTo: () =>
          `JSON_ARRAY_APPEND(COALESCE(deliveredTo, JSON_ARRAY()), '$', '${userId}')`,
      })
      .where('id = :messageId', { messageId })
      .andWhere('senderId != :userId', { userId })
      .andWhere(`NOT JSON_CONTAINS(deliveredTo, '"${userId}"', '$')`)
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

  async processUndeliveredMessages(userId: string) {
    const pendingMessages = await this.msgRepository
      .createQueryBuilder('m')
      .select(['m.id', 'm.conversationId', 'm.senderId'])
      .where('m.senderId != :userId', { userId })
      .andWhere(`NOT JSON_CONTAINS(COALESCE(m.deliveredTo, JSON_ARRAY()), '"${userId}"', '$')`)
      .getMany();

    if (pendingMessages.length === 0) return {};

    await this.msgRepository
      .createQueryBuilder()
      .update(MessageEntity)
      .set({
        deliveredTo: () =>
          `JSON_ARRAY_APPEND(COALESCE(deliveredTo, JSON_ARRAY()), '$', '${userId}')`,
      })
      .whereInIds(pendingMessages.map((m) => m.id))
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
