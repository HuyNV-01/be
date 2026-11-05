import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
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
import { ConversationEntity } from 'src/entity/conversation.entity';
import { SavedPageGroupPreset, ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
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
    @InjectRedis() private readonly redis: Redis,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private buildCacheKey(shopId: string, userId: string): string {
    return `${this.IAM_CACHE_PREFIX}${shopId}:${userId}`;
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

  /**
   * F01.5 & F01.6: Quản lý chuyển trạng thái ca trực (ONLINE / BUSY / OFFLINE) & Cưỡng chế thu hồi ca.
   * Nếu chuyển sang OFFLINE khi còn hội thoại WAITING_AGENT_REPLY mà chưa chọn phương thức bàn giao -> ném 403 SHIFT_HANDOVER_REQUIRED.
   */
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
    const member = await this.shopMemberRepo.findOne({
      where: { shopId: params.shopId, userId: params.userId },
    });
    if (!member) {
      throw new NotFoundException('SHOP_MEMBER_NOT_FOUND');
    }

    let reassignedCount = 0;

    if (params.targetStatus === ShiftStatusEnum.OFFLINE) {
      const pendingConversations = await this.conversationRepo.find({
        where: {
          shopId: params.shopId,
          assignedAgentId: params.userId,
          supportStatus: ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
        },
        select: ['id'],
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

    this.realtimeEmitter.emitToUser(
      SOCKET_CONFIG.namespaces.CHAT,
      params.userId,
      SOCKET_CONFIG.events.IAM.SHIFT_STATUS_CHANGED,
      {
        shopId: params.shopId,
        userId: params.userId,
        shiftStatus: member.shiftStatus,
        reassignedConversationCount: reassignedCount,
      },
    );

    if (params.forcedByManagerId) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        params.userId,
        SOCKET_CONFIG.events.IAM.FORCE_SHIFT_HANDOVER,
        {
          shopId: params.shopId,
          forcedByManagerId: params.forcedByManagerId,
          reassignedConversationCount: reassignedCount,
        },
      );
    }

    return {
      shiftStatus: member.shiftStatus,
      reassignedConversationCount: reassignedCount,
    };
  }

  /**
   * F01.7: Lưu danh sách Preset Gộp Trang Đa Kênh cá nhân của nhân viên (SavedPageGroupPreset[])
   */
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

  /**
   * F01.1: Lấy và cập nhật cấu hình vận hành cửa hàng (SLA, Auto-Reclaim, RoutingStrategy, CommissionSplit, MarketplaceSync)
   */
  async getWorkspaceSettings(shopId: string): Promise<ShopWorkspaceEntity> {
    const shop = await this.shopWorkspaceRepo.findOne({ where: { id: shopId } });
    if (!shop) {
      throw new NotFoundException('SHOP_WORKSPACE_NOT_FOUND');
    }
    return shop;
  }

  async updateWorkspaceSettings(
    shopId: string,
    dto: UpdateShopWorkspaceSettingsDto,
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
      shop.commissionSplitConfigJson = {
        leadCollectorWeight:
          dto.leadCollectorWeight ?? shop.commissionSplitConfigJson?.leadCollectorWeight ?? 0.4,
        orderCloserWeight:
          dto.orderCloserWeight ?? shop.commissionSplitConfigJson?.orderCloserWeight ?? 0.6,
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

    return saved;
  }
}
