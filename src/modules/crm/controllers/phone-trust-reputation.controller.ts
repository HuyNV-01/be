import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Request } from 'express';
import { PermissionCodeEnum } from 'src/common/enum/permission.enum';
import { DBaseRes } from 'src/dto/base-res.dto';
import { StandalonePhoneAbuseReportDto } from 'src/dto/crm/phone-trust-reputation.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import {
  RequireShopPermissions,
  ShopPermissionGuard,
} from 'src/modules/iam/guards/shop-permission.guard';
import { FieldLevelSecurityInterceptor } from 'src/modules/iam/interceptors/field-level-security.interceptor';

import { PhoneTrustStandaloneService } from '../services/phone-trust-standalone.service';

@ApiTags('Sprint 5 — Zero-Config 3PL & Community Phone Reputation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ShopPermissionGuard)
@UseInterceptors(FieldLevelSecurityInterceptor)
@Controller('crm')
export class PhoneTrustReputationController {
  constructor(private readonly phoneTrustStandaloneService: PhoneTrustStandaloneService) {}

  @Post(':shopId/trust/report-phone')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CRM_CUSTOMER_BLACKLIST_TOGGLE)
  @ApiOperation({
    summary:
      'Báo xấu SĐT 1 chạm (Zero-Config) và tự động cập nhật ngay chỉ số báo xấu cho toàn mạng lưới liên shop',
  })
  async submitStandalonePhoneAbuseReport(
    @Param('shopId') shopId: string,
    @Body() dto: StandalonePhoneAbuseReportDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.phoneTrustStandaloneService.submitStandalonePhoneAbuseReport({
      shopId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Submitted standalone phone abuse report successfully',
      data,
    };
  }
}
