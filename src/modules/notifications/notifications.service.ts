/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { MediaTypeEnum, NotificationResourceTypeEnum, NotificationTypeEnum } from 'src/common/enum';
import { AdvancedQueryHelper } from 'src/common/helper/query.helper';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { CreateNotificationPayload } from 'src/config/websocket/events/notification.events';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { GetNotificationsQueryDto } from 'src/dto/notification/notification.dto';
import { MediaEntity } from 'src/entity/media.entity';
import { NotificationEntity } from 'src/entity/notification.entity';
import { Repository } from 'typeorm';

import { UserService } from '../user/user.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name, {
    timestamp: true,
  });

  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notificationRepo: Repository<NotificationEntity>,
    private readonly userService: UserService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  /**
   * Tạo hoặc gộp (Coalesce/Upsert) thông báo cho danh sách người nhận và phát sự kiện Real-time.
   * Thiết kế chịu lỗi cao (Fault-Tolerant): Không làm gián đoạn luồng nghiệp vụ chính nếu có lỗi phụ.
   */
  async createAndDispatch(payload: CreateNotificationPayload): Promise<void> {
    try {
      const uniqueRecipients = [...new Set(payload.recipientIds)].filter(
        (uid) => Boolean(uid) && uid !== payload.actorId,
      );

      if (uniqueRecipients.length === 0) return;

      let actorInfo: { id: string; name: string; avatar: string | null } | null = null;
      if (payload.actorId) {
        const users = await this.userService.getBasicUsersInfo([payload.actorId]);
        const actor = users[0] as any;
        if (actor) {
          actorInfo = {
            id: actor.id,
            name: actor.name,
            avatar: actor.avatarMedia?.file?.url || null,
          };
        }
      }

      const now = new Date();

      for (const recipientId of uniqueRecipients) {
        let savedEntity: NotificationEntity | null = null;
        let isUpdatedExisting = false;

        if (payload.dedupeKey) {
          const existingUnread = await this.notificationRepo.findOne({
            where: {
              recipientId,
              dedupeKey: payload.dedupeKey,
              isRead: false,
            },
            order: { createdAt: 'DESC' },
          });

          if (existingUnread) {
            const prevCount = Number(existingUnread.metadata?.unreadMessageCount || 1);
            const nextCount =
              payload.type === NotificationTypeEnum.NEW_MESSAGE ? prevCount + 1 : prevCount;

            existingUnread.actorId = payload.actorId ?? existingUnread.actorId;
            existingUnread.title = payload.title;
            existingUnread.content = payload.content;
            existingUnread.updatedAt = now;
            existingUnread.createdAt = now;
            existingUnread.metadata = {
              ...(existingUnread.metadata || {}),
              ...(payload.metadata || {}),
              unreadMessageCount: nextCount,
            };

            savedEntity = await this.notificationRepo.save(existingUnread);
            isUpdatedExisting = true;
          }
        }

        if (!savedEntity) {
          const newNotif = this.notificationRepo.create({
            recipientId,
            actorId: payload.actorId || null,
            type: payload.type,
            title: payload.title,
            content: payload.content,
            resourceType: payload.resourceType || NotificationResourceTypeEnum.SYSTEM,
            resourceId: payload.resourceId || null,
            dedupeKey: payload.dedupeKey || null,
            isRead: false,
            readAt: null,
            createdAt: now,
            updatedAt: now,
            metadata: {
              ...(payload.metadata || {}),
              ...(payload.type === NotificationTypeEnum.NEW_MESSAGE
                ? { unreadMessageCount: 1 }
                : {}),
            },
          });

          savedEntity = await this.notificationRepo.save(newNotif);
        }

        const unreadCount = await this.getUnreadCount(recipientId);
        const enrichedDto = this.formatNotificationResponse(savedEntity, actorInfo);

        this.realtimeEmitter.emitToUser(
          SOCKET_CONFIG.namespaces.CHAT,
          recipientId,
          isUpdatedExisting
            ? SOCKET_CONFIG.events.NOTIFICATION.UPDATED
            : SOCKET_CONFIG.events.NOTIFICATION.NEW,
          {
            notification: enrichedDto,
            unreadCount,
          },
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[createAndDispatch] Failed to dispatch notification: ${msg}`);
    }
  }

  async getUserNotifications(params: { userId: string; query: GetNotificationsQueryDto }) {
    const { userId, query } = params;

    const helper = AdvancedQueryHelper.from(this.notificationRepo, 'n')
      .filter({ recipientId: userId })
      .leftJoinRelation('actor', 'actor')
      .addSelect(['actor.id', 'actor.name', 'actor.email'])
      .leftJoinAndMapOne(
        'actor.avatarMedia',
        MediaEntity,
        'actor_media',
        'actor_media.targetId = actor.id AND actor_media.type = :avatarType',
        { avatarType: MediaTypeEnum.USER_AVATAR },
      )
      .leftJoinAndSelect('actor_media.file', 'actor_file');

    if (typeof query.isRead === 'boolean') {
      helper.filter({ isRead: query.isRead });
    }

    if (query.type) {
      helper.filter({ type: query.type });
    }

    if (query.search) {
      helper.search(query.search, ['title', 'content']);
    }

    const sort = query.sort || 'createdAt:DESC';
    const paginated = await helper.getPaginated({ ...query, sort });
    const unreadCount = await this.getUnreadCount(userId);

    const formattedData = paginated.data.map((item: any) => {
      const rawActor = item.actor;
      const actorInfo = rawActor
        ? {
            id: rawActor.id,
            name: rawActor.name,
            avatar: rawActor.avatarMedia?.file?.url || null,
          }
        : null;

      return this.formatNotificationResponse(item, actorInfo);
    });

    return {
      ...paginated,
      data: formattedData,
      unreadCount,
    };
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationRepo.count({
      where: {
        recipientId: userId,
        isRead: false,
      },
    });
  }

  async markAsRead(params: { userId: string; notificationId: string }) {
    const { userId, notificationId } = params;
    const notif = await this.notificationRepo.findOne({
      where: { id: notificationId, recipientId: userId },
    });

    if (!notif) {
      throw new NotFoundException('Không tìm thấy thông báo');
    }

    if (!notif.isRead) {
      notif.isRead = true;
      notif.readAt = new Date();
      await this.notificationRepo.save(notif);
    }

    const unreadCount = await this.getUnreadCount(userId);

    this.realtimeEmitter.emitToUser(
      SOCKET_CONFIG.namespaces.CHAT,
      userId,
      SOCKET_CONFIG.events.NOTIFICATION.MARK_READ,
      {
        notificationIds: [notificationId],
        unreadCount,
      },
    );

    return { id: notificationId, isRead: true, unreadCount };
  }

  async markAllAsRead(userId: string) {
    const now = new Date();
    await this.notificationRepo
      .createQueryBuilder()
      .update(NotificationEntity)
      .set({ isRead: true, readAt: now })
      .where('recipient_id = :userId AND is_read = :isRead', {
        userId,
        isRead: false,
      })
      .execute();

    this.realtimeEmitter.emitToUser(
      SOCKET_CONFIG.namespaces.CHAT,
      userId,
      SOCKET_CONFIG.events.NOTIFICATION.READ_ALL,
      {
        unreadCount: 0,
        readAt: now.toISOString(),
      },
    );

    return { unreadCount: 0 };
  }

  /**
   * Tự động đánh dấu đã đọc các thông báo thuộc về 1 cuộc hội thoại khi người dùng mở xem hội thoại đó
   */
  async markConversationNotificationsAsRead(userId: string, conversationId: string): Promise<void> {
    if (!userId || !conversationId) return;

    const unreadList = await this.notificationRepo.find({
      where: {
        recipientId: userId,
        resourceId: conversationId,
        isRead: false,
      },
      select: ['id'],
    });

    if (unreadList.length === 0) return;

    const ids = unreadList.map((n) => n.id);
    const now = new Date();

    await this.notificationRepo
      .createQueryBuilder()
      .update(NotificationEntity)
      .set({ isRead: true, readAt: now })
      .whereInIds(ids)
      .execute();

    const unreadCount = await this.getUnreadCount(userId);

    this.realtimeEmitter.emitToUser(
      SOCKET_CONFIG.namespaces.CHAT,
      userId,
      SOCKET_CONFIG.events.NOTIFICATION.MARK_READ,
      {
        notificationIds: ids,
        conversationId,
        unreadCount,
      },
    );
  }

  async deleteNotification(params: { userId: string; notificationId: string }) {
    const { userId, notificationId } = params;
    const notif = await this.notificationRepo.findOne({
      where: { id: notificationId, recipientId: userId },
    });

    if (!notif) {
      throw new NotFoundException('Không tìm thấy thông báo');
    }

    await this.notificationRepo.softRemove(notif);
    const unreadCount = await this.getUnreadCount(userId);

    this.realtimeEmitter.emitToUser(
      SOCKET_CONFIG.namespaces.CHAT,
      userId,
      SOCKET_CONFIG.events.NOTIFICATION.REMOVED,
      {
        notificationId,
        unreadCount,
      },
    );

    return { id: notificationId, unreadCount };
  }

  private formatNotificationResponse(
    entity: NotificationEntity,
    actor: { id: string; name: string; avatar: string | null } | null,
  ) {
    return {
      id: entity.id,
      recipientId: entity.recipientId,
      actorId: entity.actorId,
      actor,
      type: entity.type,
      title: entity.title,
      content: entity.content,
      resourceType: entity.resourceType,
      resourceId: entity.resourceId,
      dedupeKey: entity.dedupeKey,
      isRead: Boolean(entity.isRead),
      readAt: entity.readAt ? new Date(entity.readAt).toISOString() : null,
      createdAt: entity.createdAt
        ? new Date(entity.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: entity.updatedAt
        ? new Date(entity.updatedAt).toISOString()
        : new Date().toISOString(),
      metadata: entity.metadata || {},
    };
  }
}
