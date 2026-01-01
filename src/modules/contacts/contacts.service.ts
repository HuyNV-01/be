/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { ContactStatusEnum, MediaTypeEnum, SortTypeEnum, StatusEnum } from 'src/common/enum';
import { AdvancedQueryHelper } from 'src/common/helper/query.helper';
import {
  ContactEventEnum,
  ContactRemovedEvent,
  ContactRequestAcceptedEvent,
  ContactRequestSentEvent,
} from 'src/config/websocket/events/contact.events';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { ContactEntity } from 'src/entity/contact.entity';
import { MediaEntity } from 'src/entity/media.entity';
import { UserEntity } from 'src/entity/user.entity';
import { IBaseQuery } from 'src/interface';
import {
  IGetContacts,
  ISendFriendRequest,
  IUpdateContactAlias,
} from 'src/interface/contact.interface';
import { DataSource, Repository } from 'typeorm';

import { UserService } from '../user/user.service';

@Injectable()
export class ContactsService {
  constructor(
    private readonly eventEmitter: EventEmitter2,
    @InjectRepository(ContactEntity)
    private readonly contactRepo: Repository<ContactEntity>,
    private readonly userService: UserService,
    private readonly dataSource: DataSource,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  private readonly logger = new Logger(ContactsService.name, {
    timestamp: true,
  });

  async getContacts(payload: { userId: string; query: IGetContacts }) {
    const { userId, query } = payload;
    const { type = ContactStatusEnum.FRIEND, search, sort: rawSort, ...pagination } = query;

    let sort = rawSort;
    const helper = AdvancedQueryHelper.from(this.contactRepo, 'c');

    helper.filter({ userId }).filter({ status: type });

    helper.joinRelation('contactUser', 'u').addSelect(['u.id', 'u.name', 'u.email']);

    helper
      .leftJoinAndMapOne(
        'u.avatarMedia',
        MediaEntity,
        'm',
        'm.targetId = u.id AND m.type = :avatarType',
        { avatarType: MediaTypeEnum.USER_AVATAR },
      )
      .leftJoinAndSelect('m.file', 'f');

    if (search) {
      helper.smartSearch(search, (builder) => {
        builder.matchCase('1=1', {}, ['c.alias', 'u.name', 'u.email']);
      });
    }

    if (sort) {
      const sortParts = sort.split(',');
      const remainingSorts: string[] = [];

      sortParts.forEach((part) => {
        const [field, rawDir] = part.split(':');
        const direction =
          rawDir?.toUpperCase() === (SortTypeEnum.DESC as string)
            ? SortTypeEnum.DESC
            : SortTypeEnum.ASC;

        if (field === 'name') {
          helper.getBuilder().addOrderBy('COALESCE(c.alias, u.name)', direction);
        } else {
          remainingSorts.push(part);
        }
      });

      sort = remainingSorts.length > 0 ? remainingSorts.join(',') : undefined;
    } else {
      helper.getBuilder().addOrderBy('COALESCE(c.alias, u.name)', SortTypeEnum.ASC);
    }

    const result = await helper.getPaginated({ ...pagination, sort });

    const finalData = result.data.map((contact) => {
      const user = contact.contactUser as UserEntity & {
        avatarMedia?: MediaEntity;
      };

      const avatarUrl = user.avatarMedia?.file?.url || null;

      delete user.avatarMedia;

      return {
        ...contact,
        contactUser: {
          ...user,
          avatar: avatarUrl,
        },
      };
    });

    return { ...result, data: finalData };
  }

  async sendFriendRequest(payload: { userId: string; dto: ISendFriendRequest }) {
    const { userId, dto } = payload;
    const { targetUserId } = dto;
    if (userId === targetUserId)
      throw new BadRequestException({
        status: HttpStatus.BAD_REQUEST,
        message: HTTP_RESPONSE.CONTACT.CONFLICT_YOURSELF.message,
        code: HTTP_RESPONSE.CONTACT.CONFLICT_YOURSELF.code,
      });

    await this.userService.findUserById({
      userId: targetUserId,
    });

    const existing = await this.contactRepo.findOne({
      where: { userId, contactId: targetUserId },
      withDeleted: true,
    });

    if (existing) {
      if (!existing.deletedAt) {
        if (existing.status === ContactStatusEnum.FRIEND)
          throw new ConflictException({
            status: HttpStatus.CONFLICT,
            message: HTTP_RESPONSE.CONTACT.CONFLICT_FRIEND.message,
            code: HTTP_RESPONSE.CONTACT.CONFLICT_FRIEND.code,
          });
        if (existing.status === ContactStatusEnum.PENDING_SENT)
          throw new ConflictException({
            status: HttpStatus.CONFLICT,
            message: HTTP_RESPONSE.CONTACT.CONFLICT_PENDING_SENT.message,
            code: HTTP_RESPONSE.CONTACT.CONFLICT_PENDING_SENT.code,
          });
        if (existing.status === ContactStatusEnum.BLOCKED)
          throw new BadRequestException({
            status: HttpStatus.CONFLICT,
            message: HTTP_RESPONSE.CONTACT.CONFLICT_BLOCK.message,
            code: HTTP_RESPONSE.CONTACT.CONFLICT_BLOCK.code,
          });
        if (existing.status === ContactStatusEnum.PENDING_RECEIVED) {
          return this.acceptFriendRequest({ userId, senderId: targetUserId });
        }
      }
    }

    await this.dataSource.transaction(async (manager) => {
      const myExisting = await manager.findOne(ContactEntity, {
        where: { userId, contactId: targetUserId },
        withDeleted: true,
      });

      if (myExisting) {
        myExisting.status = ContactStatusEnum.PENDING_SENT;
        myExisting.deletedAt = null;
        myExisting.deletedBy = null;
        await manager.save(myExisting);
      } else {
        const myRecord = manager.create(ContactEntity, {
          userId,
          contactId: targetUserId,
          status: ContactStatusEnum.PENDING_SENT,
        });
        await manager.save(myRecord);
      }

      const theirExisting = await manager.findOne(ContactEntity, {
        where: { userId: targetUserId, contactId: userId },
        withDeleted: true,
      });

      if (theirExisting) {
        theirExisting.status = ContactStatusEnum.PENDING_RECEIVED;
        theirExisting.deletedAt = null;
        theirExisting.deletedBy = null;
        await manager.save(theirExisting);
      } else {
        const theirRecord = manager.create(ContactEntity, {
          userId: targetUserId,
          contactId: userId,
          status: ContactStatusEnum.PENDING_RECEIVED,
        });
        await manager.save(theirRecord);
      }
    });

    this.eventEmitter.emit(
      ContactEventEnum.REQUEST_SENT,
      new ContactRequestSentEvent(payload.userId, payload.dto.targetUserId),
    );
    return { success: true };
  }

  async acceptFriendRequest(payload: { userId: string; senderId: string }) {
    const { userId, senderId } = payload;
    await this.dataSource.transaction(async (manager) => {
      const request = await manager.findOne(ContactEntity, {
        where: {
          userId,
          contactId: senderId,
          status: ContactStatusEnum.PENDING_RECEIVED,
        },
      });

      if (!request)
        throw new NotFoundException({
          status: HttpStatus.OK,
          message: HTTP_RESPONSE.CONTACT.FRIEND_NOT_FOUND.message,
          code: HTTP_RESPONSE.CONTACT.FRIEND_NOT_FOUND.code,
        });

      request.status = ContactStatusEnum.FRIEND;
      request.alias = null;

      const senderRecord = await manager.findOne(ContactEntity, {
        where: { userId: senderId, contactId: userId },
      });

      if (senderRecord) {
        senderRecord.status = ContactStatusEnum.FRIEND;
        await manager.save([request, senderRecord]);
      } else {
        const newRec = manager.create(ContactEntity, {
          userId: senderId,
          contactId: userId,
          status: ContactStatusEnum.FRIEND,
        });
        await manager.save([request, newRec]);
      }
    });

    this.eventEmitter.emit(
      ContactEventEnum.REQUEST_ACCEPTED,
      new ContactRequestAcceptedEvent(payload.userId, payload.senderId),
    );
    return { success: true };
  }

  async removeContact(payload: { userId: string; targetId: string }) {
    const { userId, targetId } = payload;
    await this.dataSource.transaction(async (manager) => {
      await manager.softDelete(ContactEntity, { userId, contactId: targetId });
      await manager.softDelete(ContactEntity, {
        userId: targetId,
        contactId: userId,
      });
    });
    this.eventEmitter.emit(
      ContactEventEnum.FRIEND_REMOVED,
      new ContactRemovedEvent(payload.userId, payload.targetId),
    );

    return { success: true };
  }

  async updateAlias(payload: { userId: string; targetId: string; dto: IUpdateContactAlias }) {
    const { userId, targetId, dto } = payload;
    const contact = await this.contactRepo.findOne({
      where: { userId, contactId: targetId },
    });
    if (!contact)
      throw new NotFoundException({
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.CONTACT.NOT_FOUND.message,
        code: HTTP_RESPONSE.CONTACT.NOT_FOUND.code,
      });

    contact.alias = dto.alias;
    await this.contactRepo.save(contact);

    return contact;
  }

  async findContactUsers(payload: { query: IBaseQuery; userId: string }) {
    const { query, userId } = payload;

    const helper = AdvancedQueryHelper.from(this.userRepo, 'u');

    helper
      .filter('u.id != :userId', { userId })
      .select(['u.id', 'u.email', 'u.name', 'u.status', 'u.createdAt']);

    helper
      .leftJoinAndMapOne(
        'avatarMedia',
        MediaEntity,
        'mediaAvatar',
        'mediaAvatar.targetId = u.id AND mediaAvatar.type = :avatarType',
        { avatarType: MediaTypeEnum.USER_AVATAR },
      )
      .leftJoinAndSelect('mediaAvatar.file', 'fileAvatar');

    if (query.search) {
      helper.search(query.search, ['name', 'email']);
    }

    helper.mapOneWithSubQuery({
      mapTo: 'contactAssociation',
      entity: ContactEntity,
      alias: 'c',
      conditionBuilder: (sub, parentAlias) => {
        return sub
          .select('c.id')
          .from(ContactEntity, 'c')
          .where(`c.contactId = ${parentAlias}.id`)
          .andWhere('c.userId = :userId');
      },
      params: { userId },
    });

    helper.filter({ status: StatusEnum.ACTIVE });

    const result = await helper.getPaginated(query);
    type UserWithContact = UserEntity & {
      contactAssociation?: ContactEntity;
      avatarMedia?: MediaEntity;
    };

    const rawData = result.data as UserWithContact[];

    const finalData = rawData.map((user) => {
      const contactStatus = user.contactAssociation?.status || null;
      const avatarUrl = user.avatarMedia?.file?.url || null;
      const { contactAssociation, ...userInfo } = user;
      delete userInfo.avatarMedia;

      return {
        ...userInfo,
        contactStatus,
        avatar: avatarUrl,
      };
    });

    return { ...result, data: finalData };
  }
}
