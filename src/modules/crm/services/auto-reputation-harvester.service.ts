import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { PosOrderStatusEnum } from 'src/common/enum';
import { CommunityPhoneAbuseReportEntity } from 'src/entity/community-phone-abuse-report.entity';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { PosOrderEntity } from 'src/entity/pos-order.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { In, Repository } from 'typeorm';

import {
  OmsOrderStatusChangedEventPayload,
  PhoneReputationSyncService,
} from './phone-reputation-sync.service';
import { PiiVaultAndAuditService } from './pii-vault-and-audit.service';

export interface CarrierDeliveryFailedEventPayload {
  shopId: string;
  orderId: string;
  carrierCode?: string | null;
  trackingNumber?: string | null;
  reason?: string | null;
}

const HARVESTABLE_ORDER_STATUSES: PosOrderStatusEnum[] = [
  PosOrderStatusEnum.DELIVERED,
  PosOrderStatusEnum.DELIVERED_RECONCILED,
  PosOrderStatusEnum.RETURNING,
  PosOrderStatusEnum.RETURNED_RESTOCKED,
  PosOrderStatusEnum.DELIVERY_FAILED_RESCUE,
];

const RETURNED_STATUS_SET = new Set<PosOrderStatusEnum>([
  PosOrderStatusEnum.RETURNING,
  PosOrderStatusEnum.RETURNED_RESTOCKED,
]);

/**
 * Dịch vụ Thu Hoạch Tự Động (Zero-Config Auto-Harvester):
 * Tự động đồng bộ đơn nhận/hoàn từ mọi shop vào Sổ cái Liên Shop khi khởi động,
 * theo lịch định kỳ mỗi 10 phút và theo thời gian thực khi OMS đổi trạng thái,
 * đồng thời tự động tạo báo cáo xấu xác thực 3PL khi phát sinh hoàn đơn hoặc giao thất bại.
 */
@Injectable()
export class AutoReputationHarvesterService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AutoReputationHarvesterService.name);
  private isSweepRunning = false;

  constructor(
    @InjectRepository(PosOrderEntity)
    private readonly posOrderRepo: Repository<PosOrderEntity>,
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(CommunityPhoneAbuseReportEntity)
    private readonly abuseReportRepo: Repository<CommunityPhoneAbuseReportEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    private readonly piiVaultService: PiiVaultAndAuditService,
    private readonly phoneReputationSyncService: PhoneReputationSyncService,
  ) {}

  public onApplicationBootstrap(): void {
    // Chạy nền sau 5 giây để không cản trở quá trình khởi động HTTP server
    setTimeout(() => {
      void this.runScheduledFullReputationHarvest();
    }, 5000);
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  public async runScheduledFullReputationHarvest(): Promise<void> {
    if (this.isSweepRunning) return;
    this.isSweepRunning = true;

    try {
      const shops = await this.shopRepo.find({
        select: ['id', 'name', 'crmTrustAndIndustryConfigJson'],
        take: 500,
      });

      let totalOrdersSynced = 0;
      let totalAutoReportsCreated = 0;

      for (const shop of shops) {
        if (shop.crmTrustAndIndustryConfigJson?.consortiumSharingEnabled === false) {
          continue;
        }

        const recentOrders = await this.posOrderRepo.find({
          where: {
            shopId: shop.id,
            status: In(HARVESTABLE_ORDER_STATUSES),
          },
          order: { updatedAt: 'DESC' },
          take: 300,
        });

        for (const order of recentOrders) {
          const syncRes =
            await this.phoneReputationSyncService.syncSingleOrderOutcomeToReputationLedger(order);
          if (syncRes.synced) {
            totalOrdersSynced += 1;
          }

          if (RETURNED_STATUS_SET.has(order.status) && syncRes.phoneGlobalHash) {
            const created = await this.ensureAutoVerifiedReturnAbuseReport({
              shopId: shop.id,
              shopName: shop.name,
              order,
              phoneGlobalHash: syncRes.phoneGlobalHash,
              reasonOverride: null,
            });
            if (created) totalAutoReportsCreated += 1;
          }
        }
      }

      if (totalOrdersSynced > 0 || totalAutoReportsCreated > 0) {
        this.logger.log(
          `Zero-Config Auto-Harvest synced ${totalOrdersSynced} orders & ${totalAutoReportsCreated} verified return reports across ${shops.length} shops.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Zero-Config Auto-Harvest skipped due to error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.isSweepRunning = false;
    }
  }

  @OnEvent('oms.order.status_changed', { async: true })
  public async handleOrderStatusChangedForAutoReport(
    payload: OmsOrderStatusChangedEventPayload,
  ): Promise<void> {
    if (!payload?.shopId || !payload?.orderId) return;
    if (!RETURNED_STATUS_SET.has(payload.status)) return;

    try {
      const [order, shop] = await Promise.all([
        this.posOrderRepo.findOne({ where: { id: payload.orderId, shopId: payload.shopId } }),
        this.shopRepo.findOne({ where: { id: payload.shopId } }),
      ]);
      if (!order) return;

      const syncRes =
        await this.phoneReputationSyncService.syncSingleOrderOutcomeToReputationLedger(order);
      if (!syncRes.phoneGlobalHash) return;

      await this.ensureAutoVerifiedReturnAbuseReport({
        shopId: payload.shopId,
        shopName: shop?.name || null,
        order,
        phoneGlobalHash: syncRes.phoneGlobalHash,
        reasonOverride: payload.reasonNote || null,
      });
    } catch (err) {
      this.logger.warn(
        `Auto return abuse report failed for order ${payload.orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  @OnEvent('carrier.delivery.failed', { async: true })
  public async handleCarrierDeliveryFailed(
    payload: CarrierDeliveryFailedEventPayload,
  ): Promise<void> {
    if (!payload?.shopId || !payload?.orderId) return;

    try {
      const [order, shop] = await Promise.all([
        this.posOrderRepo.findOne({ where: { id: payload.orderId, shopId: payload.shopId } }),
        this.shopRepo.findOne({ where: { id: payload.shopId } }),
      ]);
      if (!order) return;

      const syncRes =
        await this.phoneReputationSyncService.syncSingleOrderOutcomeToReputationLedger(order);
      if (!syncRes.phoneGlobalHash) return;

      const reasonText = (payload.reason || '').trim();
      const isRefusalOrUnreachable =
        /(từ chối|bom|không nghe|thuê bao|hủy nhận|sai số|refuse|unreachable)/i.test(reasonText);

      if (isRefusalOrUnreachable) {
        await this.ensureAutoVerifiedReturnAbuseReport({
          shopId: payload.shopId,
          shopName: shop?.name || null,
          order,
          phoneGlobalHash: syncRes.phoneGlobalHash,
          reasonOverride:
            reasonText ||
            `Bưu tá ${payload.carrierCode || order.carrierCode || '3PL'} báo giao thất bại do khách không nhận hàng.`,
        });
      }
    } catch (err) {
      this.logger.warn(
        `Failed to process carrier.delivery.failed for order ${payload.orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async ensureAutoVerifiedReturnAbuseReport(params: {
    shopId: string;
    shopName?: string | null;
    order: PosOrderEntity;
    phoneGlobalHash: string;
    reasonOverride?: string | null;
  }): Promise<boolean> {
    const tracking = (params.order.trackingNumber || '').trim() || null;
    const orderCode = (params.order.orderCode || params.order.id).trim();
    const dedupeKey = `AUTO_RETURN_${tracking || orderCode}`.slice(0, 96);

    const existing = await this.abuseReportRepo.findOne({
      where: {
        phoneGlobalHash: params.phoneGlobalHash,
        reporterShopId: params.shopId,
        dedupeKey,
      },
    });
    if (existing) return false;

    const carrierUpper = (params.order.carrierCode || '').trim().toUpperCase() || null;
    const shopAlias = params.shopName?.trim() || `Shop #${params.shopId.slice(0, 6)}`;
    const reasonNote =
      params.reasonOverride?.trim() ||
      `Hệ thống tự động ghi nhận đơn hoàn ${orderCode}${
        carrierUpper ? ` qua ${carrierUpper}` : ''
      }${tracking ? ` (Vận đơn ${tracking})` : ''}.`;

    await this.abuseReportRepo.save(
      this.abuseReportRepo.create({
        phoneGlobalHash: params.phoneGlobalHash,
        phoneMaskedHint: params.order.customerPhoneMasked || null,
        reporterShopId: params.shopId,
        reporterShopAlias: shopAlias,
        reporterUserId: 'auto_oms_harvester',
        customerId: params.order.customerId || null,
        dedupeKey,
        reasonCode: 'BOM_HANG',
        reasonNote,
        sourceCode: carrierUpper ? `CARRIER_3PL_${carrierUpper}` : 'SHOP_INTERNAL',
        carrierCode: carrierUpper,
        orderCode,
        trackingNumber: tracking,
        verificationLevel: tracking ? 'CARRIER_VERIFIED' : 'ORDER_LINKED',
        severity: tracking ? 'CRITICAL' : 'HIGH',
        status: 'ACTIVE',
      }),
    );

    await this.phoneReputationSyncService.recalculateAbuseReportCountersForPhoneHash(
      params.phoneGlobalHash,
      params.order.customerPhoneMasked || null,
    );

    if (params.order.customerId) {
      const cust = await this.customerRepo.findOne({
        where: { id: params.order.customerId, shopId: params.shopId },
      });
      if (cust) {
        cust.phoneGlobalHash = params.phoneGlobalHash;
        cust.reportedCount = Math.max(Number(cust.reportedCount || 0) + 1, 1);
        await this.customerRepo.save(cust);
      }
    }

    return true;
  }
}
