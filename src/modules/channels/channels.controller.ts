import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PermissionCodeEnum } from 'src/common/enum/permission.enum';
import { DBaseRes } from 'src/dto/base-res.dto';
import {
  BatchConnectChannelsDto,
  ConnectChannelOAuthDto,
  CreateSaasAppProfileDto,
  MergedInboxQueryDto,
  ResolveChannelTokenMetadataDto,
  UpdateChannelIntegrationDto,
  UpdateSaasAppProfileDto,
  WebhookLogQueryDto,
} from 'src/dto/channels/channels.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import {
  RequireShopPermissions,
  ShopPermissionGuard,
} from 'src/modules/iam/guards/shop-permission.guard';
import { EffectiveMemberContext } from 'src/modules/iam/iam.service';
import { FieldLevelSecurityInterceptor } from 'src/modules/iam/interceptors/field-level-security.interceptor';

import { ChannelsService } from './channels.service';
import { ChannelTokenDoctorService } from './services/channel-token-doctor.service';
import { MarketplaceBridgeService } from './services/marketplace-bridge.service';

@ApiTags('Sprint 1 — Omnichannel Integrations, Multi-Profile SaaS Config & Token Doctor')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ShopPermissionGuard)
@UseInterceptors(FieldLevelSecurityInterceptor)
@Controller('channels/:shopId')
export class ChannelsController {
  constructor(
    private readonly channelsService: ChannelsService,
    private readonly tokenDoctorService: ChannelTokenDoctorService,
    private readonly marketplaceBridgeService: MarketplaceBridgeService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F01.2 & F01.7: Lấy danh sách kênh bán hàng đã kết nối của cửa hàng (Facebook, Zalo OA, TikTok Shop, Shopee...)',
  })
  async listShopChannels(
    @Param('shopId') shopId: string,
    @Request() req: { shopMemberContext: EffectiveMemberContext },
  ): Promise<DBaseRes> {
    const data = await this.channelsService.listShopChannels(shopId, req.shopMemberContext);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched shop channel integrations successfully',
      data,
    };
  }

  @Get('saas-webhook-config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F01.2: Lấy thông tin cấu hình SaaS Webhook chuẩn (Callback URL, Verify Token, Subscribed Fields) và danh sách Hồ sơ SaaS của shop',
  })
  async getSaasWebhookConfiguration(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.channelsService.getSaasWebhookConfiguration(shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched SaaS webhook configuration successfully',
      data,
    };
  }

  @Get('saas-profiles')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F01.2: Lấy danh sách toàn bộ Hồ sơ Cấu hình Ứng dụng SaaS (Multi-Profile SaaS App Configurations) của cửa hàng',
  })
  async listSaasAppProfiles(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.channelsService.listSaasAppProfiles(shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched SaaS app profiles successfully',
      data,
    };
  }

  @Post('saas-profiles')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'F01.2: Tạo mới Hồ sơ Cấu hình Ứng dụng SaaS (Hỗ trợ nhiều cấu hình SaaS trên cùng 1 nền tảng & tự động đăng ký App Webhook)',
  })
  async createSaasAppProfile(
    @Param('shopId') shopId: string,
    @Body() dto: CreateSaasAppProfileDto,
  ): Promise<DBaseRes> {
    const data = await this.channelsService.createSaasAppProfile(shopId, dto);
    return {
      status: HttpStatus.CREATED,
      code: HttpStatus.CREATED,
      message: 'Created SaaS app profile and registered webhook subscription successfully',
      data,
    };
  }

  @Patch('saas-profiles/:profileId')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F01.2: Cập nhật Hồ sơ Cấu hình Ứng dụng SaaS và tự động đồng bộ xuống các kênh đang liên kết',
  })
  async updateSaasAppProfile(
    @Param('shopId') shopId: string,
    @Param('profileId') profileId: string,
    @Body() dto: UpdateSaasAppProfileDto,
  ): Promise<DBaseRes> {
    const data = await this.channelsService.updateSaasAppProfile(shopId, profileId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Updated SaaS app profile successfully',
      data,
    };
  }

  @Delete('saas-profiles/:profileId')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'F01.2: Xóa Hồ sơ Cấu hình Ứng dụng SaaS',
  })
  async deleteSaasAppProfile(
    @Param('shopId') shopId: string,
    @Param('profileId') profileId: string,
  ): Promise<DBaseRes> {
    const data = await this.channelsService.deleteSaasAppProfile(shopId, profileId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Deleted SaaS app profile successfully',
      data,
    };
  }

  @Post('saas-profiles/:profileId/inject-all-webhooks')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F01.2: Tự động tiêm và xác minh lại Webhook (subscribed_apps) cho toàn bộ kênh đang dùng Hồ sơ SaaS này',
  })
  async injectWebhooksForSaasProfile(
    @Param('shopId') shopId: string,
    @Param('profileId') profileId: string,
  ): Promise<DBaseRes> {
    const data = await this.channelsService.injectWebhooksForSaasProfile(shopId, profileId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Auto-injected webhooks for all bound channels successfully',
      data,
    };
  }

  @Post('resolve-token-metadata')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F01.2: Tự động tra cứu chính xác Tên Trang, Avatar, Page ID, phân biệt Page Token vs User Token chỉ với Access Token (Tự động kế thừa Hồ sơ SaaS)',
  })
  async resolveChannelTokenMetadata(
    @Param('shopId') shopId: string,
    @Body() dto: ResolveChannelTokenMetadataDto,
  ): Promise<DBaseRes> {
    const data = await this.channelsService.resolveChannelMetadataFromToken(shopId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Resolved channel profile metadata from access token successfully',
      data,
    };
  }

  @Post('connect-oauth')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'F01.2: Kết nối mới hoặc làm mới OAuth2 Token cho Fanpage, Instagram, Zalo OA, TikTok Shop, Shopee, Lazada và tự động tiêm Webhook',
  })
  async connectChannelOAuth(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
    @Body() dto: ConnectChannelOAuthDto,
  ): Promise<DBaseRes> {
    const data = await this.channelsService.connectOrUpdateChannelOAuth(shopId, dto, req.user?.id);
    return {
      status: HttpStatus.CREATED,
      code: HttpStatus.CREATED,
      message: 'Connected channel integration and auto-injected webhook successfully',
      data,
    };
  }

  @Post('connect-batch')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'F01.2: Kết nối hàng loạt nhiều Fanpage / Instagram cùng lúc từ danh sách trang của User Access Token và tự động tiêm Webhook cho từng trang',
  })
  async batchConnectChannels(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
    @Body() dto: BatchConnectChannelsDto,
  ): Promise<DBaseRes> {
    const data = await this.channelsService.batchConnectChannels(shopId, dto, req.user?.id);
    return {
      status: HttpStatus.CREATED,
      code: HttpStatus.CREATED,
      message: 'Batch connected channel integrations and auto-injected webhooks successfully',
      data,
    };
  }

  @Post(':channelId/sync-webhook')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F01.2: Đồng bộ lại đăng ký Webhook (subscribed_apps) trên nền tảng và kiểm tra trạng thái nhận sự kiện thực tế',
  })
  async syncAndVerifyChannelWebhook(
    @Param('shopId') shopId: string,
    @Param('channelId') channelId: string,
  ): Promise<DBaseRes> {
    const data = await this.channelsService.syncAndVerifyChannelWebhook(shopId, channelId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Synced and verified channel webhook subscription successfully',
      data,
    };
  }

  @Patch(':channelId')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F01.2: Cập nhật thông tin kênh tích hợp, chuyển đổi Hồ sơ SaaS hoặc cấu hình Meta CAPI Dataset',
  })
  async updateChannelIntegration(
    @Param('shopId') shopId: string,
    @Param('channelId') channelId: string,
    @Body() dto: UpdateChannelIntegrationDto,
  ): Promise<DBaseRes> {
    const data = await this.channelsService.updateChannelIntegration(shopId, channelId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Updated channel integration successfully',
      data,
    };
  }

  @Delete(':channelId')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'F01.2: Ngắt kết nối kênh bán hàng khỏi cửa hàng',
  })
  async removeChannelIntegration(
    @Param('shopId') shopId: string,
    @Param('channelId') channelId: string,
  ): Promise<DBaseRes> {
    const data = await this.channelsService.removeChannelIntegration(shopId, channelId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Removed channel integration successfully',
      data,
    };
  }

  @Post('token-doctor/inspect')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Công cụ T02 (ChannelTokenDoctor): Chẩn đoán sức khỏe Token & tự động gia hạn OAuth2 cho toàn bộ kênh của shop',
  })
  async runTokenDoctorHealthCheck(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
  ): Promise<DBaseRes> {
    const data = await this.tokenDoctorService.runShopChannelsHealthCheck(shopId, req.user?.id);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Executed ChannelTokenDoctor health check successfully',
      data,
    };
  }

  @Get('webhook-logs')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_WEBHOOK_INSPECT_REPLAY)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Công cụ T01 (OmnibusWebhookInspector): Tra cứu lịch sử sự kiện Webhook đa kênh & Dead-Letter Queue',
  })
  async getWebhookLogs(
    @Param('shopId') shopId: string,
    @Query() query: WebhookLogQueryDto,
  ): Promise<DBaseRes> {
    const data = await this.channelsService.getWebhookLogs(shopId, query);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched channel webhook logs successfully',
      data,
    };
  }

  @Get('merged-conversations')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_MULTI_PAGE_MERGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F01.7: Lấy danh sách hội thoại trong Chế độ Gộp Trang Đa Kênh (Multi-Page Unified Merge Mode)',
  })
  async getMergedInboxConversations(
    @Param('shopId') shopId: string,
    @Request() req: { shopMemberContext: EffectiveMemberContext },
    @Query() query: MergedInboxQueryDto,
  ): Promise<DBaseRes> {
    const data = await this.channelsService.getMergedInboxConversations(
      shopId,
      req.shopMemberContext,
      query,
    );
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched merged omnichannel conversations successfully',
      data,
    };
  }

  @Get('marketplace-reservations')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_MARKETPLACE_SYNC_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F01.8: Lấy danh sách đơn hàng sàn TMĐT (Shopee / TikTok Shop / Lazada) đã đồng bộ và giữ chỗ tồn kho',
  })
  async getMarketplaceReservations(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.marketplaceBridgeService.getMarketplaceStockReservations(shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched marketplace stock reservations successfully',
      data,
    };
  }
}
