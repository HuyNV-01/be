import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { GroupRoleEnum, NotificationResourceTypeEnum, NotificationTypeEnum } from 'src/common/enum';
import {
  ConversationSupportStatusEnum,
  DataScopeEnum,
  MembershipStatusEnum,
  PermissionCodeEnum,
  ShiftStatusEnum,
  ShopRoleEnum,
} from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { ROLE_DEFAULT_PERMISSIONS_MAP } from 'src/constants/role-default-permissions.constant';
import { UpdateShopWorkspaceSettingsDto } from 'src/dto/onboarding/onboarding.dto';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { SavedPageGroupPreset, ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { UserEntity } from 'src/entity/user.entity';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import { In, Repository } from 'typeorm';

export interface EffectiveMemberContext {
  shopId: string;
  userId: string;
  memberId: string;
  role: ShopRoleEnum;
  membershipStatus: MembershipStatusEnum;
  dataScope: DataScopeEnum;
  shiftStatus: ShiftStatusEnum;
  teamCode: string | null;
  maxConcurrentChats: number;
  maxDiscountPercent: number;
  unmaskPhoneHourlyLimit: number;
  permissions: PermissionCodeEnum[];
  allowedChannelIds: string[];
  allowedWarehouseIds: string[];
  savedPageGroupPresets: SavedPageGroupPreset[];
}

@Injectable()
export class GranularIamService {
  private readonly logger = new Logger(GranularIamService.name);
  private readonly IAM_CACHE_PREFIX = 'iam:eff:';
  private readonly IAM_CACHE_TTL = 3600;

  constructor(
    @InjectRepository(ShopMemberEntity)
    private readonly shopMemberRepo: Repository<ShopMemberEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopWorkspaceRepo: Repository<ShopWorkspaceEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(ConversationParticipantEntity)
    private readonly participantRepo: Repository<ConversationParticipantEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRedis() private readonly redis: Redis,
    private readonly realtimeEmitter: RealtimeEmitterService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private buildCacheKey(shopId: string, userId: string): string {
    return `${this.IAM_CACHE_PREFIX}${shopId}:${userId}`;
  }

  private async getActiveShopMemberUserIds(shopId: string): Promise<string[]> {
    const members = await this.shopMemberRepo.find({
      where: {
        shopId,
        membershipStatus: MembershipStatusEnum.ACTIVE,
      },
      select: ['userId'],
    });
    return Array.from(new Set(members.map((m) => m.userId)));
  }

  private async ensureConversationParticipants(
    conversationIds: string[],
    userId: string,
  ): Promise<void> {
    if (!userId || conversationIds.length === 0) return;
    const now = new Date();
    for (const conversationId of conversationIds) {
      const existing = await this.participantRepo.findOne({
        where: { conversationId, userId },
      });
      if (!existing) {
        const part = this.participantRepo.create({
          conversationId,
          userId,
          role: GroupRoleEnum.MEMBER,
          isAdmin: false,
          isHidden: false,
          joinedAt: now,
        });
        await this.participantRepo.save(part).catch(() => undefined);
      } else if (existing.isHidden) {
        await this.participantRepo.update(existing.id, { isHidden: false }).catch(() => undefined);
      }
    }
  }

  async getEffectiveMemberContext(shopId: string, userId: string): Promise<EffectiveMemberContext> {
    const cacheKey = this.buildCacheKey(shopId, userId);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as EffectiveMemberContext;
    }

    const member = await this.shopMemberRepo.findOne({
      where: { shopId, userId },
    });

    if (!member) {
      throw new ForbiddenException({
        code: 'USER_NOT_IN_SHOP_WORKSPACE',
        message: 'User does not belong to this shop workspace',
      });
    }

    if (member.membershipStatus !== MembershipStatusEnum.ACTIVE) {
      const inactiveContext: EffectiveMemberContext = {
        shopId: member.shopId,
        userId: member.userId,
        memberId: member.id,
        role: member.role,
        membershipStatus: member.membershipStatus,
        dataScope: DataScopeEnum.ASSIGNED_ONLY,
        shiftStatus: ShiftStatusEnum.OFFLINE,
        teamCode: member.teamCode,
        maxConcurrentChats: 0,
        maxDiscountPercent: 0,
        unmaskPhoneHourlyLimit: 0,
        permissions: [],
        allowedChannelIds: [],
        allowedWarehouseIds: [],
        savedPageGroupPresets: [],
      };
      await this.redis.set(cacheKey, JSON.stringify(inactiveContext), 'EX', this.IAM_CACHE_TTL);
      return inactiveContext;
    }

    const baseRolePerms =
      member.role === ShopRoleEnum.SHOP_OWNER
        ? Object.values(PermissionCodeEnum)
        : ROLE_DEFAULT_PERMISSIONS_MAP[member.role] || [];

    const grantedSet = new Set<PermissionCodeEnum>([
      ...baseRolePerms,
      ...(member.grantedPermissionsJson || []),
    ]);

    for (const revoked of member.revokedPermissionsJson || []) {
      if (member.role !== ShopRoleEnum.SHOP_OWNER) {
        grantedSet.delete(revoked);
      }
    }

    const context: EffectiveMemberContext = {
      shopId: member.shopId,
      userId: member.userId,
      memberId: member.id,
      role: member.role,
      membershipStatus: member.membershipStatus,
      dataScope:
        member.role === ShopRoleEnum.SHOP_OWNER ? DataScopeEnum.ALL_SHOP : member.dataScope,
      shiftStatus: member.shiftStatus,
      teamCode: member.teamCode,
      maxConcurrentChats: Number(member.maxConcurrentChats || 25),
      maxDiscountPercent: Number(member.maxDiscountPercent),
      unmaskPhoneHourlyLimit: member.unmaskPhoneHourlyLimit,
      permissions: Array.from(grantedSet),
      allowedChannelIds: member.allowedChannelIdsJson || [],
      allowedWarehouseIds: member.allowedWarehouseIdsJson || [],
      savedPageGroupPresets: member.savedPageGroupPresetsJson || [],
    };

    await this.redis.set(cacheKey, JSON.stringify(context), 'EX', this.IAM_CACHE_TTL);

    return context;
  }

  async invalidateAndBroadcastMemberPermissions(
    shopId: string,
    userId: string,
  ): Promise<EffectiveMemberContext> {
    await this.redis.del(this.buildCacheKey(shopId, userId));
    const updatedContext = await this.getEffectiveMemberContext(shopId, userId);

    this.realtimeEmitter.emitToUser(
      SOCKET_CONFIG.namespaces.CHAT,
      userId,
      SOCKET_CONFIG.events.IAM.PERMISSIONS_UPDATED,
      updatedContext,
    );

    return updatedContext;
  }

  async updateShiftStatus(params: {
    shopId: string;
    userId: string;
    targetStatus: ShiftStatusEnum;
    handoverMode?: 'AUTO_REDISTRIBUTE' | 'TRANSFER_TO_AGENT' | 'KEEP_ASSIGNED';
    targetHandoverAgentId?: string;
    forcedByManagerId?: string;
  }): Promise<{
    shiftStatus: ShiftStatusEnum;
    reassignedConversationCount: number;
  }> {
    const [member, shop, actorUser] = await Promise.all([
      this.shopMemberRepo.findOne({
        where: { shopId: params.shopId, userId: params.userId },
      }),
      this.shopWorkspaceRepo.findOne({ where: { id: params.shopId } }),
      this.userRepo.findOne({
        where: { id: params.forcedByManagerId || params.userId },
      }),
    ]);

    if (!member) {
      throw new NotFoundException('SHOP_MEMBER_NOT_FOUND');
    }

    let reassignedCount = 0;
    const recipientAssignments = new Map<string, string[]>();

    if (params.targetStatus === ShiftStatusEnum.OFFLINE) {
      const pendingConversations = await this.conversationRepo.find({
        where: {
          shopId: params.shopId,
          assignedAgentId: params.userId,
          supportStatus: ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
        },
        select: ['id', 'channelIntegrationId', 'name'],
      });

      if (pendingConversations.length > 0 && !params.handoverMode && !params.forcedByManagerId) {
        throw new ForbiddenException({
          code: 'SHIFT_HANDOVER_REQUIRED',
          pendingConversationCount: pendingConversations.length,
          messageKey: 'ShiftAndIam.handoverModal.description',
        });
      }

      if (pendingConversations.length > 0 && params.handoverMode !== 'KEEP_ASSIGNED') {
        const convIds = pendingConversations.map((c) => c.id);

        if (params.handoverMode === 'TRANSFER_TO_AGENT' && params.targetHandoverAgentId) {
          await this.conversationRepo.update(
            { id: In(convIds) },
            { assignedAgentId: params.targetHandoverAgentId },
          );
          await this.ensureConversationParticipants(convIds, params.targetHandoverAgentId);
          await this.redis.zincrby(
            `routing:active_load:${params.shopId}`,
            convIds.length,
            params.targetHandoverAgentId,
          );
          recipientAssignments.set(params.targetHandoverAgentId, convIds);
          reassignedCount = convIds.length;
        } else {
          const onlineColleagues = await this.shopMemberRepo.find({
            where: {
              shopId: params.shopId,
              membershipStatus: MembershipStatusEnum.ACTIVE,
              shiftStatus: ShiftStatusEnum.ONLINE,
            },
          });
          const eligibleColleagues = onlineColleagues.filter((c) => c.userId !== params.userId);

          if (eligibleColleagues.length > 0) {
            for (let i = 0; i < convIds.length; i++) {
              const targetColleague = eligibleColleagues[i % eligibleColleagues.length];
              await this.conversationRepo.update(
                { id: convIds[i] },
                { assignedAgentId: targetColleague.userId },
              );
              await this.ensureConversationParticipants([convIds[i]], targetColleague.userId);
              await this.redis.zincrby(
                `routing:active_load:${params.shopId}`,
                1,
                targetColleague.userId,
              );
              const existingList = recipientAssignments.get(targetColleague.userId) || [];
              existingList.push(convIds[i]);
              recipientAssignments.set(targetColleague.userId, existingList);
            }
          } else {
            await this.conversationRepo.update({ id: In(convIds) }, { assignedAgentId: null });
          }
          reassignedCount = convIds.length;
        }
      }

      await this.redis.zrem(`routing:active_load:${params.shopId}`, params.userId);
    } else if (params.targetStatus === ShiftStatusEnum.ONLINE) {
      const activeCount = await this.conversationRepo.count({
        where: {
          shopId: params.shopId,
          assignedAgentId: params.userId,
          supportStatus: ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
        },
      });
      await this.redis.zadd(`routing:active_load:${params.shopId}`, activeCount, params.userId);
    } else if (params.targetStatus === ShiftStatusEnum.BUSY) {
      await this.redis.zrem(`routing:active_load:${params.shopId}`, params.userId);
    }

    member.shiftStatus = params.targetStatus;
    member.lastShiftChangedAt = new Date();
    await this.shopMemberRepo.save(member);

    await this.invalidateAndBroadcastMemberPermissions(params.shopId, params.userId);

    const activeUserIds = await this.getActiveShopMemberUserIds(params.shopId);
    for (const uid of activeUserIds) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        uid,
        SOCKET_CONFIG.events.IAM.SHIFT_STATUS_CHANGED,
        {
          shopId: params.shopId,
          userId: params.userId,
          shiftStatus: member.shiftStatus,
          reassignedConversationCount: reassignedCount,
          forcedByManagerId: params.forcedByManagerId || null,
        },
      );

      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        uid,
        SOCKET_CONFIG.events.IAM.SHOP_MEMBERS_CHANGED,
        {
          shopId: params.shopId,
          action: 'SHIFT_STATUS_CHANGED',
          userId: params.userId,
          shiftStatus: member.shiftStatus,
        },
      );
    }

    const shopName = shop?.name || 'Cửa hàng';
    const actorName = actorUser?.name || actorUser?.email || 'Đồng nghiệp';

    for (const [colleagueUserId, assignedConvIds] of recipientAssignments.entries()) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        colleagueUserId,
        SOCKET_CONFIG.events.IAM.SHIFT_HANDOVER_COMPLETED,
        {
          shopId: params.shopId,
          fromUserId: params.userId,
          toUserId: colleagueUserId,
          conversationIds: assignedConvIds,
          count: assignedConvIds.length,
        },
      );

      await this.notificationsService.createAndDispatch({
        recipientIds: [colleagueUserId],
        actorId: params.forcedByManagerId || params.userId,
        type: NotificationTypeEnum.SHOP_SHIFT_HANDOVER,
        title: `Nhận bàn giao ${assignedConvIds.length} cuộc hội thoại`,
        content: `${actorName} đã bàn giao ${assignedConvIds.length} cuộc hội thoại chờ phản hồi tại ${shopName} cho bạn.`,
        resourceType: NotificationResourceTypeEnum.CONVERSATION,
        resourceId: assignedConvIds[0] || params.shopId,
        dedupeKey: `shift_handover:${params.shopId}:${colleagueUserId}:${Date.now()}`,
        metadata: {
          conversationId: assignedConvIds[0],
          actionUrl: '/chat',
          titleKey: 'i18n.shopShiftHandover.title',
          contentKey: 'i18n.shopShiftHandover.content',
          i18nParams: {
            actorName,
            shopName,
            count: assignedConvIds.length,
          },
        },
      });
    }

    if (params.forcedByManagerId) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        params.userId,
        SOCKET_CONFIG.events.IAM.FORCE_SHIFT_HANDOVER,
        {
          shopId: params.shopId,
          forcedByManagerId: params.forcedByManagerId,
          forcedByManagerName: actorName,
          reassignedConversationCount: reassignedCount,
        },
      );

      if (params.userId !== params.forcedByManagerId) {
        await this.notificationsService.createAndDispatch({
          recipientIds: [params.userId],
          actorId: params.forcedByManagerId,
          type: NotificationTypeEnum.SHOP_FORCE_OFFLINE,
          title: `Ca trực tại ${shopName} đã được chuyển sang Nghỉ ca`,
          content: `${actorName} đã chuyển trạng thái ca trực của bạn sang Nghỉ ca và điều phối lại ${reassignedCount} hội thoại đang chờ.`,
          resourceType: NotificationResourceTypeEnum.SHOP_WORKSPACE,
          resourceId: params.shopId,
          dedupeKey: `force_offline:${params.shopId}:${params.userId}:${Date.now()}`,
          metadata: {
            actionUrl: '/settings/permissions',
            titleKey: 'i18n.shopForceOffline.title',
            contentKey: 'i18n.shopForceOffline.content',
            i18nParams: {
              actorName,
              shopName,
              count: reassignedCount,
            },
          },
        });
      }
    }

    return {
      shiftStatus: member.shiftStatus,
      reassignedConversationCount: reassignedCount,
    };
  }

  async saveMemberPageGroupPresets(
    shopId: string,
    userId: string,
    presets: SavedPageGroupPreset[],
  ): Promise<EffectiveMemberContext> {
    const member = await this.shopMemberRepo.findOne({
      where: { shopId, userId },
    });
    if (!member) {
      throw new NotFoundException('SHOP_MEMBER_NOT_FOUND');
    }

    member.savedPageGroupPresetsJson = presets;
    await this.shopMemberRepo.save(member);

    return this.invalidateAndBroadcastMemberPermissions(shopId, userId);
  }

  async getWorkspaceSettings(shopId: string): Promise<ShopWorkspaceEntity> {
    const cacheKey = `shop:cfg:${shopId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as ShopWorkspaceEntity;
      } catch {}
    }

    const shop = await this.shopWorkspaceRepo.findOne({ where: { id: shopId } });
    if (!shop) {
      throw new NotFoundException('SHOP_WORKSPACE_NOT_FOUND');
    }

    await this.redis.set(cacheKey, JSON.stringify(shop), 'EX', 3600);
    return shop;
  }

  async updateWorkspaceSettings(
    shopId: string,
    dto: UpdateShopWorkspaceSettingsDto,
    actorUserId?: string,
  ): Promise<ShopWorkspaceEntity> {
    const shop = await this.shopWorkspaceRepo.findOne({ where: { id: shopId } });
    if (!shop) {
      throw new NotFoundException('SHOP_WORKSPACE_NOT_FOUND');
    }

    if (dto.slaResponseSeconds !== undefined) {
      shop.slaResponseSeconds = dto.slaResponseSeconds;
    }
    if (dto.ghostedAlertSeconds !== undefined) {
      shop.ghostedAlertSeconds = dto.ghostedAlertSeconds;
    }
    if (dto.autoReclaimMinutes !== undefined) {
      shop.autoReclaimMinutes = dto.autoReclaimMinutes;
    }
    if (dto.routingStrategy !== undefined) {
      shop.routingStrategy = dto.routingStrategy;
    }
    if (dto.lockOrderAfterPrint !== undefined) {
      shop.lockOrderAfterPrint = dto.lockOrderAfterPrint;
    }
    if (dto.requireDepositOnHighRisk !== undefined) {
      shop.requireDepositOnHighRisk = dto.requireDepositOnHighRisk;
    }

    if (
      dto.leadCollectorWeight !== undefined ||
      dto.orderCloserWeight !== undefined ||
      dto.deductOnReturnedOrder !== undefined
    ) {
      const rawLeadWeight = Number(
        dto.leadCollectorWeight ?? shop.commissionSplitConfigJson?.leadCollectorWeight ?? 0.4,
      );
      const rawCloserWeight = Number(
        dto.orderCloserWeight ?? shop.commissionSplitConfigJson?.orderCloserWeight ?? 0.6,
      );
      const weightSum = rawLeadWeight + rawCloserWeight;
      const normalizedLeadWeight =
        weightSum > 0 ? Number((rawLeadWeight / weightSum).toFixed(2)) : 0.4;
      const normalizedCloserWeight = Number((1 - normalizedLeadWeight).toFixed(2));

      shop.commissionSplitConfigJson = {
        leadCollectorWeight: normalizedLeadWeight,
        orderCloserWeight: normalizedCloserWeight,
        deductOnReturnedOrder:
          dto.deductOnReturnedOrder ??
          shop.commissionSplitConfigJson?.deductOnReturnedOrder ??
          true,
      };
    }

    if (
      dto.autoReserveStockOnMarketplaceOrder !== undefined ||
      dto.safetyBufferStockQty !== undefined ||
      dto.pushAvailableStockToShopeeTikTok !== undefined
    ) {
      shop.marketplaceSyncConfigJson = {
        autoReserveStockOnMarketplaceOrder:
          dto.autoReserveStockOnMarketplaceOrder ??
          shop.marketplaceSyncConfigJson?.autoReserveStockOnMarketplaceOrder ??
          true,
        safetyBufferStockQty:
          dto.safetyBufferStockQty ?? shop.marketplaceSyncConfigJson?.safetyBufferStockQty ?? 2,
        pushAvailableStockToShopeeTikTok:
          dto.pushAvailableStockToShopeeTikTok ??
          shop.marketplaceSyncConfigJson?.pushAvailableStockToShopeeTikTok ??
          true,
      };
    }

    const saved = await this.shopWorkspaceRepo.save(shop);
    await this.redis.set(`shop:cfg:${shopId}`, JSON.stringify(saved), 'EX', 3600);

    const activeUserIds = await this.getActiveShopMemberUserIds(shopId);
    for (const uid of activeUserIds) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        uid,
        SOCKET_CONFIG.events.IAM.WORKSPACE_SETTINGS_UPDATED,
        {
          shopId,
          settings: saved,
          updatedBy: actorUserId || null,
        },
      );
    }

    if (actorUserId) {
      const managers = await this.shopMemberRepo.find({
        where: {
          shopId,
          membershipStatus: MembershipStatusEnum.ACTIVE,
          role: In([ShopRoleEnum.SHOP_OWNER, ShopRoleEnum.SHOP_MANAGER]),
        },
        select: ['userId'],
      });
      const recipientIds = managers.map((m) => m.userId).filter((uid) => uid !== actorUserId);

      if (recipientIds.length > 0) {
        await this.notificationsService.createAndDispatch({
          recipientIds,
          actorId: actorUserId,
          type: NotificationTypeEnum.SHOP_WORKSPACE_UPDATED,
          title: `Cập nhật cấu hình vận hành tại ${saved.name}`,
          content: `Cấu hình định tuyến khách hàng và cam kết SLA (${saved.slaResponseSeconds}s) tại ${saved.name} vừa được cập nhật.`,
          resourceType: NotificationResourceTypeEnum.SHOP_WORKSPACE,
          resourceId: saved.id,
          dedupeKey: `shop_cfg_upd:${saved.id}`,
          metadata: {
            actionUrl: '/settings/channels',
            titleKey: 'i18n.shopWorkspaceUpdated.title',
            contentKey: 'i18n.shopWorkspaceUpdated.content',
            i18nParams: {
              shopName: saved.name,
              slaSeconds: saved.slaResponseSeconds,
              reclaimMinutes: saved.autoReclaimMinutes,
            },
          },
        });
      }
    }

    return saved;
  }
}
