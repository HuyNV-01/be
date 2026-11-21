import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import * as crypto from 'crypto';
import { PhoneTrustEventOutcomeEnum, PhoneTrustVerificationLevelEnum } from 'src/common/enum';
import { envs } from 'src/config/envs/envs';

import { PhoneTrustLedgerService } from '../services/phone-trust-ledger.service';
import { PhoneTrustProviderAdaptersService } from '../services/phone-trust-provider-adapters.service';

/**
 * Public webhook ingestion endpoints for Vietnamese 3PL carriers (GHN, GHTK, ViettelPost, SuperShip).
 * Converts real-time delivery/return callbacks into CARRIER_VERIFIED ledger events so every
 * completed or returned parcel across all shops automatically enriches the consortium network.
 */
@ApiTags('3PL Carrier Trust Webhooks')
@Controller('webhooks/trust-3pl')
export class CarrierTrustWebhookController {
  private readonly logger = new Logger(CarrierTrustWebhookController.name);

  constructor(
    private readonly ledgerService: PhoneTrustLedgerService,
    private readonly adaptersService: PhoneTrustProviderAdaptersService,
  ) {}

  private assertSharedSecret(provided?: string | null, expected?: string | null): void {
    if (!expected) return;
    if (!provided) {
      throw new UnauthorizedException('MISSING_WEBHOOK_SECRET');
    }
    const providedBuf = Buffer.from(provided.trim());
    const expectedBuf = Buffer.from(expected.trim());
    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      throw new UnauthorizedException('INVALID_WEBHOOK_SECRET');
    }
  }

  /**
   * GHN switch_status callback (https://developer.ghn.vn/vi/docs/master-data/order-status).
   */
  @Post('ghn/:shopId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook GHN cập nhật trạng thái đơn vào sổ cái uy tín SĐT' })
  async handleGhnWebhook(
    @Param('shopId') shopId: string,
    @Headers('x-ghn-webhook-secret') secretHeader: string | undefined,
    @Query('secret') secretQuery: string | undefined,
    @Body() payload: Record<string, any>,
  ): Promise<{ received: boolean; recorded: boolean }> {
    this.assertSharedSecret(secretHeader || secretQuery, envs.phoneTrust.carrierWebhooks.ghnSecret);

    const rawStatus = String(payload.Status || payload.status || '');
    const outcome = this.adaptersService.mapGhnStatusToOutcome(rawStatus);
    const trackingNumber = String(payload.OrderCode || payload.order_code || '').trim();
    const rawPhone = String(
      payload.ToPhone || payload.to_phone || payload.CustomerPhone || '',
    ).trim();

    if (
      !trackingNumber ||
      !rawPhone ||
      (outcome !== 'DELIVERED' && outcome !== 'RETURNED' && outcome !== 'DELIVERY_FAILED')
    ) {
      return { received: true, recorded: false };
    }

    const mappedOutcome =
      outcome === 'DELIVERED'
        ? PhoneTrustEventOutcomeEnum.DELIVERED
        : outcome === 'RETURNED'
          ? PhoneTrustEventOutcomeEnum.RETURNED
          : PhoneTrustEventOutcomeEnum.DELIVERY_FAILED;

    await this.ledgerService.recordDeliveryEvent({
      rawPhone,
      sourceShopId: shopId,
      sourceProvider: 'CARRIER_WEBHOOK_GHN',
      externalEventKey: `GHN:${trackingNumber}:${mappedOutcome}`,
      carrierCode: 'GHN',
      trackingNumber,
      orderCode: payload.ClientOrderCode ? String(payload.ClientOrderCode) : null,
      eventOutcome: mappedOutcome,
      verificationLevel: PhoneTrustVerificationLevelEnum.CARRIER_VERIFIED,
      codAmount: Number(payload.CODAmount || 0),
      carrierRawStatus: rawStatus,
      carrierReasonNote: payload.Reason ? String(payload.Reason) : null,
      occurredAt: payload.Time ? new Date(String(payload.Time)) : new Date(),
    });

    this.logger.log(
      `Recorded GHN ${mappedOutcome} trust event for ${trackingNumber} (shop=${shopId})`,
    );
    return { received: true, recorded: true };
  }

  /**
   * GHTK updateShipment webhook (https://api.ghtk.vn/docs/submit-order/webhook/).
   * Supports both application/x-www-form-urlencoded and JSON bodies.
   */
  @Post('ghtk/:shopId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook GHTK cập nhật trạng thái đơn vào sổ cái uy tín SĐT' })
  async handleGhtkWebhook(
    @Param('shopId') shopId: string,
    @Query('hash') hashQuery: string | undefined,
    @Body() payload: Record<string, any>,
  ): Promise<{ received: boolean; recorded: boolean }> {
    this.assertSharedSecret(hashQuery, envs.phoneTrust.carrierWebhooks.ghtkHashSecret);

    const statusId = Number(payload.status_id);
    const trackingNumber = String(payload.label_id || '').trim();
    const rawPhone = String(payload.customer_tel || payload.tel || payload.phone || '').trim();
    const returnPartPackage = Number(payload.return_part_package || 0) === 1;

    const outcome = this.adaptersService.mapGhtkStatusIdToOutcome(statusId);
    if (
      !trackingNumber ||
      !rawPhone ||
      (outcome !== 'DELIVERED' && outcome !== 'RETURNED' && outcome !== 'DELIVERY_FAILED')
    ) {
      return { received: true, recorded: false };
    }

    const mappedOutcome = returnPartPackage
      ? PhoneTrustEventOutcomeEnum.PARTIAL_RETURN
      : outcome === 'DELIVERED'
        ? PhoneTrustEventOutcomeEnum.DELIVERED
        : outcome === 'RETURNED'
          ? PhoneTrustEventOutcomeEnum.RETURNED
          : PhoneTrustEventOutcomeEnum.DELIVERY_FAILED;

    await this.ledgerService.recordDeliveryEvent({
      rawPhone,
      sourceShopId: shopId,
      sourceProvider: 'CARRIER_WEBHOOK_GHTK',
      externalEventKey: `GHTK:${trackingNumber}:${mappedOutcome}`,
      carrierCode: 'GHTK',
      trackingNumber,
      orderCode: payload.partner_id ? String(payload.partner_id) : null,
      eventOutcome: mappedOutcome,
      verificationLevel: PhoneTrustVerificationLevelEnum.CARRIER_VERIFIED,
      codAmount: Number(payload.pick_money || payload.fee || 0),
      carrierRawStatus: String(statusId),
      carrierReasonNote: payload.reason ? String(payload.reason) : null,
      occurredAt: payload.action_time ? new Date(String(payload.action_time)) : new Date(),
    });

    return { received: true, recorded: true };
  }

  /**
   * ViettelPost Partner webhook (DATA.ORDER_STATUS: 501=Delivered, 504/505=Returned, 507/508=Failed).
   */
  @Post('viettelpost/:shopId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook ViettelPost cập nhật trạng thái đơn vào sổ cái uy tín SĐT' })
  async handleViettelPostWebhook(
    @Param('shopId') shopId: string,
    @Headers('token') tokenHeader: string | undefined,
    @Body() payload: Record<string, any>,
  ): Promise<{ received: boolean; recorded: boolean }> {
    const providedToken = tokenHeader || (payload.TOKEN ? String(payload.TOKEN) : undefined);
    this.assertSharedSecret(providedToken, envs.phoneTrust.carrierWebhooks.vtpToken);

    const dataNode = (payload.DATA || payload) as Record<string, any>;
    const orderStatus = Number(dataNode.ORDER_STATUS);
    const trackingNumber = String(dataNode.ORDER_NUMBER || '').trim();
    const rawPhone = String(
      dataNode.RECEIVER_PHONE || dataNode.CUSTOMER_PHONE || dataNode.PHONE || '',
    ).trim();

    const outcome = this.adaptersService.mapViettelPostStatusToOutcome(orderStatus);
    if (
      !trackingNumber ||
      !rawPhone ||
      (outcome !== 'DELIVERED' && outcome !== 'RETURNED' && outcome !== 'DELIVERY_FAILED')
    ) {
      return { received: true, recorded: false };
    }

    const mappedOutcome =
      outcome === 'DELIVERED'
        ? PhoneTrustEventOutcomeEnum.DELIVERED
        : outcome === 'RETURNED'
          ? PhoneTrustEventOutcomeEnum.RETURNED
          : PhoneTrustEventOutcomeEnum.DELIVERY_FAILED;

    await this.ledgerService.recordDeliveryEvent({
      rawPhone,
      sourceShopId: shopId,
      sourceProvider: 'CARRIER_WEBHOOK_VTP',
      externalEventKey: `VTP:${trackingNumber}:${mappedOutcome}`,
      carrierCode: 'VTP',
      trackingNumber,
      orderCode: dataNode.ORDER_REFERENCE ? String(dataNode.ORDER_REFERENCE) : null,
      eventOutcome: mappedOutcome,
      verificationLevel: PhoneTrustVerificationLevelEnum.CARRIER_VERIFIED,
      codAmount: Number(dataNode.MONEY_COLLECTION || 0),
      carrierRawStatus: String(orderStatus),
      carrierReasonNote: dataNode.NOTE ? String(dataNode.NOTE) : null,
      occurredAt: new Date(),
    });

    return { received: true, recorded: true };
  }

  /**
   * SuperShip webhook (https://docs.developers.supership.vn/guide/webhooks.html).
   */
  @Post('supership/:shopId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook SuperShip cập nhật trạng thái đơn vào sổ cái uy tín SĐT' })
  async handleSuperShipWebhook(
    @Param('shopId') shopId: string,
    @Headers('x-supership-secret') secretHeader: string | undefined,
    @Query('secret') secretQuery: string | undefined,
    @Body() payload: Record<string, any>,
  ): Promise<{ received: boolean; recorded: boolean }> {
    this.assertSharedSecret(
      secretHeader || secretQuery,
      envs.phoneTrust.carrierWebhooks.supershipSecret,
    );

    const rawStatus = payload.status ?? payload.status_name ?? '';
    const outcome = this.adaptersService.mapSuperShipStatusToOutcome(rawStatus);
    const trackingNumber = String(payload.code || payload.shortcode || '').trim();
    const rawPhone = String(payload.phone || payload.receiver_phone || '').trim();

    if (
      !trackingNumber ||
      !rawPhone ||
      (outcome !== 'DELIVERED' && outcome !== 'RETURNED' && outcome !== 'DELIVERY_FAILED')
    ) {
      return { received: true, recorded: false };
    }

    const mappedOutcome =
      outcome === 'DELIVERED'
        ? PhoneTrustEventOutcomeEnum.DELIVERED
        : outcome === 'RETURNED'
          ? PhoneTrustEventOutcomeEnum.RETURNED
          : PhoneTrustEventOutcomeEnum.DELIVERY_FAILED;

    await this.ledgerService.recordDeliveryEvent({
      rawPhone,
      sourceShopId: shopId,
      sourceProvider: 'CARRIER_WEBHOOK_SUPERSHIP',
      externalEventKey: `SUPERSHIP:${trackingNumber}:${mappedOutcome}`,
      carrierCode: 'SUPERSHIP',
      trackingNumber,
      orderCode: payload.soc ? String(payload.soc) : null,
      eventOutcome: mappedOutcome,
      verificationLevel: PhoneTrustVerificationLevelEnum.CARRIER_VERIFIED,
      codAmount: Number(payload.amount || 0),
      carrierRawStatus: String(rawStatus),
      carrierReasonNote: payload.reason_text ? String(payload.reason_text) : null,
      occurredAt: payload.updated_at ? new Date(String(payload.updated_at)) : new Date(),
    });

    return { received: true, recorded: true };
  }
}
