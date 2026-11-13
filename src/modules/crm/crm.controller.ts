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
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';

import type { Request } from 'express';
import { PermissionCodeEnum } from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { DBaseRes } from 'src/dto/base-res.dto';
import {
  AdjustCustomerWalletOrPointsDto,
  CustomerListQueryDto,
  ExtractVietnameseNerDto,
  MergeCustomerProfilesDto,
  OverrideDeliveryTrustScoreDto,
  SecurityAuditQueryDto,
  ToggleCustomerBlacklistDto,
  TriggerAdsConversionEventDto,
  UnmaskCustomerPhoneDto,
  UpsertCustomerProfileDto,
} from 'src/dto/crm/crm.dto';
import { MessageEntity } from 'src/entity/message.entity';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import {
  RequireShopPermissions,
  ShopPermissionGuard,
} from 'src/modules/iam/guards/shop-permission.guard';
import { FieldLevelSecurityInterceptor } from 'src/modules/iam/interceptors/field-level-security.interceptor';
import { Repository } from 'typeorm';

import { AdsConversionSyncService } from './services/ads-conversion-sync.service';
import { Customer360Service } from './services/customer-360.service';
import { CustomerRfmAndLoyaltyService } from './services/customer-rfm-and-loyalty.service';
import { PiiVaultAndAuditService } from './services/pii-vault-and-audit.service';
import { VietnameseCommerceNerService } from './services/vietnamese-commerce-ner.service';

@ApiTags(
  'Sprint 3 — CRM 360°, Vietnamese Commerce NER (T05), PII Vault & Audit Chain (T06), Meta CAPI & RFM',
)
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ShopPermissionGuard)
@UseInterceptors(FieldLevelSecurityInterceptor)
@Controller('crm')
export class CrmController {
  constructor(
    @InjectRepository(MessageEntity)
    private readonly messageRepo: Repository<MessageEntity>,
    private readonly nerService: VietnameseCommerceNerService,
    private readonly customer360Service: Customer360Service,
    private readonly piiVaultService: PiiVaultAndAuditService,
    private readonly adsConversionService: AdsConversionSyncService,
    private readonly rfmAndLoyaltyService: CustomerRfmAndLoyaltyService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  @Get(':shopId/administrative-units')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'Công cụ T05: Lấy cây từ điển hành chính 3 cấp Tỉnh/Thành — Quận/Huyện — Phường/Xã có ánh xạ GHN/GHTK/VTP/J&T',
  })
  getAdministrativeUnits(): DBaseRes {
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched Vietnamese 3-tier administrative dictionary successfully',
      data: this.nerService.getAdministrativeTree(),
    };
  }

  @Post(':shopId/ner/extract')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F04.1 & Công cụ T05: Bóc tách SĐT chống lách luật, Địa chỉ 3 cấp, Mã SKU, Màu sắc, Kích cỡ (< 3ms)',
  })
  async extractVietnameseCommerceNer(
    @Param('shopId') shopId: string,
    @Body() dto: ExtractVietnameseNerDto,
  ): Promise<DBaseRes> {
    const extracted = this.nerService.extractCommerceEntities(dto.text);

    if (dto.messageId && dto.conversationId) {
      const msg = await this.messageRepo.findOne({
        where: { id: dto.messageId, conversationId: dto.conversationId },
      });
      if (msg) {
        await this.messageRepo.update(
          { id: msg.id, createdAt: msg.createdAt },
          { extractedEntitiesJson: extracted as any },
        );
      }

      this.realtimeEmitter.emitToConversation(
        SOCKET_CONFIG.namespaces.CHAT,
        dto.conversationId,
        SOCKET_CONFIG.events.OMNICHANNEL_INBOX.NER_ENTITIES_DETECTED,
        {
          shopId,
          conversationId: dto.conversationId,
          messageId: dto.messageId,
          extractedEntities: extracted,
        },
      );
    }

    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Extracted Vietnamese commerce entities successfully',
      data: extracted,
    };
  }

  @Get(':shopId/customers')
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_PROFILE_VIEW)
  @ApiOperation({
    summary:
      'F04.2: Danh sách Hồ sơ Khách hàng CRM 360° (Tìm kiếm tức thì qua chỉ mục mù phoneSearchHash)',
  })
  async listCustomers(
    @Param('shopId') shopId: string,
    @Query() query: CustomerListQueryDto,
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.listCustomers(shopId, query);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched CRM 360 customers successfully',
      data,
    };
  }

  @Get(':shopId/customers/by-conversation/:conversationId')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F04.2 & F04.5: Lấy Hồ sơ CRM 360° hợp nhất đa kênh của khách hàng trong cuộc hội thoại hiện tại',
  })
  async getCustomer360ByConversation(
    @Param('shopId') shopId: string,
    @Param('conversationId') conversationId: string,
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.getCustomer360ByConversationId(
      shopId,
      conversationId,
    );
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched conversation CRM 360 profile successfully',
      data,
    };
  }

  @Get(':shopId/customers/:customerId')
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_PROFILE_VIEW)
  @ApiOperation({
    summary:
      'F04.2: Xem chi tiết Hồ sơ Khách hàng CRM 360°, Điểm uy tín nhận hàng, Lịch sử đơn hàng & Sổ cái Ví',
  })
  async getCustomer360Detail(
    @Param('shopId') shopId: string,
    @Param('customerId') customerId: string,
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.getCustomer360ById(shopId, customerId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched CRM 360 profile detail successfully',
      data,
    };
  }

  @Post(':shopId/customers')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_PROFILE_EDIT)
  @ApiOperation({
    summary:
      'F04.2: Tạo mới hoặc cập nhật Hồ sơ Khách hàng CRM 360° (Tự động mã hóa SĐT vào PII Vault)',
  })
  async createCustomerProfile(
    @Param('shopId') shopId: string,
    @Body() dto: UpsertCustomerProfileDto,
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.upsertCustomerProfile(shopId, null, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Created customer profile successfully',
      data,
    };
  }

  @Patch(':shopId/customers/:customerId')
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_PROFILE_EDIT)
  @ApiOperation({
    summary: 'F04.2: Cập nhật thông tin Hồ sơ Khách hàng CRM 360°',
  })
  async updateCustomerProfile(
    @Param('shopId') shopId: string,
    @Param('customerId') customerId: string,
    @Body() dto: UpsertCustomerProfileDto,
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.upsertCustomerProfile(shopId, customerId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Updated customer profile successfully',
      data,
    };
  }

  @Post(':shopId/customers/:customerId/blacklist')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_BLACKLIST_TOGGLE)
  @ApiOperation({
    summary: 'F04.3: Đưa khách vào Danh sách đen (Bom hàng) hoặc gỡ khỏi Danh sách đen',
  })
  async toggleBlacklist(
    @Param('shopId') shopId: string,
    @Param('customerId') customerId: string,
    @Body() dto: ToggleCustomerBlacklistDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.toggleCustomerBlacklist({
      shopId,
      customerId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Updated customer blacklist status successfully',
      data,
    };
  }

  @Post(':shopId/customers/:customerId/trust-score-override')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_TRUST_SCORE_OVERRIDE)
  @ApiOperation({
    summary: 'F04.3: Ghi đè Điểm uy tín nhận hàng (Delivery Trust Score) có ghi nhật ký kiểm toán',
  })
  async overrideTrustScore(
    @Param('shopId') shopId: string,
    @Param('customerId') customerId: string,
    @Body() dto: OverrideDeliveryTrustScoreDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.overrideDeliveryTrustScore({
      shopId,
      customerId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Overrode customer delivery trust score successfully',
      data,
    };
  }

  @Post(':shopId/customers/merge')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_MERGE_DUPLICATE)
  @ApiOperation({
    summary: 'F04.2 & F04.5: Gộp 2 hồ sơ khách hàng trùng lặp về 1 hồ sơ chính duy nhất',
  })
  async mergeDuplicateProfiles(
    @Param('shopId') shopId: string,
    @Body() dto: MergeCustomerProfilesDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.mergeDuplicateCustomerProfiles({
      shopId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Merged duplicate customer profiles successfully',
      data,
    };
  }

  @Post(':shopId/customers/:customerId/unmask-phone')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_PHONE_UNMASK)
  @ApiOperation({
    summary:
      'F04.4 & Công cụ T06: Mở khóa SĐT thật trong 15 giây có kiểm soát hạn ngạch Redis và ghi chuỗi băm kiểm toán',
  })
  async unmaskCustomerPhone(
    @Param('shopId') shopId: string,
    @Param('customerId') customerId: string,
    @Body() dto: UnmaskCustomerPhoneDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.piiVaultService.unmaskCustomerPhoneFor15Seconds({
      shopId,
      customerId,
      actorUserId: req.user?.id || 'system',
      reason: dto.reason,
      conversationId: dto.conversationId,
      ipAddress: String(req.headers['x-forwarded-for'] || req.ip || '127.0.0.1'),
      userAgent: String(req.headers['user-agent'] || 'PancakeSellerOS-Browser'),
    });

    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Unmasked customer phone for 15 seconds successfully',
      data,
    };
  }

  @Post(':shopId/customers/:customerId/wallet-adjust')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_LOYALTY_WALLET_ADJUST)
  @ApiOperation({
    summary: 'F11.4: Cộng/Trừ Điểm thưởng thành viên hoặc Ví tiền thừa khách hàng kèm lưu Sổ cái',
  })
  async adjustWalletOrPoints(
    @Param('shopId') shopId: string,
    @Param('customerId') customerId: string,
    @Body() dto: AdjustCustomerWalletOrPointsDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.rfmAndLoyaltyService.adjustCustomerWalletOrPoints({
      shopId,
      customerId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Adjusted customer loyalty/wallet balance successfully',
      data,
    };
  }

  @Get(':shopId/rfm-segments')
  @RequireShopPermissions(PermissionCodeEnum.CRM_RFM_SEGMENT_VIEW)
  @ApiOperation({
    summary:
      'F11.3: Thống kê 8 phân khúc khách hàng theo ma trận RFM (Recency - Frequency - Monetary)',
  })
  async getRfmSegments(@Param('shopId') shopId: string): Promise<DBaseRes> {
    await this.customer360Service.listCustomers(shopId, { page: 1, limit: 5 });
    const data = await this.rfmAndLoyaltyService.getRfmSegmentsOverview(shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched RFM segments overview successfully',
      data,
    };
  }

  @Post(':shopId/rfm-segments/recalculate')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_RFM_SEGMENT_CONFIGURE)
  @ApiOperation({
    summary:
      'F11.3: Tính toán lại tức thì điểm R-F-M và hạng thẻ thành viên cho toàn bộ khách hàng',
  })
  async recalculateRfmSegments(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.rfmAndLoyaltyService.recalculateShopRfmSegments(shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Recalculated RFM segments successfully',
      data,
    };
  }

  @Get(':shopId/ads-conversions')
  @RequireShopPermissions(PermissionCodeEnum.ADS_ATTRIBUTION_REPORT_VIEW)
  @ApiOperation({
    summary:
      'F11.1, F11.2 & Công cụ T06: Lịch sử đồng bộ sự kiện chuyển đổi quảng cáo Meta CAPI & TikTok Events API',
  })
  async listAdsConversions(
    @Param('shopId') shopId: string,
    @Query('conversationId') conversationId?: string,
  ): Promise<DBaseRes> {
    const data = await this.adsConversionService.listConversionEventLogs(shopId, conversationId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched Ads CAPI conversion logs successfully',
      data,
    };
  }

  @Post(':shopId/ads-conversions/dispatch')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.ADS_CAPI_CONFIG_MANAGE)
  @ApiOperation({
    summary:
      'F11.1 & Công cụ T06: Bắn sự kiện chuyển đổi (LeadSubmitted / InitiateCheckout / Purchase) lên Meta CAPI',
  })
  async dispatchAdsConversion(
    @Param('shopId') shopId: string,
    @Body() dto: TriggerAdsConversionEventDto,
  ): Promise<DBaseRes> {
    const data = await this.adsConversionService.dispatchConversionEvent(shopId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Dispatched Ads Conversion event successfully',
      data,
    };
  }

  @Post(':shopId/ads-conversions/:logId/retry')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.ADS_CAPI_CONFIG_MANAGE)
  @ApiOperation({
    summary: 'Công cụ T06: Thử gửi lại một sự kiện chuyển đổi Meta CAPI',
  })
  async retryAdsConversion(
    @Param('shopId') shopId: string,
    @Param('logId') logId: string,
  ): Promise<DBaseRes> {
    const data = await this.adsConversionService.retryConversionEventLog(shopId, logId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Retried Ads Conversion event successfully',
      data,
    };
  }

  @Get(':shopId/security-audit')
  @RequireShopPermissions(PermissionCodeEnum.IAM_SECURITY_AUDIT_VIEW)
  @ApiOperation({
    summary: 'F04.4, F04.6 & Công cụ T06: Truy vấn Sổ cái Kiểm toán Bảo mật phân vùng theo tháng',
  })
  async listSecurityAuditLogs(
    @Param('shopId') shopId: string,
    @Query() query: SecurityAuditQueryDto,
  ): Promise<DBaseRes> {
    const data = await this.piiVaultService.listSecurityAuditLogs(shopId, query);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched security audit logs successfully',
      data,
    };
  }

  @Get(':shopId/security-audit/verify-chain')
  @RequireShopPermissions(PermissionCodeEnum.IAM_SECURITY_AUDIT_VIEW)
  @ApiOperation({
    summary:
      'F04.6 & Công cụ T06: Xác minh tính toàn vẹn 100% của Chuỗi Băm Kiểm Toán HMAC-SHA256 chống chỉnh sửa DB',
  })
  async verifyAuditHashChain(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.piiVaultService.verifyShopAuditHashChain(shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Verified security audit HMAC hash chain successfully',
      data,
    };
  }
}
