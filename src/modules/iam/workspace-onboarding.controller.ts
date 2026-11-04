import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PermissionCodeEnum } from 'src/common/enum/permission.enum';
import { ROLE_PRESET_TEMPLATES } from 'src/constants/role-default-permissions.constant';
import { DBaseRes } from 'src/dto/base-res.dto';
import {
  ApprovePendingMemberDto,
  CreateRoleInvitationDto,
  CreateShopWorkspaceDto,
  JoinShopByCodeDto,
  UpdateMemberRoleAndPermissionsDto,
  UpdateMemberStatusDto,
} from 'src/dto/onboarding/onboarding.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';

import { RequireShopPermissions, ShopPermissionGuard } from './guards/shop-permission.guard';
import { GranularIamService } from './iam.service';
import { WorkspaceOnboardingService } from './services/workspace-onboarding.service';

@ApiTags('Sprint 0 — Onboarding, Shop Provisioning & Role Assignment')
@Controller()
export class WorkspaceOnboardingController {
  constructor(
    private readonly onboardingService: WorkspaceOnboardingService,
    private readonly granularIamService: GranularIamService,
  ) {}

  @Get('onboarding/invitations/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Kiểm tra thông tin lời mời công khai qua inviteToken trước khi đăng ký',
  })
  async verifyInviteTokenPublic(@Query('token') token: string): Promise<DBaseRes> {
    const data = await this.onboardingService.verifyInvitationTokenPublic(token || '');
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Verified invitation token successfully',
      data,
    };
  }

  @Get('onboarding/overview')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Lấy trạng thái tài khoản (UNBOUND_USER / PENDING_APPROVAL / HAS_ACTIVE_SHOPS), danh sách cửa hàng & lời mời',
  })
  async getOnboardingOverview(
    @Request() req: { user: { id: string; email: string } },
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.getUserOnboardingOverview(
      req.user.id,
      req.user.email,
    );
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched onboarding overview successfully',
      data,
    };
  }

  @Get('onboarding/role-presets')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Lấy danh sách 7 vai trò chuẩn (Chủ quán, Quản lý, Sale, Kho, Kế toán, Marketing) và bộ quyền mặc định',
  })
  getRolePresets(): DBaseRes {
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched role presets successfully',
      data: ROLE_PRESET_TEMPLATES,
    };
  }

  @Post('onboarding/shops')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Luồng 1 (F00.1): Tạo cửa hàng mới -> Tự động cấp quyền Chủ quán (SHOP_OWNER) + Seed Kho & Tag mẫu',
  })
  async createShopAndProvisionOwner(
    @Request() req: { user: { id: string } },
    @Body() dto: CreateShopWorkspaceDto,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.createShopAndProvisionOwner(req.user.id, dto);
    return {
      status: HttpStatus.CREATED,
      code: HttpStatus.CREATED,
      message: 'Created shop workspace and provisioned SHOP_OWNER successfully',
      data,
    };
  }

  @Post('onboarding/join-by-code')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Luồng 3 (F00.4): Nhân viên nhập mã cửa hàng (joinCode) xin vào -> Trạng thái PENDING_APPROVAL (Quyền trống [])',
  })
  async requestJoinByCode(
    @Request() req: { user: { id: string } },
    @Body() dto: JoinShopByCodeDto,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.requestJoinShopByCode(req.user.id, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Join request submitted and waiting for shop owner approval',
      data,
    };
  }

  @Post('onboarding/invitations/:idOrToken/accept')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Luồng 2 (F00.2): Chấp nhận lời mời của Chủ quán -> Kích hoạt ngay vai trò (Sale, Kế toán, Kho...)',
  })
  async acceptInvitation(
    @Request() req: { user: { id: string; email: string } },
    @Param('idOrToken') idOrToken: string,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.acceptRoleInvitation({
      userId: req.user.id,
      userEmail: req.user.email,
      invitationIdOrRawToken: idOrToken,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Accepted shop invitation and activated role successfully',
      data,
    };
  }

  @Post('onboarding/switch-shop/:shopId')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Luồng 4 (F00.7): Chuyển đổi cửa hàng đang làm việc (Multi-Shop Context Switcher)',
  })
  async switchActiveShop(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.switchActiveShop(req.user.id, shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Switched active shop workspace successfully',
      data,
    };
  }

  @Get('iam/shops/:shopId/me-context')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lấy ngữ cảnh quyền 4 chiều hiệu lực của user hiện tại tại cửa hàng shopId',
  })
  async getMyShopContext(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
  ): Promise<DBaseRes> {
    const data = await this.granularIamService.getEffectiveMemberContext(shopId, req.user.id);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched effective member context successfully',
      data,
    };
  }

  @Get('iam/shops/:shopId/members')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard, ShopPermissionGuard)
  @RequireShopPermissions(PermissionCodeEnum.IAM_MEMBER_INVITE_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Lấy danh sách thành viên (ACTIVE, PENDING_APPROVAL, SUSPENDED) và lời mời của cửa hàng',
  })
  async getShopMembers(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.onboardingService.getShopMembersAndInvitations(shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched shop members and invitations successfully',
      data,
    };
  }

  @Post('iam/shops/:shopId/invitations')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard, ShopPermissionGuard)
  @RequireShopPermissions(PermissionCodeEnum.IAM_MEMBER_INVITE_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Chủ quán / Quản lý gửi lời mời nhân viên mới gán sẵn vai trò (Sale, Kế toán, Kho, Marketing...)',
  })
  async createRoleInvitation(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
    @Body() dto: CreateRoleInvitationDto,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.createRoleInvitation(shopId, req.user.id, dto);
    return {
      status: HttpStatus.CREATED,
      code: HttpStatus.CREATED,
      message: 'Created role invitation successfully',
      data,
    };
  }

  @Post('iam/shops/:shopId/members/:memberId/approve')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard, ShopPermissionGuard)
  @RequireShopPermissions(PermissionCodeEnum.IAM_MEMBER_INVITE_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Chủ quán / Quản lý phê duyệt yêu cầu xin vào quán (PENDING_APPROVAL) & Gán vai trò chính thức',
  })
  async approvePendingMember(
    @Param('shopId') shopId: string,
    @Param('memberId') memberId: string,
    @Body() dto: ApprovePendingMemberDto,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.approvePendingMemberAndAssignRole(
      shopId,
      memberId,
      dto,
    );
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Approved member and assigned role successfully',
      data,
    };
  }

  @Patch('iam/shops/:shopId/members/:memberId/permissions')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard, ShopPermissionGuard)
  @RequireShopPermissions(PermissionCodeEnum.IAM_ROLE_MATRIX_CONFIGURE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cập nhật vai trò, phạm vi dữ liệu (DataScope), trần giảm giá và tinh chỉnh 92 mã quyền của nhân viên',
  })
  async updateMemberPermissions(
    @Param('shopId') shopId: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberRoleAndPermissionsDto,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.updateMemberRoleAndPermissions(shopId, memberId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Updated member role and permissions successfully',
      data,
    };
  }

  @Patch('iam/shops/:shopId/members/:memberId/status')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard, ShopPermissionGuard)
  @RequireShopPermissions(PermissionCodeEnum.IAM_MEMBER_INVITE_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Đình chỉ / Khóa quyền nhân viên nghỉ việc (SUSPENDED / TERMINATED) hoặc khôi phục (ACTIVE)',
  })
  async updateMemberStatus(
    @Param('shopId') shopId: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberStatusDto,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.updateMemberStatus(
      shopId,
      memberId,
      dto.membershipStatus,
    );
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Updated member status successfully',
      data,
    };
  }
}
