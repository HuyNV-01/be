import { BadRequestException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import * as bcrypt from 'bcrypt';
import { MediaTypeEnum, StatusEnum } from 'src/common/enum';
import { AdvancedQueryHelper } from 'src/common/helper/query.helper';
import { envs } from 'src/config/envs';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { GetListUserDto } from 'src/dto/user/get-list-user.dto';
import { ContactEntity } from 'src/entity/contact.entity';
import { MediaEntity } from 'src/entity/media.entity';
import { UserEntity } from 'src/entity/user.entity';
import { ICreateUser, IUpdateUser } from 'src/interface/user.interface';
import { PaginatedResult } from 'src/types/query.types';
import { Repository } from 'typeorm';

import { BufferedFile } from '../files/files.service';
import { MediaService } from '../media/media.service';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly mediaService: MediaService,
  ) {}

  async findUserByEmail(payload: {
    email: string;
    skipError?: boolean;
  }): Promise<UserEntity | null> {
    const { email, skipError = false } = payload;
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user && !skipError) {
      throw new NotFoundException({
        status: HttpStatus.NOT_FOUND,
        message: HTTP_RESPONSE.USER.NOT_FOUND.message,
        code: HTTP_RESPONSE.USER.NOT_FOUND.code,
      });
    }
    return user;
  }

  async createUser(payload: { data: ICreateUser }): Promise<UserEntity> {
    const { data: newUser } = payload;
    const exitUser = await this.userRepository.findOne({
      where: { email: newUser.email },
    });
    if (exitUser) {
      throw new BadRequestException({
        status: HttpStatus.BAD_REQUEST,
        message: HTTP_RESPONSE.USER.EMAIL_EXITED.message,
        code: HTTP_RESPONSE.USER.EMAIL_EXITED.code,
      });
    }
    const userData = {
      ...newUser,
      password: bcrypt.hashSync(newUser.password, envs.bcryptSaltRound),
    };
    const user = this.userRepository.create(userData);
    return this.userRepository.save(user);
  }

  async findUserById(payload: { userId: string }): Promise<UserEntity> {
    const { userId } = payload;
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({
        status: HttpStatus.NOT_FOUND,
        message: HTTP_RESPONSE.USER.NOT_FOUND.message,
        code: HTTP_RESPONSE.USER.NOT_FOUND.code,
      });
    }
    return user;
  }

  async updateUser(payload: { userId: string; data: IUpdateUser }): Promise<UserEntity> {
    const { userId, data: updateUser } = payload;
    const user = await this.userRepository.preload({
      id: userId,
      ...updateUser,
    });

    if (!user) {
      throw new NotFoundException({
        status: HttpStatus.NOT_FOUND,
        message: HTTP_RESPONSE.USER.NOT_FOUND.message,
        code: HTTP_RESPONSE.USER.NOT_FOUND.code,
      });
    }

    return this.userRepository.save(user);
  }

  async getList(payload: { query: GetListUserDto }): Promise<PaginatedResult<UserEntity>> {
    const { query } = payload;

    const qb = AdvancedQueryHelper.from(this.userRepository, 'u');

    qb.select(['id', 'email', 'name', 'status', 'createdAt']);

    qb.leftJoinAndMapOne(
      'avatarMedia',
      MediaEntity,
      'mediaAvatar',
      'mediaAvatar.targetId = u.id AND mediaAvatar.type = :avatarType',
      { avatarType: MediaTypeEnum.USER_AVATAR },
    ).leftJoinAndSelect('mediaAvatar.file', 'fileAvatar');

    if (query.search) {
      qb.search(query.search, ['name', 'email']);
    }

    qb.filter({ status: StatusEnum.ACTIVE });

    const result = await qb.getPaginated(query);

    const data = result.data.map((user) => {
      const u = user as UserEntity & { avatarMedia?: MediaEntity };

      const avatarUrl = u.avatarMedia?.file?.url || null;

      delete u.avatarMedia;

      return {
        ...u,
        avatar: avatarUrl,
      } as unknown as UserEntity;
    });

    return { ...result, data };
  }

  async getUserProfile(payload: { targetUserId: string; requesterId: string }) {
    const { targetUserId, requesterId } = payload;

    const helper = AdvancedQueryHelper.from(this.userRepository, 'u');

    helper.select(['id', 'name', 'email', 'createdAt', 'role', 'status']);

    helper
      .leftJoinAndMapOne(
        'avatarMedia',
        MediaEntity,
        'mediaAvatar',
        'mediaAvatar.targetId = u.id AND mediaAvatar.type = :avatarType',
        { avatarType: MediaTypeEnum.USER_AVATAR },
      )
      .leftJoinAndSelect('mediaAvatar.file', 'fileAvatar');

    helper.filter({ id: targetUserId });

    if (requesterId && requesterId !== targetUserId) {
      helper.mapOneWithSubQuery({
        mapTo: 'contactAssociation',
        entity: ContactEntity,
        alias: 'relation',
        conditionBuilder: (sub, parentAlias) => {
          return sub
            .select('relation.id')
            .from(ContactEntity, 'relation')
            .where(`relation.contactId = ${parentAlias}.id`)
            .andWhere('relation.userId = :requesterId');
        },
        params: { requesterId },
      });
    }

    const user = await helper.getOne();

    if (!user) {
      throw new NotFoundException({
        status: HttpStatus.NOT_FOUND,
        message: HTTP_RESPONSE.USER.NOT_FOUND.message,
        code: HTTP_RESPONSE.USER.NOT_FOUND.code,
      });
    }

    type UserWithVirtuals = UserEntity & {
      contactAssociation?: ContactEntity;
      avatarMedia?: MediaEntity;
    };

    const userWithVirtuals = user as UserWithVirtuals;

    const relationship = userWithVirtuals.contactAssociation?.status || null;
    const avatar = userWithVirtuals.avatarMedia?.file?.url || null;

    delete userWithVirtuals.contactAssociation;
    delete userWithVirtuals.avatarMedia;

    return {
      ...userWithVirtuals,
      relationship,
      avatar,
      isMe: targetUserId === requesterId,
    };
  }

  async updateAvatar(userId: string, file: BufferedFile) {
    const uploadedFile = await this.mediaService.processSingleUpload({
      file,
      userId: userId,
      targetId: userId,
      type: MediaTypeEnum.USER_AVATAR,
      options: {
        folder: `avatars/${userId}`,
        optimize: true,
        resizeWidth: 400,
      },
    });

    return {
      url: uploadedFile.url,
    };
  }

  async deleteAvatar(userId: string): Promise<void> {
    await this.mediaService.processDelete({
      targetId: userId,
      type: MediaTypeEnum.USER_AVATAR,
      hardDelete: true,
    });
  }
}
