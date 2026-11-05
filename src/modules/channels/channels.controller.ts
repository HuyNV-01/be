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
  ConnectChannelOAuthDto,
  MergedInboxQueryDto,
  UpdateChannelIntegrationDto,
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

@ApiTags('Sprint 1 — Omnichannel Integrations, Multi-Page Merge & Token Doctor')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ShopPermissionGuard)
@UseInterceptors(FieldLevelSecurityInterceptor)
@Controller('channels/:shopId')
export class ChannelsController {
  constructor(
    private readonly channelsService: ChannelsService,
    private readonly tokenDoctorService: ChannelTokenDoctorService,
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

  @Post('connect-oauth')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'F01.2: Kết nối mới hoặc làm mới OAuth2 Token cho Fanpage, Instagram, Zalo OA, TikTok Shop, Shopee, Lazada',
  })
  async connectChannelOAuth(
    @Param('shopId') shopId: string,
    @Body() dto: ConnectChannelOAuthDto,
  ): Promise<DBaseRes> {
    const data = await this.channelsService.connectOrUpdateChannelOAuth(shopId, dto);
    return {
      status: HttpStatus.CREATED,
      code: HttpStatus.CREATED,
      message: 'Connected channel integration and encrypted tokens successfully',
      data,
    };
  }

  @Patch(':channelId')
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_INTEGRATION_CONNECT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'F01.2: Cập nhật thông tin kênh tích hợp hoặc cấu hình Meta CAPI Dataset',
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
  async runTokenDoctorHealthCheck(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.tokenDoctorService.runShopChannelsHealthCheck(shopId);
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
}
