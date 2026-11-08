import {
  CanActivate,
  CustomDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  MembershipStatusEnum,
  PermissionCodeEnum,
  ShopRoleEnum,
} from 'src/common/enum/permission.enum';

import { GranularIamService } from '../iam.service';

export const SHOP_PERMISSIONS_KEY = 'shop_permissions_required';
export const SHOP_ANY_PERMISSIONS_KEY = 'shop_any_permissions_required';

export const RequireShopPermissions = (
  ...permissions: PermissionCodeEnum[]
): CustomDecorator<string> => SetMetadata(SHOP_PERMISSIONS_KEY, permissions);

export const RequireAnyShopPermissions = (
  ...permissions: PermissionCodeEnum[]
): CustomDecorator<string> => SetMetadata(SHOP_ANY_PERMISSIONS_KEY, permissions);

@Injectable()
export class ShopPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly granularIamService: GranularIamService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('AUTHENTICATION_REQUIRED');
    }

    let shopId: string | undefined | null =
      req.params?.shopId || req.headers?.['x-shop-id'] || req.body?.shopId || req.query?.shopId;

    // Tự động suy diễn shopId từ conversationId trên các route /chat/conversations/:id/* hoặc /chat/translate
    if (!shopId) {
      const candidateConvId: string | undefined =
        req.params?.conversationId || req.params?.id || req.body?.conversationId;
      if (candidateConvId) {
        shopId = await this.granularIamService.resolveShopIdFromConversation(
          String(candidateConvId),
        );
      }
    }

    // Nếu không truyền shopId trên route không gắn với hội thoại cửa hàng, thử lấy từ lastActiveShopId
    if (!shopId && req.user?.lastActiveShopId) {
      shopId = String(req.user.lastActiveShopId);
    }

    // Nếu là hội thoại cá nhân thuần túy (conv.shopId === null) và không có shopId, nhường kiểm tra thành viên cho ChatService.ensureParticipant
    if (!shopId) {
      const hasConvTarget = Boolean(
        req.params?.conversationId || req.params?.id || req.body?.conversationId,
      );
      if (hasConvTarget) {
        return true;
      }
      throw new ForbiddenException({
        code: 'SHOP_WORKSPACE_HEADER_REQUIRED',
        message: 'Missing shopId in route params, body, or x-shop-id header',
      });
    }

    const memberCtx = await this.granularIamService.getEffectiveMemberContext(
      String(shopId),
      userId,
    );

    if (memberCtx.membershipStatus !== MembershipStatusEnum.ACTIVE) {
      throw new ForbiddenException({
        code: 'MEMBERSHIP_NOT_ACTIVE',
        membershipStatus: memberCtx.membershipStatus,
        message:
          'Your shop membership is pending approval or suspended. Permissions are currently empty.',
      });
    }

    req.shopMemberContext = memberCtx;

    if (memberCtx.role === ShopRoleEnum.SHOP_OWNER) {
      return true;
    }

    const requiredAllPermissions =
      this.reflector.getAllAndOverride<PermissionCodeEnum[]>(SHOP_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) || [];

    const requiredAnyPermissions =
      this.reflector.getAllAndOverride<PermissionCodeEnum[]>(SHOP_ANY_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) || [];

    if (requiredAllPermissions.length > 0) {
      const hasAll = requiredAllPermissions.every((perm) => memberCtx.permissions.includes(perm));
      if (!hasAll) {
        throw new ForbiddenException({
          code: 'INSUFFICIENT_SHOP_PERMISSIONS',
          requiredPermissions: requiredAllPermissions,
        });
      }
    }

    if (requiredAnyPermissions.length > 0) {
      const hasAny = requiredAnyPermissions.some((perm) => memberCtx.permissions.includes(perm));
      if (!hasAny) {
        throw new ForbiddenException({
          code: 'INSUFFICIENT_SHOP_PERMISSIONS',
          requiredPermissions: requiredAnyPermissions,
        });
      }
    }

    return true;
  }
}
