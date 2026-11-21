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
import { ChannelTypeEnum, PermissionCodeEnum } from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { DBaseRes } from 'src/dto/base-res.dto';
import {
  AdjustCustomerWalletOrPointsDto,
  BuildCarrierAddressPayloadDto,
  CustomerListQueryDto,
  EstimateMultiCarrierShippingFeeDto,
  ExportCustomersAuditDto,
  ExtractVietnameseNerDto,
  ImportPhoneTrustHistoryDto,
  LookupPhoneTrustFromSourcesDto,
  MergeCustomerProfilesDto,
  OverrideDeliveryTrustScoreDto,
  RecordOrderDeliveredLoyaltyDto,
  ReportCustomerPhoneAbuseDto,
  ResolveAdministrativeCrosswalkDto,
  RetractPhoneAbuseReportDto,
  SecurityAuditQueryDto,
  StandalonePhoneTrustLookupDto,
  SyncAdministrativeUnitsDto,
  ToggleCustomerBlacklistDto,
  TriggerAdsConversionEventDto,
  UnmaskCustomerPhoneDto,
  UpdateShopCrmConfigDto,
  UpsertCustomerProfileDto,
} from 'src/dto/crm/crm.dto';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { MessageEntity } from 'src/entity/message.entity';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { MessageCryptoService } from 'src/modules/chat/services/message-crypto.service';
import {
  RequireShopPermissions,
  ShopPermissionGuard,
} from 'src/modules/iam/guards/shop-permission.guard';
import { FieldLevelSecurityInterceptor } from 'src/modules/iam/interceptors/field-level-security.interceptor';
import { Repository } from 'typeorm';

import { AdsConversionSyncService } from './services/ads-conversion-sync.service';
import { Customer360Service } from './services/customer-360.service';
import { CustomerRfmAndLoyaltyService } from './services/customer-rfm-and-loyalty.service';
import { PhoneReputationSyncService } from './services/phone-reputation-sync.service';
import { PiiVaultAndAuditService } from './services/pii-vault-and-audit.service';
import { VietnameseCommerceNerService } from './services/vietnamese-commerce-ner.service';
import { VnAdministrativeAddressCarrierService } from './services/vn-administrative-address-carrier.service';

@ApiTags(
  'Sprint 3 & Sprint 3B — CRM 360°, Vietnamese Commerce NER (T05), 3-Tier/4-Tier Administrative & 3PL Carrier Hub, PII Vault & Meta CAPI',
)
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ShopPermissionGuard)
@UseInterceptors(FieldLevelSecurityInterceptor)
@Controller('crm')
export class CrmController {
  constructor(
    @InjectRepository(MessageEntity)
    private readonly messageRepo: Repository<MessageEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    private readonly nerService: VietnameseCommerceNerService,
    private readonly addressCarrierService: VnAdministrativeAddressCarrierService,
    private readonly customer360Service: Customer360Service,
    private readonly phoneReputationSyncService: PhoneReputationSyncService,
    private readonly piiVaultService: PiiVaultAndAuditService,
    private readonly adsConversionService: AdsConversionSyncService,
    private readonly rfmAndLoyaltyService: CustomerRfmAndLoyaltyService,
    private readonly messageCryptoService: MessageCryptoService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  @Get(':shopId/administrative-units')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'Công cụ T05: Lấy cây từ điển hành chính 3 cấp (34 Tỉnh/Thành - 3.321 Phường/Xã/Đặc khu mới) & 4 cấp toàn quốc (63 Tỉnh/Thành - 704 Quận/Huyện - 9.752+ Phường/Xã) ánh xạ GHN/GHTK/VTP/J&T',
  })
  getAdministrativeUnits(@Query('mode') mode?: 'ALL_63' | 'CURRENT_34'): DBaseRes {
    const resolvedMode = mode === 'CURRENT_34' ? 'CURRENT_34' : 'ALL_63';
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched Vietnamese 3-tier & 4-tier administrative dictionary successfully',
      data: this.nerService.getAdministrativeTree(resolvedMode),
    };
  }

  @Get(':shopId/administrative-units/stats')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'Sprint 3B (T05-Plus): Thống kê tổng quan & kiểm tra độ phủ ánh xạ vận chuyển 3PL (34 Tỉnh 3 Cấp mới & 63 Tỉnh 4 Cấp cũ)',
  })
  getAdministrativeCoverageStats(): DBaseRes {
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched administrative 3-tier & 4-tier coverage statistics successfully',
      data: this.addressCarrierService.getAdministrativeCoverageStats(),
    };
  }

  @Get(':shopId/administrative-units/search')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'Sprint 3B (T05-Plus): Tìm kiếm nhanh hợp nhất địa giới hành chính 3 cấp mới & 4 cấp cũ kèm mã vùng GHN/GHTK/VTP/J&T (< 3ms)',
  })
  searchAdministrativeUnitsFast(
    @Query('q') query?: string,
    @Query('mode') mode?: '3_TIER' | '4_TIER' | 'BOTH',
    @Query('provinceCode') provinceCode?: string,
    @Query('limit') limit?: number,
  ): DBaseRes {
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Searched administrative units across 3-tier and 4-tier trees successfully',
      data: this.addressCarrierService.searchAdministrativeUnitsFast({
        query: query || '',
        mode,
        provinceCode,
        limit: limit ? Number(limit) : 30,
      }),
    };
  }

  @Get(':shopId/administrative-units/hamlets')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'Công cụ T05: Lấy danh sách đầy đủ Thôn/Ấp/Bản/Khu phố/Tổ dân phố/KĐT (45-65+ ĐV/xã) tích hợp GHTK Level-4 Address API',
  })
  async getAdministrativeWardHamlets(
    @Query('wardCode') wardCode?: string,
    @Query('q') searchQuery?: string,
    @Query('ghtkToken') ghtkToken?: string,
  ): Promise<DBaseRes> {
    const data = await this.nerService.getHamletsForWard({
      wardCode,
      searchQuery,
      ghtkToken,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched fourth-tier hamlets for ward successfully',
      data,
    };
  }

  @Post(':shopId/administrative-units/crosswalk')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'Sprint 3B (T05-Plus): Ánh xạ chéo 2 chiều giữa Địa chỉ 3 Cấp Mới (34 Tỉnh - 3.321 Phường/Xã/Đặc khu) và 4 Cấp Cũ (63 Tỉnh - 704 Quận/Huyện) kèm mã GHN/GHTK/VTP/J&T',
  })
  resolveAdministrativeCrosswalk(@Body() dto: ResolveAdministrativeCrosswalkDto): DBaseRes {
    const data = this.addressCarrierService.resolveBidirectionalAddressCrosswalk(dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Resolved bidirectional 3-tier and 4-tier administrative crosswalk successfully',
      data,
    };
  }

  @Post(':shopId/administrative-units/carrier-payload')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'Sprint 3B (T05-Plus): Sinh Payload JSON chuẩn hóa để tạo vận đơn & tính phí cho 4 hãng vận chuyển (GHN, GHTK Level-4, ViettelPost, J&T Express)',
  })
  async buildCarrierAddressPayloads(
    @Param('shopId') shopId: string,
    @Body() dto: BuildCarrierAddressPayloadDto,
  ): Promise<DBaseRes> {
    const data = await this.addressCarrierService.buildMultiCarrierOrderPayloads(shopId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Built multi-carrier 3PL shipping payloads successfully',
      data,
    };
  }

  @Post(':shopId/administrative-units/estimate-shipping-fee')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'Sprint 3B (T05-Plus): Ước tính & so sánh phí vận chuyển đa hãng (GHN, GHTK Level-4, ViettelPost, J&T) từ địa chỉ 3 cấp mới hoặc 4 cấp cũ',
  })
  async estimateMultiCarrierShippingFee(
    @Param('shopId') shopId: string,
    @Body() dto: EstimateMultiCarrierShippingFeeDto,
  ): Promise<DBaseRes> {
    const data = await this.addressCarrierService.estimateMultiCarrierShippingFee(shopId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Estimated multi-carrier shipping fees successfully',
      data,
    };
  }

  @Post(':shopId/administrative-units/sync')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'Công cụ T05: Đối soát & đồng bộ trực tuyến địa giới hành chính đa nguồn (provinces.open-api.vn v1/v2, GHN, GHTK Level-4, ViettelPost)',
  })
  async syncAdministrativeUnitsFromMultiSources(
    @Body() body?: SyncAdministrativeUnitsDto,
  ): Promise<DBaseRes> {
    const report = await this.addressCarrierService.syncMultiSourceAdministrativeUnits(body || {});
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Synchronized multi-source Vietnamese administrative tree successfully',
      data: report,
    };
  }

  @Get(':shopId/settings/crm-config')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'Lấy cấu hình Nguồn dữ liệu Tra cứu Chỉ số Nhận/Hoàn/Bị báo cáo SĐT & Cấu hình Hồ sơ theo Ngành hàng',
  })
  async getShopCrmConfig(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.customer360Service.getShopCrmTrustAndIndustryConfig(shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched shop CRM trust lookup and industry config successfully',
      data,
    };
  }

  @Patch(':shopId/settings/crm-config')
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_PROFILE_EDIT)
  @ApiOperation({
    summary:
      'Cập nhật cấu hình Nguồn dữ liệu Tra cứu Chỉ số Nhận/Hoàn/Bị báo cáo SĐT (Pancake Community, 3PL GHN/GHTK, Custom API) & Ngành hàng',
  })
  async updateShopCrmConfig(
    @Param('shopId') shopId: string,
    @Body() dto: UpdateShopCrmConfigDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.updateShopCrmTrustAndIndustryConfig({
      shopId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Updated shop CRM trust lookup and industry config successfully',
      data,
    };
  }

  @Post('ner/extract')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F04.1 & Công cụ T05 (Direct Endpoint): Bóc tách SĐT chống lách luật & Địa chỉ 3 cấp / 4 cấp (< 3ms)',
  })
  async extractVietnameseCommerceNerDirect(
    @Body() dto: ExtractVietnameseNerDto,
    @Req() req: Request & { user?: { lastActiveShopId?: string } },
  ): Promise<DBaseRes> {
    const resolvedShopId =
      dto.shopId ||
      String(req.headers['x-shop-id'] || req.user?.lastActiveShopId || 'default_shop');
    return this.extractVietnameseCommerceNer(resolvedShopId, dto);
  }

  @Post(':shopId/ner/extract')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F04.1 & Công cụ T05: Bóc tách SĐT chống lách luật, tự động che SĐT, tra cứu chỉ số Nhận/Hoàn/Bị báo cáo & chuẩn hóa Địa chỉ 3 cấp / 4 cấp (< 3ms)',
  })
  async extractVietnameseCommerceNer(
    @Param('shopId') shopId: string,
    @Body() dto: ExtractVietnameseNerDto,
  ): Promise<DBaseRes> {
    const rawExtracted = this.nerService.extractCommerceEntities(dto.text);
    const maskedContent = this.nerService.maskPhonesInText(dto.text, rawExtracted.normalizedPhones);

    let phoneTrustSummary = rawExtracted.phoneTrustSummary || null;

    if (dto.conversationId) {
      const conv = await this.conversationRepo.findOne({
        where: { id: dto.conversationId },
      });
      if (conv) {
        const resolved = await this.customer360Service.resolveOrUpsertCustomerFromOmnichannelEvent({
          shopId: conv.shopId || shopId,
          conversation: conv,
          channelType: conv.channelType || ChannelTypeEnum.FACEBOOK_PAGE,
          channelIntegrationId: conv.channelIntegrationId,
          externalUserId: conv.externalThreadId || conv.id,
          customerName: conv.name || 'Khách hàng',
          customerAvatarUrl: conv.avatar,
          extractedNer: rawExtracted,
        });
        phoneTrustSummary = resolved.phoneTrustSummary;
      }
    }

    const publicSanitized = this.nerService.sanitizeExtractedEntitiesForPublicResponse(
      rawExtracted,
      phoneTrustSummary,
    );

    if (dto.messageId && dto.conversationId) {
      const msg = await this.messageRepo.findOne({
        where: { id: dto.messageId, conversationId: dto.conversationId },
      });
      if (msg) {
        const encryptedMasked = this.messageCryptoService.encryptForConversation(
          maskedContent,
          dto.conversationId,
        );
        await this.messageRepo.update(
          { id: msg.id, createdAt: msg.createdAt },
          {
            content: encryptedMasked.ciphertext,
            extractedEntitiesJson: publicSanitized as any,
          },
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
          maskedContent,
          extractedEntities: publicSanitized,
        },
      );
    }

    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Extracted Vietnamese commerce entities successfully',
      data: {
        ...publicSanitized,
        maskedContent,
      },
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

  @Post(':shopId/customers/export-audit')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_EXPORT_FILE)
  @ApiOperation({
    summary:
      'F04.4 & F04.6: Ghi nhật ký Chuỗi Băm Kiểm Toán khi xuất danh sách khách hàng (Masked PII Safe)',
  })
  async recordCustomerExportAudit(
    @Param('shopId') shopId: string,
    @Body() dto: ExportCustomersAuditDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.recordCustomerExportAudit({
      shopId,
      actorUserId: req.user?.id || 'system',
      dto,
      ipAddress: String(req.headers['x-forwarded-for'] || req.ip || '127.0.0.1'),
      userAgent: String(req.headers['user-agent'] || 'PancakeSellerOS-Browser'),
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Recorded customer export security audit log successfully',
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

  @Post(':shopId/customers/:customerId/lookup-trust')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F04.3: Tra cứu & đồng bộ lại chỉ số Nhận hàng, Hoàn hàng, Bị báo cáo từ nguồn dữ liệu Cộng đồng Pancake & ĐVVC 3PL (GHN/GHTK/VTP/J&T)',
  })
  async lookupCustomerTrustFromSources(
    @Param('shopId') shopId: string,
    @Param('customerId') customerId: string,
    @Body() dto: LookupPhoneTrustFromSourcesDto,
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.refreshCustomerTrustLookup({
      shopId,
      customerId,
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Refreshed customer delivery trust and report metrics from sources successfully',
      data,
    };
  }

  @Post(':shopId/customers/:customerId/report-abuse')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_BLACKLIST_TOGGLE)
  @ApiOperation({
    summary: 'F04.3: Báo xấu SĐT khách bom hàng / Ghi nhận lượt bị báo cáo và đồng bộ cảnh báo đỏ',
  })
  async reportCustomerPhoneAbuse(
    @Param('shopId') shopId: string,
    @Param('customerId') customerId: string,
    @Body() dto: ReportCustomerPhoneAbuseDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.reportCustomerPhoneAbuse({
      shopId,
      customerId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Reported customer phone abuse successfully',
      data,
    };
  }

  @Post(':shopId/trust/lookup-phone')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F04.3 (Nâng cấp Sprint 5): Tra cứu nhanh Uy tín SĐT độc lập trên đa nguồn (OMS Nội bộ + Cộng đồng HMAC + Pancake POS + 3PL + SuperAI/Webhook)',
  })
  async lookupStandalonePhoneTrust(
    @Param('shopId') shopId: string,
    @Body() dto: StandalonePhoneTrustLookupDto,
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.lookupStandalonePhoneTrust({
      shopId,
      rawPhone: dto.rawPhone,
      bypassCache: dto.bypassCache,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Looked up standalone phone delivery trust successfully',
      data,
    };
  }

  @Post(':shopId/trust/backfill')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_PROFILE_EDIT)
  @ApiOperation({
    summary:
      'F04.3 (Nâng cấp Sprint 5): Đồng bộ lại toàn bộ đơn hàng OMS & SĐT cũ của Shop vào Sổ cái Uy tín Cộng đồng (Backfill 1 chạm)',
  })
  async backfillShopPhoneTrustLedger(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.phoneReputationSyncService.backfillShopPhoneReputationLedger(shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Backfilled shop phone reputation ledger successfully',
      data,
    };
  }

  @Post(':shopId/trust/import-history')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_PROFILE_EDIT)
  @ApiOperation({
    summary:
      'F04.3 (Zero-Key): Nạp hàng loạt lịch sử đơn nhận/hoàn/báo xấu từ CSV/Excel đối soát 3PL hoặc danh sách bom hàng (không cần API Key)',
  })
  async importPhoneTrustHistory(
    @Param('shopId') shopId: string,
    @Body() dto: ImportPhoneTrustHistoryDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.phoneReputationSyncService.importPhoneTrustHistoryRows({
      shopId,
      actorUserId: req.user?.id || 'system',
      rows: dto.rows || [],
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Imported phone trust history into reputation ledger successfully',
      data,
    };
  }

  @Patch(':shopId/customers/:customerId/report-abuse/:reportId/retract')
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_BLACKLIST_TOGGLE)
  @ApiOperation({
    summary: 'F04.3: Thu hồi báo cáo xấu do cửa hàng tạo khi báo nhầm hoặc khách đã nhận hàng',
  })
  async retractPhoneAbuseReport(
    @Param('shopId') shopId: string,
    @Param('customerId') customerId: string,
    @Param('reportId') reportId: string,
    @Body() dto: RetractPhoneAbuseReportDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.retractCustomerPhoneAbuseReport({
      shopId,
      customerId,
      reportId,
      actorUserId: req.user?.id || 'system',
      reason: dto.reason,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Retracted phone abuse report successfully',
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
    const rawResult = await this.rfmAndLoyaltyService.adjustCustomerWalletOrPoints({
      shopId,
      customerId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    const crmConfig = await this.customer360Service.getShopCrmTrustAndIndustryConfig(shopId);
    const enrichedCustomer = this.customer360Service.enrichCustomerWithTrustEvaluation(
      rawResult.customer,
      crmConfig.requireDepositOnHighRisk,
      crmConfig,
    );
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Adjusted customer loyalty/wallet balance successfully',
      data: {
        customer: enrichedCustomer,
        ledgerEntry: rawResult.ledgerEntry,
      },
    };
  }

  @Post(':shopId/customers/:customerId/record-order-delivered')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_LOYALTY_WALLET_ADJUST)
  @ApiOperation({
    summary:
      'F11.4: Ghi nhận đơn hàng DELIVERED_RECONCILED, tự động cộng điểm thưởng (100.000đ = 10 điểm), nâng hạng thẻ & cập nhật RFM',
  })
  async recordOrderDeliveredLoyalty(
    @Param('shopId') shopId: string,
    @Param('customerId') customerId: string,
    @Body() dto: RecordOrderDeliveredLoyaltyDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const rawResult = await this.rfmAndLoyaltyService.recordOrderDeliveredAndAwardLoyaltyPoints({
      shopId,
      customerId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    const crmConfig = await this.customer360Service.getShopCrmTrustAndIndustryConfig(shopId);
    const enrichedCustomer = this.customer360Service.enrichCustomerWithTrustEvaluation(
      rawResult.customer,
      crmConfig.requireDepositOnHighRisk,
      crmConfig,
    );
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Recorded delivered order and awarded loyalty points successfully',
      data: {
        customer: enrichedCustomer,
        awardedPoints: rawResult.awardedPoints,
        ledgerEntries: rawResult.ledgerEntries,
      },
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
