import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import * as crypto from 'crypto';
import { NotificationResourceTypeEnum, NotificationTypeEnum } from 'src/common/enum';
import {
  DataScopeEnum,
  InvitationStatusEnum,
  MembershipStatusEnum,
  PermissionCodeEnum,
  RoutingStrategyEnum,
  ShiftStatusEnum,
  ShopRoleEnum,
} from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { ROLE_PRESET_TEMPLATES } from 'src/constants/role-default-permissions.constant';
import {
  ApprovePendingMemberDto,
  CreateRoleInvitationDto,
  CreateShopWorkspaceDto,
  JoinShopByCodeDto,
  UpdateMemberRoleAndPermissionsDto,
} from 'src/dto/onboarding/onboarding.dto';
import { CustomTagEntity, TagCategoryEnum } from 'src/entity/custom-tag.entity';
import { ShopInvitationEntity } from 'src/entity/shop-invitation.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { UserEntity } from 'src/entity/user.entity';
import { WarehouseEntity } from 'src/entity/warehouse.entity';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import { DataSource, Repository } from 'typeorm';

import { EffectiveMemberContext, GranularIamService } from '../iam.service';

export interface UserOnboardingOverviewResponse {
  onboardingState: 'UNBOUND_USER' | 'PENDING_APPROVAL_ONLY' | 'HAS_ACTIVE_SHOPS';
  activeShopId: string | null;
  activeShopContext: EffectiveMemberContext | null;
  memberships: Array<{
    memberId: string;
    shopId: string;
    shopCode: string;
    joinCode: string;
    shopName: string;
    role: ShopRoleEnum;
    membershipStatus: MembershipStatusEnum;
    shiftStatus: ShiftStatusEnum;
  }>;
  pendingInvitations: Array<{
    invitationId: string;
    shopId: string;
    shopName: string;
    targetRole: ShopRoleEnum;
    invitedByName: string;
    expiresAt: string;
  }>;
}

@Injectable()
export class WorkspaceOnboardingService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    @InjectRepository(ShopMemberEntity)
    private readonly memberRepo: Repository<ShopMemberEntity>,
    @InjectRepository(ShopInvitationEntity)
    private readonly invitationRepo: Repository<ShopInvitationEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly granularIamService: GranularIamService,
    private readonly notificationsService: NotificationsService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  /**
   * Tìm toàn bộ UserId của Chủ quán (SHOP_OWNER) và Quản lý (SHOP_MANAGER / người có quyền IAM_MEMBER_INVITE_MANAGE)
   * đang hoạt động trong cửa hàng để đẩy thông báo NotificationBell & đồng bộ Socket Real-Time.
   */
  private async getShopManagerUserIds(shopId: string, excludeUserId?: string): Promise<string[]> {
    const activeMembers = await this.memberRepo.find({
      where: {
        shopId,
        membershipStatus: MembershipStatusEnum.ACTIVE,
      },
    });

    const managerIds = new Set<string>();
    for (const m of activeMembers) {
      const isManagerOrOwner =
        m.role === ShopRoleEnum.SHOP_OWNER ||
        m.role === ShopRoleEnum.SHOP_MANAGER ||
        (m.grantedPermissionsJson || []).includes(PermissionCodeEnum.IAM_MEMBER_INVITE_MANAGE);

      if (isManagerOrOwner && m.userId !== excludeUserId) {
        managerIds.add(m.userId);
      }
    }

    return Array.from(managerIds);
  }

  /**
   * Phát sự kiện Socket `iam:shop_members_changed` tới toàn bộ Chủ quán & Quản lý của cửa hàng
   * để màn hình `/settings/members` tự động cập nhật danh sách mà không cần F5.
   */
  private async broadcastShopMembersChanged(
    shopId: string,
    action: string,
    actorUserId?: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const managerIds = await this.getShopManagerUserIds(shopId);
    const recipients = new Set<string>(managerIds);
    if (actorUserId) {
      recipients.add(actorUserId);
    }

    for (const uid of recipients) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        uid,
        SOCKET_CONFIG.events.IAM.SHOP_MEMBERS_CHANGED,
        {
          shopId,
          action,
          timestamp: new Date().toISOString(),
          ...(extra || {}),
        },
      );
    }
  }

  /**
   * 1. Lấy tổng quan trạng thái Onboarding & danh sách Cửa hàng / Lời mời của User hiện tại:
   * - Nếu tài khoản mới đăng ký chưa thuộc quán nào -> onboardingState = 'UNBOUND_USER', activeShopContext = null (Quyền trống 100%).
   */
  async getUserOnboardingOverview(
    userId: string,
    userEmail: string,
  ): Promise<UserOnboardingOverviewResponse> {
    const normalizedEmail = userEmail.trim().toLowerCase();

    const [memberships, pendingInvites, user] = await Promise.all([
      this.memberRepo.find({
        where: { userId },
        relations: ['shop'],
        order: { createdAt: 'ASC' },
      }),
      this.invitationRepo.find({
        where: {
          invitedEmail: normalizedEmail,
          status: InvitationStatusEnum.PENDING,
        },
        relations: ['shop', 'invitedByUser'],
      }),
      this.userRepo.findOne({ where: { id: userId } }),
    ]);

    const validMemberships = memberships.filter(
      (m) =>
        m.membershipStatus === MembershipStatusEnum.ACTIVE ||
        m.membershipStatus === MembershipStatusEnum.PENDING_APPROVAL,
    );

    const activeMemberships = validMemberships.filter(
      (m) => m.membershipStatus === MembershipStatusEnum.ACTIVE,
    );

    let onboardingState: UserOnboardingOverviewResponse['onboardingState'] = 'UNBOUND_USER';
    if (activeMemberships.length > 0) {
      onboardingState = 'HAS_ACTIVE_SHOPS';
    } else if (validMemberships.length > 0) {
      onboardingState = 'PENDING_APPROVAL_ONLY';
    }

    const preferredActiveShopId =
      user?.lastActiveShopId && activeMemberships.some((m) => m.shopId === user.lastActiveShopId)
        ? user.lastActiveShopId
        : activeMemberships[0]?.shopId || null;

    let activeShopContext: EffectiveMemberContext | null = null;
    if (preferredActiveShopId) {
      activeShopContext = await this.granularIamService.getEffectiveMemberContext(
        preferredActiveShopId,
        userId,
      );
    }

    return {
      onboardingState,
      activeShopId: preferredActiveShopId,
      activeShopContext,
      memberships: validMemberships.map((m) => ({
        memberId: m.id,
        shopId: m.shopId,
        shopCode: m.shop?.code || '',
        joinCode:
          m.role === ShopRoleEnum.SHOP_OWNER || m.role === ShopRoleEnum.SHOP_MANAGER
            ? m.shop?.joinCode || ''
            : '',
        shopName: m.shop?.name || '',
        role: m.role,
        membershipStatus: m.membershipStatus,
        shiftStatus: m.shiftStatus,
      })),
      pendingInvitations: pendingInvites
        .filter((inv) => new Date(inv.expiresAt).getTime() > Date.now())
        .map((inv) => ({
          invitationId: inv.id,
          shopId: inv.shopId,
          shopName: inv.shop?.name || '',
          targetRole: inv.targetRole,
          invitedByName: inv.invitedByUser?.name || 'Chủ cửa hàng',
          expiresAt: inv.expiresAt.toISOString(),
        })),
    };
  }

  /**
   * 2. Kiểm tra thông tin Lời mời công khai qua inviteToken (Dành cho màn hình /register?inviteToken=...)
   */
  async verifyInvitationTokenPublic(rawInviteToken: string): Promise<{
    invitationId: string;
    shopId: string;
    shopName: string;
    invitedEmail: string;
    invitedName: string | null;
    targetRole: ShopRoleEnum;
    expiresAt: string;
  }> {
    const tokenHash = crypto.createHash('sha256').update(rawInviteToken.trim()).digest('hex');

    const invitation = await this.invitationRepo.findOne({
      where: { tokenHash, status: InvitationStatusEnum.PENDING },
      relations: ['shop'],
    });

    if (!invitation || new Date(invitation.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException('INVITATION_INVALID_OR_EXPIRED');
    }

    return {
      invitationId: invitation.id,
      shopId: invitation.shopId,
      shopName: invitation.shop?.name || '',
      invitedEmail: invitation.invitedEmail,
      invitedName: invitation.invitedName,
      targetRole: invitation.targetRole,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * 3. LUỒNG 1 (F00.1): Tạo Cửa Hàng Mới -> Tự động cấp quyền Chủ Quán (SHOP_OWNER) + Seed Kho & Bộ Tag chuẩn Pancake
   */
  async createShopAndProvisionOwner(
    userId: string,
    dto: CreateShopWorkspaceDto,
  ): Promise<{
    shop: ShopWorkspaceEntity;
    ownerMember: ShopMemberEntity;
    effectiveContext: EffectiveMemberContext;
  }> {
    const cleanSlug = dto.shopName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20);

    const randomSuffix = crypto.randomInt(1000, 9999);
    const shopCode = `${cleanSlug || 'shop'}-${randomSuffix}`;
    const joinCode = `PAN${crypto.randomInt(10000, 99999)}`;

    const { shop, ownerMember } = await this.dataSource.transaction(async (manager) => {
      const shopEntity = manager.create(ShopWorkspaceEntity, {
        code: shopCode,
        joinCode,
        name: dto.shopName.trim(),
        ownerId: userId,
        defaultCurrency: 'VND',
        timezone: 'Asia/Ho_Chi_Minh',
        slaResponseSeconds: 180,
        ghostedAlertSeconds: 180,
        autoReclaimMinutes: 5,
        routingStrategy: RoutingStrategyEnum.STICKY_AGENT,
        lockOrderAfterPrint: true,
        requireDepositOnHighRisk: true,
        commissionSplitConfigJson: {
          leadCollectorWeight: 0.4,
          orderCloserWeight: 0.6,
          deductOnReturnedOrder: true,
        },
        marketplaceSyncConfigJson: {
          autoReserveStockOnMarketplaceOrder: true,
          safetyBufferStockQty: 2,
          pushAvailableStockToShopeeTikTok: true,
        },
      });
      const savedShop = await manager.save(ShopWorkspaceEntity, shopEntity);

      const ownerPreset = ROLE_PRESET_TEMPLATES[ShopRoleEnum.SHOP_OWNER];
      const memberEntity = manager.create(ShopMemberEntity, {
        shopId: savedShop.id,
        userId,
        role: ShopRoleEnum.SHOP_OWNER,
        membershipStatus: MembershipStatusEnum.ACTIVE,
        dataScope: ownerPreset.defaultDataScope,
        shiftStatus: ShiftStatusEnum.ONLINE,
        maxDiscountPercent: ownerPreset.defaultMaxDiscountPercent,
        unmaskPhoneHourlyLimit: ownerPreset.defaultUnmaskPhoneHourlyLimit,
        grantedPermissionsJson: ownerPreset.defaultPermissions,
        revokedPermissionsJson: [],
        allowedChannelIdsJson: [],
        allowedWarehouseIdsJson: [],
        savedPageGroupPresetsJson: [],
        lastShiftChangedAt: new Date(),
      });
      const savedMember = await manager.save(ShopMemberEntity, memberEntity);

      const mainWarehouse = manager.create(WarehouseEntity, {
        shopId: savedShop.id,
        code: 'WH-MAIN',
        name: 'Kho Tổng Mặc Định',
        provinceCode: dto.defaultProvinceCode || '01',
        districtCode: dto.defaultDistrictCode || '001',
        wardCode: dto.defaultWardCode || '00001',
        addressLine: dto.defaultAddressLine || 'Kho chính tại cửa hàng',
        contactPhone: dto.contactPhone || '0900000000',
        isDefault: true,
        priorityOrder: 1,
        allowNegativeStock: false,
        isActive: true,
      });
      await manager.save(WarehouseEntity, mainWarehouse);

      const defaultTags: Array<Partial<CustomTagEntity>> = [
        {
          shopId: savedShop.id,
          name: 'Đang tư vấn',
          slug: 'CONSULTING',
          colorHex: '#3B82F6',
          colorOklch: 'oklch(0.62 0.19 259)',
          category: TagCategoryEnum.CONSULTATION_STATUS,
          isMutuallyExclusiveGroup: true,
          applicableScopesJson: ['CONVERSATION'],
          shortcutKey: '1',
          sortOrder: 1,
        },
        {
          shopId: savedShop.id,
          name: 'Đã có SĐT',
          slug: 'HAS_PHONE',
          colorHex: '#8B5CF6',
          colorOklch: 'oklch(0.60 0.22 293)',
          category: TagCategoryEnum.CONSULTATION_STATUS,
          isMutuallyExclusiveGroup: false,
          applicableScopesJson: ['CONVERSATION', 'CUSTOMER'],
          shortcutKey: '2',
          sortOrder: 2,
        },
        {
          shopId: savedShop.id,
          name: 'Đã chốt đơn',
          slug: 'ORDER_CREATED',
          colorHex: '#10B981',
          colorOklch: 'oklch(0.69 0.17 162)',
          category: TagCategoryEnum.CONSULTATION_STATUS,
          isMutuallyExclusiveGroup: true,
          applicableScopesJson: ['CONVERSATION', 'ORDER'],
          shortcutKey: '3',
          sortOrder: 3,
        },
        {
          shopId: savedShop.id,
          name: 'Cần cứu đơn gấp',
          slug: 'DELIVERY_RESCUE_URGENT',
          colorHex: '#EF4444',
          colorOklch: 'oklch(0.63 0.24 29)',
          category: TagCategoryEnum.DELIVERY_ISSUE,
          isMutuallyExclusiveGroup: false,
          applicableScopesJson: ['CONVERSATION', 'ORDER'],
          shortcutKey: '4',
          sortOrder: 4,
        },
        {
          shopId: savedShop.id,
          name: 'Địa chỉ giao hàng',
          slug: 'SHIPPING_ADDRESS',
          colorHex: '#0EA5E9',
          colorOklch: 'oklch(0.68 0.16 237)',
          category: TagCategoryEnum.MESSAGE_BOOKMARK,
          isMutuallyExclusiveGroup: false,
          applicableScopesJson: ['MESSAGE'],
          shortcutKey: '5',
          sortOrder: 5,
        },
        {
          shopId: savedShop.id,
          name: 'Bill chuyển khoản',
          slug: 'BANK_TRANSFER_RECEIPT',
          colorHex: '#F59E0B',
          colorOklch: 'oklch(0.76 0.18 70)',
          category: TagCategoryEnum.MESSAGE_BOOKMARK,
          isMutuallyExclusiveGroup: false,
          applicableScopesJson: ['MESSAGE'],
          shortcutKey: '6',
          sortOrder: 6,
        },
      ];
      await manager.save(
        CustomTagEntity,
        defaultTags.map((t) => manager.create(CustomTagEntity, t)),
      );

      await manager.update(UserEntity, userId, {
        lastActiveShopId: savedShop.id,
      });

      return { shop: savedShop, ownerMember: savedMember };
    });

    const effectiveContext = await this.granularIamService.invalidateAndBroadcastMemberPermissions(
      shop.id,
      userId,
    );

    return { shop, ownerMember, effectiveContext };
  }

  /**
   * 4. LUỒNG 2 (F00.2 & F00.3): Chủ quán / Quản lý gửi Lời mời Nhân viên (Sale, Kế toán, Kho, Marketing...)
   * - Tự động tạo thông báo trong NotificationBell & bắn Socket `iam:invitation_received` cho người được mời (nếu đã có tài khoản).
   * - Tự động bắn Socket `iam:shop_members_changed` cho toàn bộ Quản lý / Chủ quán để đồng bộ danh sách lời mời tức thì.
   */
  async createRoleInvitation(
    shopId: string,
    invitedByUserId: string,
    dto: CreateRoleInvitationDto,
  ): Promise<{
    invitation: ShopInvitationEntity;
    rawInviteToken: string;
    inviteUrl: string;
  }> {
    if (dto.targetRole === ShopRoleEnum.SHOP_OWNER) {
      throw new BadRequestException('CANNOT_INVITE_AS_SHOP_OWNER_USE_OWNERSHIP_TRANSFER');
    }

    const normalizedEmail = dto.invitedEmail.trim().toLowerCase();
    const preset = ROLE_PRESET_TEMPLATES[dto.targetRole];

    const rawInviteToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawInviteToken).digest('hex');

    // Nếu đã có lời mời PENDING trước đó cho cùng email tại cửa hàng này thì cập nhật lại lời mời đó
    let invitation = await this.invitationRepo.findOne({
      where: {
        shopId,
        invitedEmail: normalizedEmail,
        status: InvitationStatusEnum.PENDING,
      },
    });

    if (invitation) {
      invitation.invitedByUserId = invitedByUserId;
      invitation.invitedName = dto.invitedName || invitation.invitedName;
      invitation.targetRole = dto.targetRole;
      invitation.targetDataScope = dto.targetDataScope || preset.defaultDataScope;
      invitation.maxDiscountPercent = dto.maxDiscountPercent ?? preset.defaultMaxDiscountPercent;
      invitation.unmaskPhoneHourlyLimit =
        dto.unmaskPhoneHourlyLimit ?? preset.defaultUnmaskPhoneHourlyLimit;
      invitation.grantedPermissionsJson = dto.customGrantedPermissions || preset.defaultPermissions;
      invitation.allowedChannelIdsJson = dto.allowedChannelIds || [];
      invitation.allowedWarehouseIdsJson = dto.allowedWarehouseIds || [];
      invitation.tokenHash = tokenHash;
      invitation.expiresAt = new Date(Date.now() + 7 * 86400 * 1000);
    } else {
      invitation = this.invitationRepo.create({
        shopId,
        invitedByUserId,
        invitedEmail: normalizedEmail,
        invitedName: dto.invitedName || null,
        targetRole: dto.targetRole,
        targetDataScope: dto.targetDataScope || preset.defaultDataScope,
        maxDiscountPercent: dto.maxDiscountPercent ?? preset.defaultMaxDiscountPercent,
        unmaskPhoneHourlyLimit: dto.unmaskPhoneHourlyLimit ?? preset.defaultUnmaskPhoneHourlyLimit,
        grantedPermissionsJson: dto.customGrantedPermissions || preset.defaultPermissions,
        allowedChannelIdsJson: dto.allowedChannelIds || [],
        allowedWarehouseIdsJson: dto.allowedWarehouseIds || [],
        tokenHash,
        status: InvitationStatusEnum.PENDING,
        expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
      });
    }

    const savedInvitation = await this.invitationRepo.save(invitation);

    const [existingUser, shop] = await Promise.all([
      this.userRepo.findOne({ where: { email: normalizedEmail } }),
      this.shopRepo.findOne({ where: { id: shopId } }),
    ]);

    if (existingUser && shop) {
      await this.notificationsService.createAndDispatch({
        recipientIds: [existingUser.id],
        actorId: invitedByUserId,
        type: NotificationTypeEnum.SHOP_INVITATION,
        title: `Lời mời làm việc từ cửa hàng ${shop.name}`,
        content: `Bạn được mời đảm nhận vị trí ${dto.targetRole} tại cửa hàng ${shop.name}.`,
        resourceType: NotificationResourceTypeEnum.SHOP_INVITATION,
        resourceId: savedInvitation.id,
        dedupeKey: `shop_invite:${shop.id}:${existingUser.id}`,
        metadata: {
          actionUrl: '/onboarding?tab=INVITATIONS',
          titleKey: 'i18n.shopInvitationReceived.title',
          contentKey: 'i18n.shopInvitationReceived.content',
          i18nParams: {
            shopName: shop.name,
            roleKey: dto.targetRole,
          },
        },
      });

      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        existingUser.id,
        SOCKET_CONFIG.events.IAM.INVITATION_RECEIVED,
        {
          invitationId: savedInvitation.id,
          shopId: shop.id,
          shopName: shop.name,
          targetRole: dto.targetRole,
        },
      );
    }

    await this.broadcastShopMembersChanged(shopId, 'INVITATION_CREATED', invitedByUserId, {
      invitationId: savedInvitation.id,
    });

    const feBaseUrl = process.env.FE_URL || 'http://localhost:3000';
    return {
      invitation: savedInvitation,
      rawInviteToken,
      inviteUrl: `${feBaseUrl}/register?inviteToken=${rawInviteToken}`,
    };
  }

  /**
   * 5. Thu hồi Lời mời đang ở trạng thái PENDING (F00.2)
   */
  async revokeRoleInvitation(
    shopId: string,
    invitationId: string,
    actorUserId: string,
  ): Promise<{ id: string; status: InvitationStatusEnum }> {
    const invitation = await this.invitationRepo.findOne({
      where: { id: invitationId, shopId },
    });

    if (!invitation) {
      throw new NotFoundException('INVITATION_NOT_FOUND');
    }

    if (invitation.status !== InvitationStatusEnum.PENDING) {
      throw new BadRequestException('ONLY_PENDING_INVITATION_CAN_BE_REVOKED');
    }

    invitation.status = InvitationStatusEnum.REVOKED;
    await this.invitationRepo.save(invitation);

    const existingUser = await this.userRepo.findOne({
      where: { email: invitation.invitedEmail.trim().toLowerCase() },
    });

    if (existingUser) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        existingUser.id,
        SOCKET_CONFIG.events.IAM.INVITATION_REVOKED,
        {
          invitationId: invitation.id,
          shopId,
        },
      );
    }

    await this.broadcastShopMembersChanged(shopId, 'INVITATION_REVOKED', actorUserId, {
      invitationId: invitation.id,
    });

    return { id: invitation.id, status: invitation.status };
  }

  /**
   * 6. Chấp nhận Lời mời (Dành cho cả Tài khoản đã có sẵn bấm "Chấp nhận" hoặc Tài khoản mới vừa đăng ký qua inviteToken)
   * - Tự động tạo NotificationBell cho Chủ quán & Người mời + phát Socket `iam:invitation_accepted` và `iam:shop_members_changed`.
   */
  async acceptRoleInvitation(params: {
    userId: string;
    userEmail: string;
    invitationIdOrRawToken: string;
  }): Promise<{
    member: ShopMemberEntity;
    effectiveContext: EffectiveMemberContext;
  }> {
    const tokenHash = crypto
      .createHash('sha256')
      .update(params.invitationIdOrRawToken.trim())
      .digest('hex');

    const invitation = await this.invitationRepo.findOne({
      where: [
        {
          id: params.invitationIdOrRawToken,
          status: InvitationStatusEnum.PENDING,
        },
        { tokenHash, status: InvitationStatusEnum.PENDING },
      ],
    });

    if (!invitation) {
      throw new NotFoundException('INVITATION_NOT_FOUND_OR_ALREADY_USED');
    }

    if (new Date(invitation.expiresAt).getTime() <= Date.now()) {
      invitation.status = InvitationStatusEnum.EXPIRED;
      await this.invitationRepo.save(invitation);
      throw new BadRequestException('INVITATION_EXPIRED');
    }

    if (invitation.invitedEmail.trim().toLowerCase() !== params.userEmail.trim().toLowerCase()) {
      throw new ForbiddenException('INVITATION_EMAIL_MISMATCH');
    }

    let member = await this.memberRepo.findOne({
      where: { shopId: invitation.shopId, userId: params.userId },
    });

    if (!member) {
      member = this.memberRepo.create({
        shopId: invitation.shopId,
        userId: params.userId,
      });
    }

    member.role = invitation.targetRole;
    member.membershipStatus = MembershipStatusEnum.ACTIVE;
    member.dataScope = invitation.targetDataScope;
    member.shiftStatus = ShiftStatusEnum.ONLINE;
    member.maxDiscountPercent = Number(invitation.maxDiscountPercent);
    member.unmaskPhoneHourlyLimit = invitation.unmaskPhoneHourlyLimit;
    member.grantedPermissionsJson = invitation.grantedPermissionsJson || [];
    member.revokedPermissionsJson = [];
    member.allowedChannelIdsJson = invitation.allowedChannelIdsJson || [];
    member.allowedWarehouseIdsJson = invitation.allowedWarehouseIdsJson || [];
    member.savedPageGroupPresetsJson = member.savedPageGroupPresetsJson || [];
    member.lastShiftChangedAt = new Date();

    const savedMember = await this.memberRepo.save(member);

    invitation.status = InvitationStatusEnum.ACCEPTED;
    invitation.acceptedByUserId = params.userId;
    invitation.acceptedAt = new Date();
    await this.invitationRepo.save(invitation);

    await this.userRepo.update(params.userId, {
      lastActiveShopId: invitation.shopId,
    });

    const effectiveContext = await this.granularIamService.invalidateAndBroadcastMemberPermissions(
      invitation.shopId,
      params.userId,
    );

    const [shop, accepterUser, managerIds] = await Promise.all([
      this.shopRepo.findOne({ where: { id: invitation.shopId } }),
      this.userRepo.findOne({ where: { id: params.userId } }),
      this.getShopManagerUserIds(invitation.shopId, params.userId),
    ]);

    const recipientSet = new Set<string>(managerIds);
    if (invitation.invitedByUserId && invitation.invitedByUserId !== params.userId) {
      recipientSet.add(invitation.invitedByUserId);
    }
    const recipients = Array.from(recipientSet);

    if (recipients.length > 0 && shop) {
      const accepterName = accepterUser?.name || params.userEmail;
      await this.notificationsService.createAndDispatch({
        recipientIds: recipients,
        actorId: params.userId,
        type: NotificationTypeEnum.SHOP_INVITATION_ACCEPTED,
        title: `${accepterName} đã gia nhập cửa hàng ${shop.name}`,
        content: `${accepterName} đã chấp nhận lời mời và kích hoạt vai trò ${invitation.targetRole}.`,
        resourceType: NotificationResourceTypeEnum.SHOP_MEMBER,
        resourceId: savedMember.id,
        dedupeKey: `shop_inv_acc:${shop.id}:${params.userId}`,
        metadata: {
          actionUrl: '/settings/members?tab=ACTIVE_MEMBERS',
          titleKey: 'i18n.shopInvitationAccepted.title',
          contentKey: 'i18n.shopInvitationAccepted.content',
          i18nParams: {
            accepterName,
            shopName: shop.name,
            roleKey: invitation.targetRole,
          },
        },
      });

      for (const managerId of recipients) {
        this.realtimeEmitter.emitToUser(
          SOCKET_CONFIG.namespaces.CHAT,
          managerId,
          SOCKET_CONFIG.events.IAM.INVITATION_ACCEPTED,
          {
            shopId: shop.id,
            shopName: shop.name,
            memberId: savedMember.id,
            userId: params.userId,
            role: savedMember.role,
          },
        );
      }
    }

    await this.broadcastShopMembersChanged(
      invitation.shopId,
      'INVITATION_ACCEPTED',
      params.userId,
      { memberId: savedMember.id },
    );

    return { member: savedMember, effectiveContext };
  }

  /**
   * 7. LUỒNG 3 (F00.4): Nhân viên tự nhập Mã Cửa Hàng (joinCode) để xin vào quán
   * -> Tạo bản ghi ở trạng thái PENDING_APPROVAL (Quyền hoàn toàn trống [] cho tới khi Chủ quán duyệt!).
   * -> Đẩy thông báo NotificationBell & phát sự kiện Socket `iam:join_request_received` + `iam:shop_members_changed` tới toàn bộ Chủ quán & Quản lý!
   */
  async requestJoinShopByCode(userId: string, dto: JoinShopByCodeDto): Promise<ShopMemberEntity> {
    const shop = await this.shopRepo.findOne({
      where: { joinCode: dto.joinCode.trim().toUpperCase() },
    });
    if (!shop) {
      throw new NotFoundException('INVALID_SHOP_JOIN_CODE');
    }

    let member = await this.memberRepo.findOne({
      where: { shopId: shop.id, userId },
    });

    if (member) {
      if (member.membershipStatus === MembershipStatusEnum.ACTIVE) {
        throw new BadRequestException('ALREADY_ACTIVE_MEMBER_OF_THIS_SHOP');
      }
      member.membershipStatus = MembershipStatusEnum.PENDING_APPROVAL;
      member.requestedJoinNote = dto.requestedNote || member.requestedJoinNote || null;
      member.grantedPermissionsJson = [];
      member.revokedPermissionsJson = [];
    } else {
      member = this.memberRepo.create({
        shopId: shop.id,
        userId,
        role: ShopRoleEnum.SALE_AGENT,
        membershipStatus: MembershipStatusEnum.PENDING_APPROVAL,
        dataScope: DataScopeEnum.ASSIGNED_ONLY,
        shiftStatus: ShiftStatusEnum.OFFLINE,
        maxDiscountPercent: 0,
        unmaskPhoneHourlyLimit: 0,
        grantedPermissionsJson: [],
        revokedPermissionsJson: [],
        allowedChannelIdsJson: [],
        allowedWarehouseIdsJson: [],
        savedPageGroupPresetsJson: [],
        requestedJoinNote: dto.requestedNote || null,
      });
    }

    const savedPending = await this.memberRepo.save(member);

    const [requester, managerIds] = await Promise.all([
      this.userRepo.findOne({ where: { id: userId } }),
      this.getShopManagerUserIds(shop.id, userId),
    ]);

    const requesterName = requester?.name || requester?.email || 'Nhân sự mới';

    if (managerIds.length > 0) {
      await this.notificationsService.createAndDispatch({
        recipientIds: managerIds,
        actorId: userId,
        type: NotificationTypeEnum.SHOP_JOIN_REQUEST,
        title: `Yêu cầu xin vào cửa hàng ${shop.name}`,
        content: `${requesterName} vừa gửi yêu cầu gia nhập cửa hàng ${shop.name} và đang chờ phê duyệt vai trò.`,
        resourceType: NotificationResourceTypeEnum.SHOP_MEMBER,
        resourceId: savedPending.id,
        dedupeKey: `shop_join_req:${shop.id}:${userId}`,
        metadata: {
          actionUrl: '/settings/members?tab=PENDING_APPROVAL',
          titleKey: 'i18n.shopJoinRequest.title',
          contentKey: 'i18n.shopJoinRequest.content',
          i18nParams: {
            requesterName,
            shopName: shop.name,
            requestedNote: dto.requestedNote || '',
          },
        },
      });

      for (const managerId of managerIds) {
        this.realtimeEmitter.emitToUser(
          SOCKET_CONFIG.namespaces.CHAT,
          managerId,
          SOCKET_CONFIG.events.IAM.JOIN_REQUEST_RECEIVED,
          {
            shopId: shop.id,
            shopName: shop.name,
            memberId: savedPending.id,
            userId,
            requesterName,
            requestedNote: dto.requestedNote || null,
          },
        );
      }
    }

    await this.broadcastShopMembersChanged(shop.id, 'JOIN_REQUEST_RECEIVED', userId, {
      memberId: savedPending.id,
    });

    return savedPending;
  }

  /**
   * 8. Chủ quán / Quản lý Phê duyệt yêu cầu xin vào quán & Gán Vai trò chính thức (Sale / Kế toán / Kho...)
   * -> Kích hoạt quyền Real-Time cho nhân viên + bắn NotificationBell & `iam:join_request_approved` để mở khóa màn hình `/onboarding` ngay lập tức!
   */
  async approvePendingMemberAndAssignRole(
    shopId: string,
    memberId: string,
    actorUserId: string,
    dto: ApprovePendingMemberDto,
  ): Promise<EffectiveMemberContext> {
    if (dto.assignedRole === ShopRoleEnum.SHOP_OWNER) {
      throw new BadRequestException('CANNOT_ASSIGN_SHOP_OWNER_DIRECTLY');
    }

    const member = await this.memberRepo.findOne({
      where: { id: memberId, shopId },
    });
    if (!member) {
      throw new NotFoundException('SHOP_MEMBER_NOT_FOUND');
    }

    const preset = ROLE_PRESET_TEMPLATES[dto.assignedRole];

    member.role = dto.assignedRole;
    member.membershipStatus = MembershipStatusEnum.ACTIVE;
    member.dataScope = dto.assignedDataScope || preset.defaultDataScope;
    member.shiftStatus = ShiftStatusEnum.ONLINE;
    member.maxDiscountPercent = dto.maxDiscountPercent ?? preset.defaultMaxDiscountPercent;
    member.unmaskPhoneHourlyLimit =
      dto.unmaskPhoneHourlyLimit ?? preset.defaultUnmaskPhoneHourlyLimit;
    member.grantedPermissionsJson = preset.defaultPermissions;
    member.revokedPermissionsJson = [];
    member.allowedChannelIdsJson = dto.allowedChannelIds || [];
    member.allowedWarehouseIdsJson = dto.allowedWarehouseIds || [];
    member.lastShiftChangedAt = new Date();

    await this.memberRepo.save(member);

    await this.userRepo.update(member.userId, {
      lastActiveShopId: shopId,
    });

    const effectiveContext = await this.granularIamService.invalidateAndBroadcastMemberPermissions(
      shopId,
      member.userId,
    );

    const shop = await this.shopRepo.findOne({ where: { id: shopId } });

    if (shop) {
      await this.notificationsService.createAndDispatch({
        recipientIds: [member.userId],
        actorId: actorUserId,
        type: NotificationTypeEnum.SHOP_JOIN_APPROVED,
        title: `Đã được duyệt vào cửa hàng ${shop.name}`,
        content: `Yêu cầu gia nhập của bạn đã được phê duyệt với vai trò ${dto.assignedRole} tại ${shop.name}.`,
        resourceType: NotificationResourceTypeEnum.SHOP_WORKSPACE,
        resourceId: shop.id,
        dedupeKey: `shop_join_approved:${shop.id}:${member.userId}`,
        metadata: {
          actionUrl: '/chat',
          titleKey: 'i18n.shopJoinApproved.title',
          contentKey: 'i18n.shopJoinApproved.content',
          i18nParams: {
            shopName: shop.name,
            roleKey: dto.assignedRole,
          },
        },
      });

      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        member.userId,
        SOCKET_CONFIG.events.IAM.JOIN_REQUEST_APPROVED,
        {
          shopId: shop.id,
          shopName: shop.name,
          memberId: member.id,
          role: dto.assignedRole,
          effectiveContext,
        },
      );
    }

    await this.broadcastShopMembersChanged(shopId, 'JOIN_REQUEST_APPROVED', actorUserId, {
      memberId: member.id,
      userId: member.userId,
    });

    return effectiveContext;
  }

  /**
   * 9. Chủ quán / Quản lý Từ chối yêu cầu xin vào quán (F00.4)
   */
  async rejectPendingMemberRequest(
    shopId: string,
    memberId: string,
    actorUserId: string,
    reason?: string,
  ): Promise<{ id: string; rejected: boolean }> {
    const member = await this.memberRepo.findOne({
      where: { id: memberId, shopId },
    });

    if (!member) {
      throw new NotFoundException('SHOP_MEMBER_NOT_FOUND');
    }

    if (member.membershipStatus !== MembershipStatusEnum.PENDING_APPROVAL) {
      throw new BadRequestException('MEMBER_IS_NOT_PENDING_APPROVAL');
    }

    const targetUserId = member.userId;
    await this.memberRepo.remove(member);

    const shop = await this.shopRepo.findOne({ where: { id: shopId } });

    if (shop) {
      await this.notificationsService.createAndDispatch({
        recipientIds: [targetUserId],
        actorId: actorUserId,
        type: NotificationTypeEnum.SHOP_JOIN_REJECTED,
        title: `Yêu cầu gia nhập ${shop.name} bị từ chối`,
        content: `Chủ cửa hàng ${shop.name} đã từ chối yêu cầu gia nhập của bạn.`,
        resourceType: NotificationResourceTypeEnum.SHOP_WORKSPACE,
        resourceId: shop.id,
        dedupeKey: `shop_join_rejected:${shop.id}:${targetUserId}`,
        metadata: {
          actionUrl: '/onboarding?tab=JOIN_BY_CODE',
          titleKey: 'i18n.shopJoinRejected.title',
          contentKey: 'i18n.shopJoinRejected.content',
          i18nParams: {
            shopName: shop.name,
            reason: reason || '',
          },
        },
      });

      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        targetUserId,
        SOCKET_CONFIG.events.IAM.JOIN_REQUEST_REJECTED,
        {
          shopId: shop.id,
          shopName: shop.name,
          memberId,
          reason: reason || null,
        },
      );
    }

    await this.broadcastShopMembersChanged(shopId, 'JOIN_REQUEST_REJECTED', actorUserId, {
      memberId,
      userId: targetUserId,
    });

    return { id: memberId, rejected: true };
  }

  /**
   * 10. Làm mới (Regenerate) Mã gia nhập cửa hàng `joinCode` khi nghi ngờ lộ mã (F00.4)
   */
  async regenerateShopJoinCode(
    shopId: string,
    actorUserId: string,
  ): Promise<{ shopId: string; joinCode: string }> {
    const shop = await this.shopRepo.findOne({ where: { id: shopId } });
    if (!shop) {
      throw new NotFoundException('SHOP_NOT_FOUND');
    }

    const nextJoinCode = `PAN${crypto.randomInt(10000, 99999)}`;
    shop.joinCode = nextJoinCode;
    await this.shopRepo.save(shop);

    await this.broadcastShopMembersChanged(shopId, 'JOIN_CODE_REGENERATED', actorUserId, {
      joinCode: nextJoinCode,
    });

    return { shopId, joinCode: nextJoinCode };
  }

  /**
   * 11. LUỒNG 4 (F00.5): Đổi vai trò / Tinh chỉnh 92 mã quyền / Hạn mức chiết khấu & giải mã SĐT
   * -> Xóa cache Redis, bắn `iam:permissions_updated` + NotificationBell tới nhân viên mục tiêu + đồng bộ `iam:shop_members_changed`.
   */
  async updateMemberRoleAndPermissions(
    shopId: string,
    memberId: string,
    actorUserId: string,
    dto: UpdateMemberRoleAndPermissionsDto,
  ): Promise<EffectiveMemberContext> {
    const member = await this.memberRepo.findOne({
      where: { id: memberId, shopId },
    });
    if (!member) {
      throw new NotFoundException('SHOP_MEMBER_NOT_FOUND');
    }

    if (member.role === ShopRoleEnum.SHOP_OWNER) {
      throw new ForbiddenException('CANNOT_MODIFY_SHOP_OWNER_ROLE');
    }

    const preset = ROLE_PRESET_TEMPLATES[dto.role];

    member.role = dto.role;
    member.dataScope = dto.dataScope;
    member.maxDiscountPercent = dto.maxDiscountPercent;
    member.unmaskPhoneHourlyLimit = dto.unmaskPhoneHourlyLimit;
    member.grantedPermissionsJson = dto.grantedPermissionsJson ?? preset.defaultPermissions;
    member.revokedPermissionsJson = dto.revokedPermissionsJson ?? [];
    if (dto.allowedChannelIdsJson) {
      member.allowedChannelIdsJson = dto.allowedChannelIdsJson;
    }
    if (dto.allowedWarehouseIdsJson) {
      member.allowedWarehouseIdsJson = dto.allowedWarehouseIdsJson;
    }

    await this.memberRepo.save(member);

    const effectiveContext = await this.granularIamService.invalidateAndBroadcastMemberPermissions(
      shopId,
      member.userId,
    );

    const shop = await this.shopRepo.findOne({ where: { id: shopId } });

    if (shop && member.userId !== actorUserId) {
      await this.notificationsService.createAndDispatch({
        recipientIds: [member.userId],
        actorId: actorUserId,
        type: NotificationTypeEnum.SHOP_ROLE_UPDATED,
        title: `Cập nhật phân quyền tại ${shop.name}`,
        content: `Vai trò và quyền hạn của bạn tại ${shop.name} đã được cập nhật thành ${dto.role}.`,
        resourceType: NotificationResourceTypeEnum.SHOP_WORKSPACE,
        resourceId: shop.id,
        dedupeKey: `shop_role_upd:${shop.id}:${member.userId}`,
        metadata: {
          actionUrl: '/chat',
          titleKey: 'i18n.shopRoleUpdated.title',
          contentKey: 'i18n.shopRoleUpdated.content',
          i18nParams: {
            shopName: shop.name,
            roleKey: dto.role,
          },
        },
      });
    }

    await this.broadcastShopMembersChanged(shopId, 'MEMBER_PERMISSIONS_UPDATED', actorUserId, {
      memberId: member.id,
      userId: member.userId,
    });

    return effectiveContext;
  }

  /**
   * 12. LUỒNG 4 (F00.6): Tạm đình chỉ (SUSPENDED) / Cho nghỉ việc (TERMINATED) / Khôi phục (ACTIVE) nhân sự
   */
  async updateMemberStatus(
    shopId: string,
    memberId: string,
    actorUserId: string,
    membershipStatus: MembershipStatusEnum,
  ): Promise<EffectiveMemberContext> {
    const member = await this.memberRepo.findOne({
      where: { id: memberId, shopId },
    });
    if (!member) {
      throw new NotFoundException('SHOP_MEMBER_NOT_FOUND');
    }
    if (member.role === ShopRoleEnum.SHOP_OWNER) {
      throw new ForbiddenException('CANNOT_SUSPEND_SHOP_OWNER');
    }

    member.membershipStatus = membershipStatus;
    if (membershipStatus !== MembershipStatusEnum.ACTIVE) {
      member.shiftStatus = ShiftStatusEnum.OFFLINE;
    }
    await this.memberRepo.save(member);

    const effectiveContext = await this.granularIamService.invalidateAndBroadcastMemberPermissions(
      shopId,
      member.userId,
    );

    const shop = await this.shopRepo.findOne({ where: { id: shopId } });

    if (shop && member.userId !== actorUserId) {
      await this.notificationsService.createAndDispatch({
        recipientIds: [member.userId],
        actorId: actorUserId,
        type: NotificationTypeEnum.SHOP_MEMBER_STATUS_CHANGED,
        title: `Trạng thái làm việc tại ${shop.name} đã thay đổi`,
        content: `Trạng thái nhân sự của bạn tại ${shop.name} đã chuyển sang ${membershipStatus}.`,
        resourceType: NotificationResourceTypeEnum.SHOP_WORKSPACE,
        resourceId: shop.id,
        dedupeKey: `shop_status_chg:${shop.id}:${member.userId}`,
        metadata: {
          actionUrl: membershipStatus === MembershipStatusEnum.ACTIVE ? '/chat' : '/onboarding',
          titleKey: 'i18n.shopMemberStatusChanged.title',
          contentKey: 'i18n.shopMemberStatusChanged.content',
          i18nParams: {
            shopName: shop.name,
            statusKey: membershipStatus,
          },
        },
      });

      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        member.userId,
        SOCKET_CONFIG.events.IAM.MEMBER_STATUS_CHANGED,
        {
          shopId: shop.id,
          shopName: shop.name,
          memberId: member.id,
          membershipStatus,
          effectiveContext,
        },
      );
    }

    await this.broadcastShopMembersChanged(shopId, 'MEMBER_STATUS_CHANGED', actorUserId, {
      memberId: member.id,
      userId: member.userId,
      membershipStatus,
    });

    return effectiveContext;
  }

  /**
   * 13. LUỒNG 4 (F00.6): Chuyển nhượng quyền Chủ cửa hàng (SHOP_OWNER) sang thành viên đang hoạt động khác
   * -> Đảm bảo bất biến có đúng 1 SHOP_OWNER duy nhất tại mọi thời điểm. Chủ cũ chuyển thành SHOP_MANAGER.
   */
  async transferShopOwnership(
    shopId: string,
    currentOwnerUserId: string,
    targetMemberId: string,
  ): Promise<{
    newOwnerContext: EffectiveMemberContext;
    previousOwnerContext: EffectiveMemberContext;
  }> {
    const [shop, currentOwnerMember, targetMember] = await Promise.all([
      this.shopRepo.findOne({ where: { id: shopId } }),
      this.memberRepo.findOne({
        where: {
          shopId,
          userId: currentOwnerUserId,
          role: ShopRoleEnum.SHOP_OWNER,
          membershipStatus: MembershipStatusEnum.ACTIVE,
        },
      }),
      this.memberRepo.findOne({
        where: {
          id: targetMemberId,
          shopId,
          membershipStatus: MembershipStatusEnum.ACTIVE,
        },
      }),
    ]);

    if (!shop || !currentOwnerMember) {
      throw new ForbiddenException('ONLY_SHOP_OWNER_CAN_TRANSFER_OWNERSHIP');
    }

    if (!targetMember) {
      throw new NotFoundException('TARGET_ACTIVE_MEMBER_NOT_FOUND');
    }

    if (targetMember.userId === currentOwnerUserId) {
      throw new BadRequestException('ALREADY_SHOP_OWNER');
    }

    const managerPreset = ROLE_PRESET_TEMPLATES[ShopRoleEnum.SHOP_MANAGER];
    const ownerPreset = ROLE_PRESET_TEMPLATES[ShopRoleEnum.SHOP_OWNER];

    await this.dataSource.transaction(async (manager) => {
      shop.ownerId = targetMember.userId;
      await manager.save(ShopWorkspaceEntity, shop);

      currentOwnerMember.role = ShopRoleEnum.SHOP_MANAGER;
      currentOwnerMember.dataScope = managerPreset.defaultDataScope;
      currentOwnerMember.maxDiscountPercent = managerPreset.defaultMaxDiscountPercent;
      currentOwnerMember.unmaskPhoneHourlyLimit = managerPreset.defaultUnmaskPhoneHourlyLimit;
      currentOwnerMember.grantedPermissionsJson = managerPreset.defaultPermissions;
      currentOwnerMember.revokedPermissionsJson = [];
      await manager.save(ShopMemberEntity, currentOwnerMember);

      targetMember.role = ShopRoleEnum.SHOP_OWNER;
      targetMember.dataScope = ownerPreset.defaultDataScope;
      targetMember.maxDiscountPercent = ownerPreset.defaultMaxDiscountPercent;
      targetMember.unmaskPhoneHourlyLimit = ownerPreset.defaultUnmaskPhoneHourlyLimit;
      targetMember.grantedPermissionsJson = ownerPreset.defaultPermissions;
      targetMember.revokedPermissionsJson = [];
      await manager.save(ShopMemberEntity, targetMember);
    });

    const [previousOwnerContext, newOwnerContext] = await Promise.all([
      this.granularIamService.invalidateAndBroadcastMemberPermissions(shopId, currentOwnerUserId),
      this.granularIamService.invalidateAndBroadcastMemberPermissions(shopId, targetMember.userId),
    ]);

    await this.notificationsService.createAndDispatch({
      recipientIds: [targetMember.userId],
      actorId: currentOwnerUserId,
      type: NotificationTypeEnum.SHOP_ROLE_UPDATED,
      title: `Bạn đã trở thành Chủ cửa hàng ${shop.name}`,
      content: `Quyền Chủ cửa hàng (SHOP_OWNER) tại ${shop.name} đã được chuyển nhượng cho bạn.`,
      resourceType: NotificationResourceTypeEnum.SHOP_WORKSPACE,
      resourceId: shop.id,
      dedupeKey: `shop_owner_transfer:${shop.id}:${targetMember.userId}`,
      metadata: {
        actionUrl: '/settings/members?tab=ACTIVE_MEMBERS',
        titleKey: 'i18n.shopOwnershipTransferred.title',
        contentKey: 'i18n.shopOwnershipTransferred.content',
        i18nParams: {
          shopName: shop.name,
        },
      },
    });

    await this.broadcastShopMembersChanged(shopId, 'OWNERSHIP_TRANSFERRED', currentOwnerUserId, {
      newOwnerUserId: targetMember.userId,
    });

    return { newOwnerContext, previousOwnerContext };
  }

  /**
   * 14. LUỒNG 4 (F00.7): Chuyển đổi cửa hàng đang làm việc (Multi-Shop Context Switcher)
   */
  async switchActiveShop(userId: string, shopId: string): Promise<EffectiveMemberContext> {
    const context = await this.granularIamService.getEffectiveMemberContext(shopId, userId);
    if (context.membershipStatus !== MembershipStatusEnum.ACTIVE) {
      throw new ForbiddenException('SHOP_MEMBERSHIP_NOT_ACTIVE');
    }
    await this.userRepo.update(userId, { lastActiveShopId: shopId });
    return context;
  }

  async getShopMembersAndInvitations(shopId: string): Promise<{
    shop: ShopWorkspaceEntity | null;
    members: ShopMemberEntity[];
    invitations: ShopInvitationEntity[];
  }> {
    const [shop, members, invitations] = await Promise.all([
      this.shopRepo.findOne({ where: { id: shopId } }),
      this.memberRepo.find({
        where: { shopId },
        relations: ['user'],
        order: { createdAt: 'ASC' },
      }),
      this.invitationRepo.find({
        where: { shopId },
        order: { createdAt: 'DESC' },
      }),
    ]);

    return { shop, members, invitations };
  }
}
