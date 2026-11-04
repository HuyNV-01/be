import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  DataScopeEnum,
  MembershipStatusEnum,
  PermissionCodeEnum,
  ShiftStatusEnum,
  ShopRoleEnum,
} from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { ROLE_DEFAULT_PERMISSIONS_MAP } from 'src/constants/role-default-permissions.constant';
import { SavedPageGroupPreset, ShopMemberEntity } from 'src/entity/shop-member.entity';
import { Repository } from 'typeorm';

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
    @InjectRedis() private readonly redis: Redis,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private buildCacheKey(shopId: string, userId: string): string {
    return `${this.IAM_CACHE_PREFIX}${shopId}:${userId}`;
  }

  /**
   * Tính toán quyền hiệu lực O(1) của thành viên trong cửa hàng:
   * - Nếu chưa có bản ghi trong shop_members -> ném 403 USER_NOT_IN_SHOP_WORKSPACE.
   * - Nếu membershipStatus !== ACTIVE (VD: PENDING_APPROVAL hoặc SUSPENDED) -> permissions = [] (Quyền trống 100%!).
   */
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

    // Nếu tài khoản đang chờ phê duyệt (PENDING_APPROVAL) hoặc bị đình chỉ (SUSPENDED/TERMINATED) -> Quyền trống 100%
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
      'iam:permissions_updated',
      updatedContext,
    );

    return updatedContext;
  }
}
