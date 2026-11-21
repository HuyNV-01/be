import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';

import { Request } from 'express';
import { PermissionCodeEnum } from 'src/common/enum';
import { envs } from 'src/config/envs/envs';
import { DBaseRes } from 'src/dto/base-res.dto';
import {
  ImportPhoneTrustHistoryDto,
  RetractPhoneAbuseReportDto,
  StandalonePhoneTrustLookupDto,
  SubmitStandalonePhoneAbuseReportDto,
} from 'src/dto/crm/phone-trust.dto';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import {
  RequireShopPermissions,
  ShopPermissionGuard,
} from 'src/modules/iam/guards/shop-permission.guard';
import { Repository } from 'typeorm';

import { Customer360Service } from '../services/customer-360.service';
import { DeliveryTrustScoreService } from '../services/delivery-trust-score.service';
import { PhoneTrustBlindIndexService } from '../services/phone-trust-blind-index.service';
import { PhoneTrustLedgerService } from '../services/phone-trust-ledger.service';
import { PiiVaultAndAuditService } from '../services/pii-vault-and-audit.service';

@ApiTags('CRM Phone Trust Network (Production Real-Data)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ShopPermissionGuard)
@Controller('crm')
export class PhoneTrustController {
  constructor(
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    private readonly customer360Service: Customer360Service,
    private readonly trustScoreService: DeliveryTrustScoreService,
    private readonly ledgerService: PhoneTrustLedgerService,
    private readonly blindIndexService: PhoneTrustBlindIndexService,
    private readonly piiVaultService: PiiVaultAndAuditService,
  ) {}

  @Post(':shopId/trust/lookup-phone')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'Tra cứu độc lập chỉ số nhận/hoàn/báo xấu thực tế của bất kỳ SĐT nào (Nội bộ + Liên shop + Platform Partner Gateway + POS/3PL)',
  })
  async lookupStandalonePhoneTrust(
    @Param('shopId') shopId: string,
    @Body() dto: StandalonePhoneTrustLookupDto,
  ): Promise<DBaseRes> {
    const data = await this.customer360Service.lookupStandalonePhoneTrust({
      shopId,
      rawPhone: dto.rawPhone,
      bypassCache: Boolean(dto.bypassCache),
    });

    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Looked up real phone trust metrics successfully',
      data,
    };
  }

  @Post(':shopId/trust/report-phone')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_BLACKLIST_TOGGLE)
  @ApiOperation({
    summary:
      'Gửi báo xấu độc lập theo SĐT (tự động chống trùng lặp & xác minh mã vận đơn trực tiếp với GHN/GHTK nếu có)',
  })
  async submitStandalonePhoneAbuseReport(
    @Param('shopId') shopId: string,
    @Body() dto: SubmitStandalonePhoneAbuseReportDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const actorUserId = req.user?.id || 'system';
    const { report, phoneMasked } = await this.ledgerService.submitAbuseReport({
      shopId,
      actorUserId,
      rawPhone: dto.rawPhone,
      reasonCode: dto.reasonCode,
      reasonNote: dto.reasonNote,
      carrierCode: dto.carrierCode,
      orderCode: dto.orderCode,
      trackingNumber: dto.trackingNumber,
      evidenceUrl: dto.evidenceUrl,
      markBlacklisted: dto.markBlacklisted,
    });

    const crmConfig = await this.customer360Service.getShopCrmTrustAndIndustryConfig(shopId);
    const refreshedLookup = await this.trustScoreService.lookupPhoneReputationFromSources({
      shopId,
      rawPhone: dto.rawPhone,
      config: crmConfig,
      bypassCache: true,
    });

    const trustEvaluation = this.trustScoreService.evaluateCustomerTrustScore({
      successfulDeliveriesCount: refreshedLookup.shopDeliveredFromLedger,
      returnedOrdersCount: refreshedLookup.shopReturnedFromLedger,
      networkDeliveredCount: refreshedLookup.networkDeliveredCount,
      networkReturnedCount: refreshedLookup.networkReturnedCount,
      reportedCount: refreshedLookup.reportedCount,
      verifiedReportedCount: refreshedLookup.verifiedReportedCount,
      reportedReasons: refreshedLookup.reportedReasons,
      sourceBreakdowns: refreshedLookup.sourceBreakdowns,
      providerDiagnostics: refreshedLookup.providerDiagnostics,
      isBlacklisted: Boolean(dto.markBlacklisted),
      shopRequireDepositOnHighRisk: crmConfig.requireDepositOnHighRisk,
      highRiskReturnRateThresholdPercent: crmConfig.highRiskReturnRateThresholdPercent,
      highRiskReportedCountThreshold: crmConfig.highRiskReportedCountThreshold,
      autoRequireDepositBelowTrustScore: crmConfig.autoRequireDepositBelowTrustScore,
      lookupSource: refreshedLookup.lookupSource,
      enabledCarriers: crmConfig.enabledCarriers,
    });

    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Submitted standalone phone abuse report successfully',
      data: {
        reportId: report.id,
        phoneMasked,
        verificationLevel: report.verificationLevel,
        isCarrierVerified: report.isCarrierVerified,
        trustEvaluation,
      },
    };
  }

  @Patch(':shopId/customers/:customerId/report-abuse/:reportId/retract')
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_BLACKLIST_TOGGLE)
  @ApiOperation({
    summary: 'Rút lại báo xấu đã gửi bởi shop và tự động tính lại điểm uy tín liên shop',
  })
  async retractAbuseReport(
    @Param('shopId') shopId: string,
    @Param('reportId') reportId: string,
    @Body() dto: RetractPhoneAbuseReportDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const retracted = await this.ledgerService.retractAbuseReport({
      shopId,
      reportId,
      actorUserId: req.user?.id || 'system',
      reason: dto.reason,
    });

    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Retracted phone abuse report successfully',
      data: {
        reportId: retracted.id,
        status: retracted.status,
        retractedAt: retracted.retractedAt,
      },
    };
  }

  @Post(':shopId/trust/backfill')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_PROFILE_EDIT)
  @ApiOperation({
    summary:
      'Đồng bộ lịch sử đơn nhận/hoàn từ bảng customer_profiles sang sổ cái mạng lưới liên shop',
  })
  async backfillShopTrustLedger(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const stats = await this.ledgerService.backfillShopCustomerProfilesToLedger(shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Backfilled shop trust ledger successfully',
      data: stats,
    };
  }

  @Post(':shopId/trust/import-history')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_PROFILE_EDIT)
  @ApiOperation({
    summary: 'Nhập hàng loạt lịch sử giao nhận / báo xấu thực tế (từ file CSV / ERP) vào sổ cái',
  })
  async importPhoneTrustHistory(
    @Param('shopId') shopId: string,
    @Body() dto: ImportPhoneTrustHistoryDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const stats = await this.ledgerService.importHistoricalRows({
      shopId,
      actorUserId: req.user?.id || 'system',
      rows: dto.rows,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Imported phone trust history successfully',
      data: stats,
    };
  }

  @Get(':shopId/trust/gateway-status')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary: 'Kiểm tra trạng thái cấu hình hạ tầng PLATFORM_TRUST_COMMUNITY_GATEWAY_URL',
  })
  async getPlatformGatewayStatus(): Promise<DBaseRes> {
    const isConfigured = Boolean(envs.phoneTrust.communityGatewayUrl);
    const circuitOpen = isConfigured
      ? await this.blindIndexService.isCircuitOpen('PLATFORM_COMMUNITY_GATEWAY')
      : false;

    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched platform trust gateway status successfully',
      data: {
        isConfigured,
        providerName: envs.phoneTrust.communityGatewayProviderName,
        circuitOpen,
        cacheTtlSeconds: envs.phoneTrust.cacheTtlSeconds,
      },
    };
  }
}
