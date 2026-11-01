import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import * as bcrypt from 'bcrypt';
import {
  ContactStatusEnum,
  ConversationTypeEnum,
  MediaTypeEnum,
  MessageStatusEnum,
  MessageTypeEnum,
  StatusEnum,
} from 'src/common/enum';
import { AdvancedQueryHelper } from 'src/common/helper/query.helper';
import { SocketStateService } from 'src/common/websocket/socket-state.service';
import { SchemaMigrationHelper } from 'src/config/databases/schema-migration.helper';
import { envs } from 'src/config/envs';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { GetListUserDto } from 'src/dto/user/get-list-user.dto';
import { UpdateProfileDto } from 'src/dto/user/update-profile.dto';
import { ContactEntity } from 'src/entity/contact.entity';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { MediaEntity } from 'src/entity/media.entity';
import { MessageEntity } from 'src/entity/message.entity';
import { DEFAULT_USER_PRIVACY_SETTINGS, UserEntity } from 'src/entity/user.entity';
import {
  ICreateUser,
  IProfileSharedAsset,
  IUpdateUser,
  IUserPrivacySettings,
  ProfileAccessLevel,
} from 'src/interface/user.interface';
import { PaginatedResult } from 'src/types/query.types';
import { DataSource, QueryFailedError, Repository } from 'typeorm';

import { BufferedFile } from '../files/files.service';
import { MediaService } from '../media/media.service';

@Injectable()
export class UserService implements OnModuleInit {
  private readonly logger = new Logger(UserService.name, { timestamp: true });

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(ContactEntity)
    private readonly contactRepository: Repository<ContactEntity>,
    @InjectRepository(ConversationEntity)
    private readonly convRepository: Repository<ConversationEntity>,
    @InjectRepository(ConversationParticipantEntity)
    private readonly partRepository: Repository<ConversationParticipantEntity>,
    @InjectRepository(MessageEntity)
    private readonly msgRepository: Repository<MessageEntity>,
    private readonly mediaService: MediaService,
    private readonly socketStateService: SocketStateService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Đảm bảo các cột mở rộng cho trang cá nhân (bio, phone, privacy_settings)
   * luôn tồn tại trong bảng users mà không làm gián đoạn hệ thống hiện tại.
   */
  async onModuleInit(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      const hasUsersTable = await queryRunner.hasTable('users');
      if (!hasUsersTable) return;

      await SchemaMigrationHelper.safeAddColumn(queryRunner, 'users', {
        name: 'bio',
        type: 'varchar',
        length: '500',
        isNullable: true,
        default: null,
      });
      await SchemaMigrationHelper.safeAddColumn(queryRunner, 'users', {
        name: 'phone',
        type: 'varchar',
        length: '32',
        isNullable: true,
        default: null,
      });
      await SchemaMigrationHelper.safeAddColumn(queryRunner, 'users', {
        name: 'privacy_settings',
        type: 'json',
        isNullable: true,
      });
    } catch (error) {
      this.logger.warn(
        `[onModuleInit] Auto-check profile columns skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await queryRunner.release().catch(() => undefined);
    }
  }

  async findUserByEmail(payload: {
    email: string;
    skipError?: boolean;
    includeSecrets?: boolean;
    withDeleted?: boolean;
  }): Promise<UserEntity | null> {
    const { email, skipError = false, includeSecrets = false, withDeleted = false } = payload;
    const normalizedEmail = email.trim().toLowerCase();

    const qb = this.userRepository
      .createQueryBuilder('u')
      .where('u.email = :email', { email: normalizedEmail });

    if (withDeleted) {
      qb.withDeleted();
    }

    if (includeSecrets) {
      qb.addSelect(['u.password', 'u.refreshToken']);
    }

    const user = await qb.getOne();
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
    const normalizedEmail = newUser.email.trim().toLowerCase();

    const existingUser = await this.userRepository.findOne({
      where: { email: normalizedEmail },
      withDeleted: true,
    });

    if (existingUser) {
      throw new BadRequestException({
        status: HttpStatus.BAD_REQUEST,
        message: HTTP_RESPONSE.USER.EMAIL_EXITED.message,
        code: HTTP_RESPONSE.USER.EMAIL_EXITED.code,
      });
    }

    const hashedPassword = await bcrypt.hash(newUser.password, envs.bcryptSaltRound);
    const userData: Partial<UserEntity> = {
      ...newUser,
      email: normalizedEmail,
      name: newUser.name.trim(),
      password: hashedPassword,
      provider: newUser.provider || 'local',
      privacySettings: DEFAULT_USER_PRIVACY_SETTINGS,
    };

    const user = this.userRepository.create(userData);
    try {
      const saved = await this.userRepository.save(user);
      delete (saved as Partial<UserEntity>).password;
      delete (saved as Partial<UserEntity>).refreshToken;
      return saved;
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        ((error as any).code === 'ER_DUP_ENTRY' || (error as any).errno === 1062)
      ) {
        throw new ConflictException({
          status: HttpStatus.CONFLICT,
          message: HTTP_RESPONSE.USER.EMAIL_EXITED.message,
          code: HTTP_RESPONSE.USER.EMAIL_EXITED.code,
        });
      }
      throw error;
    }
  }

  async findUserById(payload: {
    userId: string;
    includeSecrets?: boolean;
    withDeleted?: boolean;
    skipError?: boolean;
  }): Promise<UserEntity> {
    const { userId, includeSecrets = false, withDeleted = false, skipError = false } = payload;

    const qb = this.userRepository.createQueryBuilder('u').where('u.id = :userId', { userId });

    if (withDeleted) {
      qb.withDeleted();
    }

    if (includeSecrets) {
      qb.addSelect(['u.password', 'u.refreshToken']);
    }

    const user = await qb.getOne();
    if (!user && !skipError) {
      throw new NotFoundException({
        status: HttpStatus.NOT_FOUND,
        message: HTTP_RESPONSE.USER.NOT_FOUND.message,
        code: HTTP_RESPONSE.USER.NOT_FOUND.code,
      });
    }
    return user as UserEntity;
  }

  async updateUser(payload: { userId: string; data: IUpdateUser }): Promise<UserEntity> {
    const { userId, data: updateUser } = payload;
    const sanitizedData: IUpdateUser = { ...updateUser };
    if (sanitizedData.email) {
      sanitizedData.email = sanitizedData.email.trim().toLowerCase();
    }

    const user = await this.userRepository.preload({
      id: userId,
      ...sanitizedData,
    });

    if (!user) {
      throw new NotFoundException({
        status: HttpStatus.NOT_FOUND,
        message: HTTP_RESPONSE.USER.NOT_FOUND.message,
        code: HTTP_RESPONSE.USER.NOT_FOUND.code,
      });
    }

    const saved = await this.userRepository.save(user);
    delete (saved as Partial<UserEntity>).password;
    delete (saved as Partial<UserEntity>).refreshToken;
    return saved;
  }

  /**
   * Lấy danh sách người dùng có lọc bỏ các đối tượng nằm trong quan hệ chặn 2 chiều.
   */
  async getList(payload: {
    query: GetListUserDto;
    requesterId?: string;
  }): Promise<PaginatedResult<UserEntity>> {
    const { query, requesterId } = payload;

    const qb = AdvancedQueryHelper.from(this.userRepository, 'u');

    qb.select(['id', 'email', 'name', 'status', 'createdAt']);

    qb.leftJoinAndMapOne(
      'avatarMedia',
      MediaEntity,
      'mediaAvatar',
      'mediaAvatar.targetId = u.id AND mediaAvatar.type = :avatarType',
      { avatarType: MediaTypeEnum.USER_AVATAR },
    ).leftJoinAndSelect('mediaAvatar.file', 'fileAvatar');

    if (requesterId) {
      // Lý do nghiệp vụ: Khi A chặn B, B không thể tìm thấy A trên thanh tìm kiếm và ngược lại
      qb.getBuilder().andWhere(
        `NOT EXISTS (
          SELECT 1 FROM contacts c_block
          WHERE c_block.deleted_at IS NULL
            AND c_block.status = :blockedStatus
            AND (
              (c_block.userId = :requesterId AND c_block.contactId = u.id)
              OR (c_block.userId = u.id AND c_block.contactId = :requesterId)
            )
        )`,
        {
          requesterId,
          blockedStatus: ContactStatusEnum.BLOCKED,
        },
      );
    }

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

  /**
   * Lấy thông tin trang cá nhân theo chuẩn phân quyền 3 cấp độ của Meta/Facebook:
   * - SELF (Chính mình): Toàn quyền xem và chỉnh sửa, thấy cả danh sách media/file.
   * - FRIEND (Bạn bè): Xem được email, số điện thoại, biệt danh, trạng thái hoạt động (tùy theo privacySettings của chủ sở hữu) và media/file đã chia sẻ chung.
   * - STRANGER (Người lạ): Chỉ xem được Avatar, Tên hiển thị công khai và Ảnh bìa (Cover photo).
   * - BLOCKED: Nếu bị đối phương chặn (hoặc đã chặn đối phương), chặn truy cập và trả về 404 (Nội dung không khả dụng).
   */
  async getUserProfile(payload: { targetUserId: string; requesterId: string }) {
    const { targetUserId, requesterId } = payload;
    const isMe = targetUserId === requesterId;

    if (!isMe && requesterId) {
      const [myRelation, theirRelation] = await Promise.all([
        this.contactRepository.findOne({
          where: { userId: requesterId, contactId: targetUserId },
        }),
        this.contactRepository.findOne({
          where: { userId: targetUserId, contactId: requesterId },
        }),
      ]);

      // Lý do nghiệp vụ: Khi User A chặn User B, User B truy cập trang cá nhân của User A sẽ nhận lỗi 404
      if (
        theirRelation?.status === ContactStatusEnum.BLOCKED ||
        myRelation?.status === ContactStatusEnum.BLOCKED
      ) {
        throw new NotFoundException({
          status: HttpStatus.NOT_FOUND,
          message: 'Nội dung không khả dụng',
          code: HTTP_RESPONSE.USER.NOT_FOUND.code,
          isBlocked: true,
          blockedByMe: myRelation?.status === ContactStatusEnum.BLOCKED,
          blockedByTarget: theirRelation?.status === ContactStatusEnum.BLOCKED,
        });
      }
    }

    const helper = AdvancedQueryHelper.from(this.userRepository, 'u');

    helper.select([
      'id',
      'name',
      'email',
      'bio',
      'phone',
      'privacySettings',
      'createdAt',
      'role',
      'status',
    ]);

    helper
      .leftJoinAndMapOne(
        'avatarMedia',
        MediaEntity,
        'mediaAvatar',
        'mediaAvatar.targetId = u.id AND mediaAvatar.type = :avatarType',
        { avatarType: MediaTypeEnum.USER_AVATAR },
      )
      .leftJoinAndSelect('mediaAvatar.file', 'fileAvatar')
      .leftJoinAndMapOne(
        'coverMedia',
        MediaEntity,
        'mediaCover',
        'mediaCover.targetId = u.id AND mediaCover.type = :coverType',
        { coverType: MediaTypeEnum.USER_COVER },
      )
      .leftJoinAndSelect('mediaCover.file', 'fileCover');

    helper.filter({ id: targetUserId });

    if (requesterId && !isMe) {
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
      coverMedia?: MediaEntity;
    };

    const userWithVirtuals = user as UserWithVirtuals;

    const relationship = isMe ? null : userWithVirtuals.contactAssociation?.status || null;
    const contactAlias = isMe ? null : userWithVirtuals.contactAssociation?.alias || null;
    const avatar = userWithVirtuals.avatarMedia?.file?.url || null;
    const coverImage = userWithVirtuals.coverMedia?.file?.url || null;

    delete userWithVirtuals.contactAssociation;
    delete userWithVirtuals.avatarMedia;
    delete userWithVirtuals.coverMedia;

    const resolvedPrivacy: IUserPrivacySettings = {
      ...DEFAULT_USER_PRIVACY_SETTINGS,
      ...(userWithVirtuals.privacySettings || {}),
    };

    const accessLevel: ProfileAccessLevel = isMe
      ? 'SELF'
      : relationship === ContactStatusEnum.FRIEND
        ? 'FRIEND'
        : 'STRANGER';

    const friendCount = await this.contactRepository.count({
      where: {
        userId: targetUserId,
        status: ContactStatusEnum.FRIEND,
      },
    });

    // Cấp độ 3: STRANGER (Người lạ) -> Chỉ hiển thị Avatar, Tên hiển thị công khai và Ảnh bìa
    if (accessLevel === 'STRANGER') {
      return {
        id: userWithVirtuals.id,
        name: userWithVirtuals.name,
        avatar,
        coverImage,
        bio: null,
        email: null,
        phone: null,
        alias: null,
        isOnline: false,
        relationship,
        accessLevel,
        isMe: false,
        friendCount,
        sharedMedia: [],
        sharedFiles: [],
      };
    }

    // Cấp độ 2: FRIEND (Bạn bè) -> Hiển thị theo cài đặt quyền riêng tư của chủ sở hữu
    if (accessLevel === 'FRIEND') {
      const directKey = [requesterId, targetUserId].sort().join(':');
      const directConv = await this.convRepository.findOne({
        where: { directKey, type: ConversationTypeEnum.DIRECT },
        select: ['id'],
      });

      let resolvedNickname = contactAlias;
      let isPartnerRestricted = false;

      if (directConv) {
        const targetPart = await this.partRepository.findOne({
          where: { conversationId: directConv.id, userId: targetUserId },
          select: ['nickname', 'isRestricted'],
        });
        if (targetPart?.nickname) {
          resolvedNickname = targetPart.nickname;
        }
        isPartnerRestricted = Boolean(targetPart?.isRestricted);
      }

      const canSeeOnline = resolvedPrivacy.showOnlineStatus !== false && !isPartnerRestricted;
      const isOnline = canSeeOnline
        ? await this.socketStateService.isUserOnline(targetUserId)
        : false;

      const { sharedMedia, sharedFiles } =
        resolvedPrivacy.showSharedMedia !== false && directConv
          ? await this.extractProfileSharedAssets([directConv.id], requesterId)
          : { sharedMedia: [], sharedFiles: [] };

      return {
        id: userWithVirtuals.id,
        name: userWithVirtuals.name,
        email: resolvedPrivacy.showEmail !== false ? userWithVirtuals.email : null,
        phone: resolvedPrivacy.showPhone !== false ? userWithVirtuals.phone || null : null,
        bio: userWithVirtuals.bio || null,
        alias: resolvedPrivacy.showAlias !== false ? resolvedNickname : null,
        avatar,
        coverImage,
        isOnline,
        createdAt: userWithVirtuals.createdAt,
        role: userWithVirtuals.role,
        status: userWithVirtuals.status,
        relationship,
        accessLevel,
        isMe: false,
        friendCount,
        privacySettings: resolvedPrivacy,
        sharedMedia,
        sharedFiles,
      };
    }

    // Cấp độ 1: SELF (Chính mình) -> Toàn quyền xem và chỉnh sửa
    const mySavedConv = await this.convRepository.findOne({
      where: { directKey: `self:${requesterId}` },
      select: ['id'],
    });
    const myPartRows = await this.partRepository.find({
      where: { userId: requesterId },
      select: ['conversationId'],
      take: 25,
    });
    const myConvIds = Array.from(
      new Set([
        ...(mySavedConv ? [mySavedConv.id] : []),
        ...myPartRows.map((r) => r.conversationId),
      ]),
    );

    const { sharedMedia, sharedFiles } =
      myConvIds.length > 0
        ? await this.extractProfileSharedAssets(myConvIds, requesterId, requesterId)
        : { sharedMedia: [], sharedFiles: [] };

    return {
      ...userWithVirtuals,
      bio: userWithVirtuals.bio || null,
      phone: userWithVirtuals.phone || null,
      alias: null,
      avatar,
      coverImage,
      isOnline: true,
      relationship: null,
      accessLevel: 'SELF' as ProfileAccessLevel,
      isMe: true,
      friendCount,
      privacySettings: resolvedPrivacy,
      sharedMedia,
      sharedFiles,
    };
  }

  /**
   * Trích xuất danh sách truyền thông (ảnh/video & tệp) đã chia sẻ để hiển thị trên trang cá nhân.
   */
  private async extractProfileSharedAssets(
    conversationIds: string[],
    requesterId: string,
    onlySenderId?: string,
  ): Promise<{
    sharedMedia: IProfileSharedAsset[];
    sharedFiles: IProfileSharedAsset[];
  }> {
    if (!conversationIds.length) {
      return { sharedMedia: [], sharedFiles: [] };
    }

    try {
      const qb = this.msgRepository
        .createQueryBuilder('m')
        .where('m.conversationId IN (:...conversationIds)', { conversationIds })
        .andWhere('m.status != :removed', { removed: MessageStatusEnum.REMOVED })
        .andWhere('m.type IN (:...assetTypes)', {
          assetTypes: [
            MessageTypeEnum.IMAGE,
            MessageTypeEnum.VIDEO,
            MessageTypeEnum.FILE,
            MessageTypeEnum.AUDIO,
          ],
        })
        .andWhere('(m.expiresAt IS NULL OR m.expiresAt > :now)', { now: new Date() })
        .leftJoinAndSelect('m.sender', 'sender')
        .orderBy('m.createdAt', 'DESC')
        .take(60);

      if (onlySenderId) {
        qb.andWhere('m.senderId = :onlySenderId', { onlySenderId });
      }

      const messages = await qb.getMany();
      const sharedMedia: IProfileSharedAsset[] = [];
      const sharedFiles: IProfileSharedAsset[] = [];

      for (const msg of messages) {
        const attachments = msg.metadata?.attachments || [];
        const senderName = msg.sender?.name || 'User';
        const createdAt = msg.createdAt ? new Date(msg.createdAt).toISOString() : '';

        for (const att of attachments) {
          const item: IProfileSharedAsset = {
            messageId: msg.id,
            fileId: att.fileId,
            url: att.url,
            thumbnailUrl: att.thumbnailUrl || att.url,
            fileName: att.fileName,
            mimeType: att.mimeType,
            size: Number(att.size || 0),
            type: msg.type,
            senderId: msg.senderId,
            senderName,
            createdAt,
          };

          if (msg.type === MessageTypeEnum.IMAGE || msg.type === MessageTypeEnum.VIDEO) {
            sharedMedia.push(item);
          } else {
            sharedFiles.push(item);
          }
        }
      }

      return {
        sharedMedia: sharedMedia.slice(0, 24),
        sharedFiles: sharedFiles.slice(0, 24),
      };
    } catch (error) {
      this.logger.warn(
        `Failed to load profile shared assets for ${requesterId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { sharedMedia: [], sharedFiles: [] };
    }
  }

  /**
   * Cập nhật thông tin hồ sơ cá nhân và cài đặt quyền riêng tư của chính mình.
   */
  async updateMyProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.findUserById({ userId });

    if (dto.name !== undefined) {
      const trimmedName = dto.name.trim();
      if (!trimmedName) {
        throw new BadRequestException('Tên hiển thị không được để trống');
      }
      user.name = trimmedName;
    }

    if (dto.bio !== undefined) {
      user.bio = dto.bio ? dto.bio.trim().slice(0, 500) : null;
    }

    if (dto.phone !== undefined) {
      user.phone = dto.phone ? dto.phone.trim().slice(0, 32) : null;
    }

    if (dto.privacySettings !== undefined) {
      user.privacySettings = {
        ...DEFAULT_USER_PRIVACY_SETTINGS,
        ...(user.privacySettings || {}),
        ...dto.privacySettings,
      };
    }

    await this.userRepository.save(user);
    return this.getUserProfile({ targetUserId: userId, requesterId: userId });
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

  /**
   * Tải lên hoặc thay đổi ảnh bìa (Cover Photo) cho trang cá nhân.
   */
  async updateCover(userId: string, file: BufferedFile) {
    const uploadedFile = await this.mediaService.processSingleUpload({
      file,
      userId,
      targetId: userId,
      type: MediaTypeEnum.USER_COVER,
      options: {
        folder: `covers/${userId}`,
        optimize: true,
        resizeWidth: 1600,
      },
    });

    return {
      url: uploadedFile.url,
    };
  }

  /**
   * Xóa ảnh bìa hiện tại của người dùng.
   */
  async deleteCover(userId: string): Promise<void> {
    await this.mediaService.processDelete({
      targetId: userId,
      type: MediaTypeEnum.USER_COVER,
      hardDelete: true,
    });
  }

  async getBasicUsersInfo(userIds: string[]): Promise<UserEntity[]> {
    if (!userIds || userIds.length === 0) {
      return [];
    }

    const users = await this.userRepository
      .createQueryBuilder('u')
      .where('u.id IN (:...userIds)', { userIds })
      .select(['u.id', 'u.name', 'u.email'])
      .leftJoinAndMapOne(
        'u.avatarMedia',
        MediaEntity,
        'media',
        'media.targetId = u.id AND media.type = :avatarType',
        { avatarType: MediaTypeEnum.USER_AVATAR },
      )
      .leftJoinAndSelect('media.file', 'file')
      .getMany();

    return users;
  }
}
