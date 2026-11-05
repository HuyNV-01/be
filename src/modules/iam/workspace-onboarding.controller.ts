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
  RejectPendingMemberDto,
  TransferShopOwnershipDto,
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
  async getMyShopEffectiveContext(
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
      'Lấy danh sách nhân sự (ACTIVE, PENDING_APPROVAL, SUSPENDED) và danh sách lời mời của cửa hàng',
  })
  async getShopMembersAndInvitations(@Param('shopId') shopId: string): Promise<DBaseRes> {
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
      'Luồng 2 (F00.2 & F00.3): Chủ quán / Quản lý gửi lời mời nhân viên gán sẵn vai trò (Sale, Kế toán, Kho...)',
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

  @Patch('iam/shops/:shopId/invitations/:invitationId/revoke')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard, ShopPermissionGuard)
  @RequireShopPermissions(PermissionCodeEnum.IAM_MEMBER_INVITE_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Luồng 2 (F00.2): Thu hồi lời mời nhân sự đang ở trạng thái PENDING',
  })
  async revokeRoleInvitation(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
    @Param('invitationId') invitationId: string,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.revokeRoleInvitation(
      shopId,
      invitationId,
      req.user.id,
    );
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Revoked role invitation successfully',
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
      'Luồng 3 (F00.4): Chủ quán phê duyệt yêu cầu xin vào quán (PENDING_APPROVAL -> ACTIVE) & gán vai trò',
  })
  async approvePendingMember(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
    @Param('memberId') memberId: string,
    @Body() dto: ApprovePendingMemberDto,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.approvePendingMemberAndAssignRole(
      shopId,
      memberId,
      req.user.id,
      dto,
    );
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Approved pending member and provisioned role successfully',
      data,
    };
  }

  @Post('iam/shops/:shopId/members/:memberId/reject')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard, ShopPermissionGuard)
  @RequireShopPermissions(PermissionCodeEnum.IAM_MEMBER_INVITE_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Luồng 3 (F00.4): Chủ quán từ chối yêu cầu xin vào quán đang ở trạng thái PENDING_APPROVAL',
  })
  async rejectPendingMember(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
    @Param('memberId') memberId: string,
    @Body() dto: RejectPendingMemberDto,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.rejectPendingMemberRequest(
      shopId,
      memberId,
      req.user.id,
      dto?.reason,
    );
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Rejected pending member join request successfully',
      data,
    };
  }

  @Post('iam/shops/:shopId/regenerate-join-code')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard, ShopPermissionGuard)
  @RequireShopPermissions(PermissionCodeEnum.IAM_MEMBER_INVITE_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Luồng 3 (F00.4): Làm mới (Regenerate) Mã gia nhập cửa hàng joinCode khi nghi ngờ lộ mã',
  })
  async regenerateShopJoinCode(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.regenerateShopJoinCode(shopId, req.user.id);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Regenerated shop join code successfully',
      data,
    };
  }

  @Patch('iam/shops/:shopId/members/:memberId/permissions')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard, ShopPermissionGuard)
  @RequireShopPermissions(PermissionCodeEnum.IAM_MEMBER_INVITE_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Luồng 4 (F00.5): Đổi vai trò / tinh chỉnh 92 mã quyền chi tiết -> Đồng bộ Real-Time qua WebSocket < 50ms',
  })
  async updateMemberRoleAndPermissions(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberRoleAndPermissionsDto,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.updateMemberRoleAndPermissions(
      shopId,
      memberId,
      req.user.id,
      dto,
    );
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
      'Luồng 4 (F00.6): Tạm đình chỉ (SUSPENDED) / Cho nghỉ việc (TERMINATED) / Mở lại (ACTIVE) nhân sự',
  })
  async updateMemberStatus(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberStatusDto,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.updateMemberStatus(
      shopId,
      memberId,
      req.user.id,
      dto.membershipStatus,
    );
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Updated member status successfully',
      data,
    };
  }

  @Post('iam/shops/:shopId/transfer-ownership')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard, ShopPermissionGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Luồng 4 (F00.6): Chuyển nhượng quyền Chủ cửa hàng (SHOP_OWNER) sang một thành viên đang hoạt động khác',
  })
  async transferShopOwnership(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
    @Body() dto: TransferShopOwnershipDto,
  ): Promise<DBaseRes> {
    const data = await this.onboardingService.transferShopOwnership(
      shopId,
      req.user.id,
      dto.targetMemberId,
    );
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Transferred shop ownership successfully',
      data,
    };
  }
}
