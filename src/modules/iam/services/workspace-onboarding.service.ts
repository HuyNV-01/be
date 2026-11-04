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
import { NotificationEntity } from 'src/entity/notification.entity';
import { ShopInvitationEntity } from 'src/entity/shop-invitation.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { UserEntity } from 'src/entity/user.entity';
import { WarehouseEntity } from 'src/entity/warehouse.entity';
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
    @InjectRepository(NotificationEntity)
    private readonly notificationRepo: Repository<NotificationEntity>,
    private readonly granularIamService: GranularIamService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

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

    const invitation = this.invitationRepo.create({
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

    const savedInvitation = await this.invitationRepo.save(invitation);

    const existingUser = await this.userRepo.findOne({
      where: { email: normalizedEmail },
    });
    const shop = await this.shopRepo.findOne({ where: { id: shopId } });

    if (existingUser && shop) {
      const notif = this.notificationRepo.create({
        recipientId: existingUser.id,
        actorId: invitedByUserId,
        type: NotificationTypeEnum.SYSTEM,
        resourceType: NotificationResourceTypeEnum.SYSTEM,
        resourceId: savedInvitation.id,
        title: `Lời mời tham gia cửa hàng ${shop.name}`,
        content: `Bạn được mời đảm nhận vai trò ${dto.targetRole} tại ${shop.name}`,
        metadata: {
          actionUrl: '/onboarding',
          titleKey: 'OnboardingAndRoles.invitationReceivedTitle',
          contentKey: 'OnboardingAndRoles.invitationReceivedDesc',
          i18nParams: {
            shopName: shop.name,
            roleName: dto.targetRole,
          },
        },
      });
      const savedNotif = await this.notificationRepo.save(notif);

      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        existingUser.id,
        'new_notification',
        savedNotif,
      );
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        existingUser.id,
        'iam:invitation_received',
        {
          invitationId: savedInvitation.id,
          shopId: shop.id,
          shopName: shop.name,
          targetRole: dto.targetRole,
        },
      );
    }

    const feBaseUrl = process.env.FE_URL || 'http://localhost:3000';
    return {
      invitation: savedInvitation,
      rawInviteToken,
      inviteUrl: `${feBaseUrl}/register?inviteToken=${rawInviteToken}`,
    };
  }

  /**
   * 5. Chấp nhận Lời mời (Dành cho cả Tài khoản đã có sẵn bấm "Chấp nhận" hoặc Tài khoản mới vừa đăng ký qua inviteToken)
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

    return { member: savedMember, effectiveContext };
  }

  /**
   * 6. LUỒNG 3 (F00.4): Nhân viên tự nhập Mã Cửa Hàng (joinCode) để xin vào quán
   * -> Tạo bản ghi ở trạng thái PENDING_APPROVAL (Quyền hoàn toàn trống [] cho tới khi Chủ quán duyệt!).
   */
  async requestJoinShopByCode(userId: string, dto: JoinShopByCodeDto): Promise<ShopMemberEntity> {
    const shop = await this.shopRepo.findOne({
      where: { joinCode: dto.joinCode.trim().toUpperCase() },
    });
    if (!shop) {
      throw new NotFoundException('INVALID_SHOP_JOIN_CODE');
    }

    const existing = await this.memberRepo.findOne({
      where: { shopId: shop.id, userId },
    });
    if (existing) {
      return existing;
    }

    const pendingMember = this.memberRepo.create({
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

    const savedPending = await this.memberRepo.save(pendingMember);

    this.realtimeEmitter.emitToUser(
      SOCKET_CONFIG.namespaces.CHAT,
      shop.ownerId,
      'iam:join_request_received',
      {
        shopId: shop.id,
        memberId: savedPending.id,
        userId,
        requestedNote: dto.requestedNote,
      },
    );

    return savedPending;
  }

  /**
   * 7. Chủ quán / Quản lý Phê duyệt yêu cầu xin vào quán & Gán Vai trò chính thức (Sale / Kế toán / Kho...)
   */
  async approvePendingMemberAndAssignRole(
    shopId: string,
    memberId: string,
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

    return this.granularIamService.invalidateAndBroadcastMemberPermissions(shopId, member.userId);
  }

  /**
   * 8. LUỒNG 4 (F00.5 – F00.7): Đổi vai trò / Tinh chỉnh 92 mã quyền / Đình chỉ nhân viên / Chuyển đổi cửa hàng
   */
  async updateMemberRoleAndPermissions(
    shopId: string,
    memberId: string,
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

    return this.granularIamService.invalidateAndBroadcastMemberPermissions(shopId, member.userId);
  }

  async updateMemberStatus(
    shopId: string,
    memberId: string,
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

    return this.granularIamService.invalidateAndBroadcastMemberPermissions(shopId, member.userId);
  }

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
