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

export const RequireShopPermissions = (
  ...permissions: PermissionCodeEnum[]
): CustomDecorator<string> => SetMetadata(SHOP_PERMISSIONS_KEY, permissions);

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

    const shopId: string | undefined =
      req.params?.shopId || req.headers?.['x-shop-id'] || req.body?.shopId || req.query?.shopId;

    if (!shopId) {
      throw new ForbiddenException({
        code: 'SHOP_WORKSPACE_HEADER_REQUIRED',
        message: 'Missing shopId in route params or x-shop-id header',
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

    const requiredPermissions =
      this.reflector.getAllAndOverride<PermissionCodeEnum[]>(SHOP_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) || [];

    if (requiredPermissions.length === 0 || memberCtx.role === ShopRoleEnum.SHOP_OWNER) {
      return true;
    }

    const hasAll = requiredPermissions.every((perm) => memberCtx.permissions.includes(perm));

    if (!hasAll) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_SHOP_PERMISSIONS',
        requiredPermissions,
      });
    }

    return true;
  }
}
