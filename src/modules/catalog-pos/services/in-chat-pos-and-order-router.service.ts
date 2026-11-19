import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  AdsConversionEventNameEnum,
  AdsConversionPlatformEnum,
  ChannelTypeEnum,
  CustomerWalletLedgerTypeEnum,
  CustomerWalletTransactionTypeEnum,
  DiscountApprovalStatusEnum,
  MembershipStatusEnum,
  NotificationResourceTypeEnum,
  NotificationTypeEnum,
  PosOrderPaymentMethodEnum,
  PosOrderPaymentStatusEnum,
  PosOrderStatusEnum,
  SecurityAuditActionCodeEnum,
  ShopRoleEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  CreateInChatPosOrderDto,
  MergeDuplicatePosOrdersDto,
  PosOrderListQueryDto,
  ResolveDiscountApprovalDto,
} from 'src/dto/catalog-pos/catalog-pos.dto';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import {
  BundleComponentRevenueAllocationItem,
  PosOrderEntity,
  PosOrderLineItem,
} from 'src/entity/pos-order.entity';
import { ProductVariantEntity } from 'src/entity/product-variant.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { WarehouseStockItemEntity } from 'src/entity/warehouse-stock-item.entity';
import { WarehouseEntity } from 'src/entity/warehouse.entity';
import { AdsConversionSyncService } from 'src/modules/crm/services/ads-conversion-sync.service';
import { Customer360Service } from 'src/modules/crm/services/customer-360.service';
import { CustomerRfmAndLoyaltyService } from 'src/modules/crm/services/customer-rfm-and-loyalty.service';
import { PiiVaultAndAuditService } from 'src/modules/crm/services/pii-vault-and-audit.service';
import { VnAdministrativeAddressCarrierService } from 'src/modules/crm/services/vn-administrative-address-carrier.service';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import { In, Repository } from 'typeorm';

import { AtomicInventoryAndTransferService } from './atomic-inventory-and-transfer.service';
import { CatalogAndBomService } from './catalog-and-bom.service';
import { VietQrEmvcoAndCounterPosService } from './vietqr-emvco-and-counter-pos.service';

@Injectable()
export class InChatPosAndOrderRouterService {
  private readonly logger = new Logger(InChatPosAndOrderRouterService.name);

  constructor(
    @InjectRepository(PosOrderEntity)
    private readonly orderRepo: Repository<PosOrderEntity>,
    @InjectRepository(ProductVariantEntity)
    private readonly variantRepo: Repository<ProductVariantEntity>,
    @InjectRepository(WarehouseEntity)
    private readonly warehouseRepo: Repository<WarehouseEntity>,
    @InjectRepository(WarehouseStockItemEntity)
    private readonly stockRepo: Repository<WarehouseStockItemEntity>,
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(ShopMemberEntity)
    private readonly memberRepo: Repository<ShopMemberEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    private readonly catalogService: CatalogAndBomService,
    private readonly inventoryService: AtomicInventoryAndTransferService,
    private readonly vietQrService: VietQrEmvcoAndCounterPosService,
    private readonly addressCarrierService: VnAdministrativeAddressCarrierService,
    private readonly customer360Service: Customer360Service,
    private readonly rfmAndLoyaltyService: CustomerRfmAndLoyaltyService,
    private readonly piiVaultService: PiiVaultAndAuditService,
    private readonly adsConversionSyncService: AdsConversionSyncService,
    private readonly notificationsService: NotificationsService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private generateOrderCode(suffix = ''): string {
    const timePart = String(Date.now()).slice(-6);
    const rand = Math.floor(100 + Math.random() * 900);
    return `ORD-${timePart}-${rand}${suffix}`;
  }

  /**
   * F06.5: Phát hiện các đơn hàng trùng của cùng khách hàng đang ở trạng thái chưa gửi cho bưu tá
   */
  public async detectMergeableDuplicateOrders(params: {
    shopId: string;
    customerId?: string | null;
    conversationId?: string | null;
    receiverWardCode?: string | null;
  }): Promise<PosOrderEntity[]> {
    const { shopId, customerId, conversationId } = params;
    if (!customerId && !conversationId) return [];

    const mergeableStatuses = [
      PosOrderStatusEnum.CONFIRMED,
      PosOrderStatusEnum.WAITING_PACKING,
      PosOrderStatusEnum.WAITING_DEPOSIT,
      PosOrderStatusEnum.PENDING_PRICE_APPROVAL,
    ];

    const qb = this.orderRepo
      .createQueryBuilder('o')
      .where('o.shop_id = :shopId', { shopId })
      .andWhere('o.status IN (:...statuses)', { statuses: mergeableStatuses });

    if (customerId && conversationId) {
      qb.andWhere('(o.customer_id = :customerId OR o.conversation_id = :conversationId)', {
        customerId,
        conversationId,
      });
    } else if (customerId) {
      qb.andWhere('o.customer_id = :customerId', { customerId });
    } else if (conversationId) {
      qb.andWhere('o.conversation_id = :conversationId', { conversationId });
    }

    return qb.orderBy('o.createdAt', 'DESC').take(5).getMany();
  }

  /**
   * F06.6 (Công cụ `T07`): Định tuyến kho thông minh & kiểm tra nhu cầu tách đơn đa kho (`Multi-Warehouse Order Routing & Split`)
   */
  public async previewWarehouseAllocationAndSplit(params: {
    shopId: string;
    receiverProvinceCode?: string | null;
    preferredWarehouseId?: string | null;
    items: Array<{ variantId: string; quantity: number }>;
  }): Promise<{
    canFulfillSingleWarehouse: boolean;
    recommendedSingleWarehouse: WarehouseEntity | null;
    requiresMultiWarehouseSplit: boolean;
    allocationsByWarehouse: Array<{
      warehouseId: string;
      warehouseCode: string;
      warehouseName: string;
      items: Array<{
        variantId: string;
        skuCode: string;
        variantName: string;
        quantity: number;
      }>;
    }>;
  }> {
    const warehouses = await this.inventoryService.listWarehousesForShop(params.shopId);
    if (warehouses.length === 0) {
      return {
        canFulfillSingleWarehouse: false,
        recommendedSingleWarehouse: null,
        requiresMultiWarehouseSplit: false,
        allocationsByWarehouse: [],
      };
    }

    const sortedWarehouses = [...warehouses].sort((a, b) => {
      if (params.preferredWarehouseId) {
        if (a.id === params.preferredWarehouseId) return -1;
        if (b.id === params.preferredWarehouseId) return 1;
      }
      if (params.receiverProvinceCode) {
        const aMatch = a.provinceCode === params.receiverProvinceCode ? 0 : 1;
        const bMatch = b.provinceCode === params.receiverProvinceCode ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
      }
      return a.priorityOrder - b.priorityOrder;
    });

    const variantsMap = new Map<string, ProductVariantEntity>();
    const stocksMap = new Map<string, number>();

    const allStocks = await this.stockRepo.find({ where: { shopId: params.shopId } });
    for (const st of allStocks) {
      stocksMap.set(`${st.variantId}:${st.warehouseId}`, st.availableQty);
    }

    for (const item of params.items) {
      const v = await this.variantRepo.findOne({
        where: { id: item.variantId, shopId: params.shopId },
      });
      if (v) variantsMap.set(v.id, v);
    }

    for (const wh of sortedWarehouses) {
      const allAvailableInWh = params.items.every((item) => {
        const v = variantsMap.get(item.variantId);
        if (!v) return false;
        if (v.isBundleBom && Array.isArray(v.bundleComponentsJson)) {
          return v.bundleComponentsJson.every((comp) => {
            const avail = stocksMap.get(`${comp.componentVariantId}:${wh.id}`) || 0;
            return avail >= comp.requiredQty * item.quantity;
          });
        }
        const avail = stocksMap.get(`${item.variantId}:${wh.id}`) || 0;
        return avail >= item.quantity;
      });

      if (allAvailableInWh) {
        return {
          canFulfillSingleWarehouse: true,
          recommendedSingleWarehouse: wh,
          requiresMultiWarehouseSplit: false,
          allocationsByWarehouse: [
            {
              warehouseId: wh.id,
              warehouseCode: wh.code,
              warehouseName: wh.name,
              items: params.items.map((it) => {
                const v = variantsMap.get(it.variantId);
                return {
                  variantId: it.variantId,
                  skuCode: v?.skuCode || 'SKU',
                  variantName: v?.variantName || 'Sản phẩm',
                  quantity: it.quantity,
                };
              }),
            },
          ],
        };
      }
    }

    const allocationsMap = new Map<
      string,
      {
        warehouseId: string;
        warehouseCode: string;
        warehouseName: string;
        items: Array<{
          variantId: string;
          skuCode: string;
          variantName: string;
          quantity: number;
        }>;
      }
    >();

    for (const item of params.items) {
      const v = variantsMap.get(item.variantId);
      let remaining = item.quantity;

      for (const wh of sortedWarehouses) {
        if (remaining <= 0) break;
        const avail = stocksMap.get(`${item.variantId}:${wh.id}`) || 0;
        if (avail <= 0) continue;

        const takeQty = Math.min(remaining, avail);
        remaining -= takeQty;

        const bucket = allocationsMap.get(wh.id) || {
          warehouseId: wh.id,
          warehouseCode: wh.code,
          warehouseName: wh.name,
          items: [],
        };
        bucket.items.push({
          variantId: item.variantId,
          skuCode: v?.skuCode || 'SKU',
          variantName: v?.variantName || 'Sản phẩm',
          quantity: takeQty,
        });
        allocationsMap.set(wh.id, bucket);
      }

      if (remaining > 0) {
        const fallbackWh = sortedWarehouses[0];
        const bucket = allocationsMap.get(fallbackWh.id) || {
          warehouseId: fallbackWh.id,
          warehouseCode: fallbackWh.code,
          warehouseName: fallbackWh.name,
          items: [],
        };
        bucket.items.push({
          variantId: item.variantId,
          skuCode: v?.skuCode || 'SKU',
          variantName: v?.variantName || 'Sản phẩm',
          quantity: remaining,
        });
        allocationsMap.set(fallbackWh.id, bucket);
      }
    }

    const allocations = Array.from(allocationsMap.values());
    return {
      canFulfillSingleWarehouse: allocations.length === 1,
      recommendedSingleWarehouse: allocations.length === 1 ? sortedWarehouses[0] : null,
      requiresMultiWarehouseSplit: allocations.length > 1,
      allocationsByWarehouse: allocations,
    };
  }

  /**
   * F06.1 – F06.6: Tạo đơn hàng từ `In-Chat POS` hoặc `Counter POS`
   * Áp dụng Quy tắc Quà tặng kèm 0đ Động (`catalogConfig.freeGiftRules`) và Cấu hình Tài khoản Ngân hàng VietQR Động (`catalogConfig.vietQrBankConfig`) của Người bán.
   */
  public async createPosOrderWithSmartRouting(params: {
    shopId: string;
    actorUserId: string;
    dto: CreateInChatPosOrderDto;
  }): Promise<{
    primaryOrder: PosOrderEntity;
    splitChildOrders: PosOrderEntity[];
    mergeableDuplicateOrders: PosOrderEntity[];
    requiresManagerDiscountApproval: boolean;
    allowedMaxDiscountPercent: number;
  }> {
    const { shopId, actorUserId, dto } = params;
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      throw new BadRequestException('POS_ORDER_MUST_HAVE_AT_LEAST_ONE_ITEM');
    }

    const [catalogConfig, member] = await Promise.all([
      this.catalogService.getShopCatalogAndPosConfig(shopId),
      this.memberRepo.findOne({
        where: {
          shopId,
          userId: actorUserId,
          membershipStatus: MembershipStatusEnum.ACTIVE,
        },
      }),
    ]);

    const isOwnerOrManager =
      member?.role === ShopRoleEnum.SHOP_OWNER || member?.role === ShopRoleEnum.SHOP_MANAGER;
    const memberMaxDiscount = isOwnerOrManager
      ? 100
      : Math.max(0, Number(member?.maxDiscountPercent ?? 10));

    let customer: CustomerProfileEntity | null = null;
    if (dto.customerId) {
      customer = await this.customerRepo.findOne({
        where: { id: dto.customerId, shopId },
      });
    }
    if (!customer && dto.rawPhone) {
      customer = await this.customer360Service.upsertCustomerProfile(shopId, null, {
        fullName: dto.customerName,
        rawPhone: dto.rawPhone,
        defaultProvinceCode: dto.receiverProvinceCode || undefined,
        defaultDistrictCode: dto.receiverDistrictCode || undefined,
        defaultWardCode: dto.receiverWardCode || undefined,
        defaultHamletCode: dto.receiverHamletCode || undefined,
        defaultHamletName: dto.receiverHamletName || undefined,
        defaultAddressLine: dto.receiverAddressLine || undefined,
        conversationId: dto.conversationId,
      });
    }

    const crmConfig = await this.customer360Service.getShopCrmTrustAndIndustryConfig(shopId);
    const enrichedCustomer = customer
      ? this.customer360Service.enrichCustomerWithTrustEvaluation(
          customer,
          crmConfig.requireDepositOnHighRisk,
          crmConfig,
        )
      : null;

    const addressCrosswalk = this.addressCarrierService.resolveBidirectionalAddressCrosswalk({
      preferredMode: dto.addressTierMode || '3_TIER',
      provinceCode: dto.receiverProvinceCode || customer?.defaultProvinceCode || '01',
      districtCode: dto.receiverDistrictCode || customer?.defaultDistrictCode || null,
      wardCode: dto.receiverWardCode || customer?.defaultWardCode || null,
      hamletCode: dto.receiverHamletCode || customer?.defaultHamletCode || null,
      hamletName: dto.receiverHamletName || customer?.defaultHamletName || null,
      addressLine: dto.receiverAddressLine || customer?.defaultAddressLine || null,
    });

    const routingPlan = await this.previewWarehouseAllocationAndSplit({
      shopId,
      receiverProvinceCode: addressCrosswalk.fourTierAddress.provinceCode,
      preferredWarehouseId: dto.preferredWarehouseId,
      items: dto.items.map((it) => ({
        variantId: it.variantId,
        quantity: it.quantity,
      })),
    });

    const mergeableDuplicateOrders = await this.detectMergeableDuplicateOrders({
      shopId,
      customerId: customer?.id || dto.customerId,
      conversationId: dto.conversationId,
    });

    if (mergeableDuplicateOrders.length > 0 && dto.conversationId) {
      this.realtimeEmitter.emitToConversation(
        SOCKET_CONFIG.namespaces.CHAT,
        dto.conversationId,
        SOCKET_CONFIG.events.POS_OMS.DUPLICATE_ORDER_DETECTED,
        {
          shopId,
          conversationId: dto.conversationId,
          existingOrderCode: mergeableDuplicateOrders[0].orderCode,
          existingOrderId: mergeableDuplicateOrders[0].id,
          customerName: dto.customerName,
        },
      );
    }

    let minVariantMaxDiscount = 100;
    const orderLines: PosOrderLineItem[] = [];
    let subtotalAmount = 0;
    let totalItemDiscountAmount = 0;
    let totalWeightGrams = 0;
    let cogsSnapshotAmount = 0;
    const orderedCategoryIds = new Set<string>();

    const firstAllocWhId = routingPlan.allocationsByWarehouse[0]?.warehouseId;
    const primaryWh =
      routingPlan.recommendedSingleWarehouse ||
      (firstAllocWhId
        ? await this.warehouseRepo.findOne({
            where: { id: firstAllocWhId, shopId },
          })
        : await this.warehouseRepo.findOne({
            where: { shopId },
            order: { priorityOrder: 'ASC', createdAt: 'ASC' },
          }));

    if (!primaryWh) {
      throw new BadRequestException(
        'Cửa hàng chưa khởi tạo Kho hàng vật lý nào. Vui lòng tạo Kho hàng trước khi lên đơn POS.',
      );
    }

    for (const reqItem of dto.items) {
      const variant = await this.variantRepo.findOne({
        where: { id: reqItem.variantId, shopId },
      });
      if (!variant) {
        throw new NotFoundException(`Biến thể sản phẩm không tồn tại.`);
      }

      if (variant.customCategoryId) {
        orderedCategoryIds.add(variant.customCategoryId);
      }

      minVariantMaxDiscount = Math.min(
        minVariantMaxDiscount,
        Number(variant.maxDiscountPercent ?? 15),
      );

      const qty = Math.max(1, Number(reqItem.quantity || 1));
      const retailPrice = Number(variant.retailPrice || 0);
      const itemDiscPct = Math.max(
        0,
        Math.min(100, Number(reqItem.discountPercent ?? dto.orderDiscountPercent ?? 0)),
      );
      const unitDiscAmount = Math.round((retailPrice * itemDiscPct) / 100);
      const finalUnitPrice = Math.max(0, retailPrice - unitDiscAmount);
      const lineTotal = finalUnitPrice * qty;
      const unitCost = Number(variant.costPrice || 0);

      const allocWhId =
        routingPlan.allocationsByWarehouse.find((a) =>
          a.items.some((i) => i.variantId === variant.id),
        )?.warehouseId || primaryWh.id;

      await this.inventoryService.reserveStockAtomicWithRedisLua({
        shopId,
        actorUserId,
        dto: {
          draftCartId: dto.reservationCartId || `ord_lock_${Date.now()}`,
          warehouseId: allocWhId,
          variantId: variant.id,
          quantity: qty,
          conversationId: dto.conversationId,
        },
      });

      let bundleComponentAllocations: BundleComponentRevenueAllocationItem[] | undefined;
      let resolvedLineUnitCost = unitCost;

      if (
        variant.isBundleBom &&
        Array.isArray(variant.bundleComponentsJson) &&
        variant.bundleComponentsJson.length > 0
      ) {
        const componentIds = variant.bundleComponentsJson.map((c) => c.componentVariantId);
        const componentVariants = await this.variantRepo.findByIds(componentIds);
        const compVariantMap = new Map(componentVariants.map((cv) => [cv.id, cv]));

        const totalReferenceRetail = variant.bundleComponentsJson.reduce((acc, comp) => {
          const refPrice =
            Number(comp.retailPriceSnapshot || 0) ||
            Number(compVariantMap.get(comp.componentVariantId)?.retailPrice || 0);
          return acc + refPrice * Math.max(1, Number(comp.requiredQty || 1));
        }, 0);

        let accumulatedAllocatedRevenue = 0;
        let bundleTotalUnitCogs = 0;

        bundleComponentAllocations = variant.bundleComponentsJson.map((comp, idx, arr) => {
          const compEntity = compVariantMap.get(comp.componentVariantId);
          const reqCompQty = Math.max(1, Number(comp.requiredQty || 1));
          const quantityDeducted = reqCompQty * qty;
          const compUnitRetail =
            Number(comp.retailPriceSnapshot || 0) || Number(compEntity?.retailPrice || 0);
          const compUnitCost = Number(compEntity?.costPrice || 0);
          const weightRatio =
            totalReferenceRetail > 0
              ? Number(((compUnitRetail * reqCompQty) / totalReferenceRetail).toFixed(4))
              : Number((1 / Math.max(1, arr.length)).toFixed(4));

          const allocatedRevenueAmount =
            idx === arr.length - 1
              ? Math.max(0, lineTotal - accumulatedAllocatedRevenue)
              : Math.round(lineTotal * weightRatio);
          accumulatedAllocatedRevenue += allocatedRevenueAmount;

          const allocatedCogsAmount = compUnitCost * quantityDeducted;
          bundleTotalUnitCogs += compUnitCost * reqCompQty;

          return {
            componentVariantId: comp.componentVariantId,
            componentSkuCode: comp.componentSkuCode,
            componentName: comp.componentName,
            quantityDeducted,
            retailWeightRatio: weightRatio,
            allocatedRevenueAmount,
            allocatedCogsAmount,
          };
        });

        if (bundleTotalUnitCogs > 0) {
          resolvedLineUnitCost = bundleTotalUnitCogs;
        }
      }

      subtotalAmount += retailPrice * qty;
      totalItemDiscountAmount += unitDiscAmount * qty;
      totalWeightGrams += Number(variant.weightGrams || 300) * qty;
      cogsSnapshotAmount += resolvedLineUnitCost * qty;

      orderLines.push({
        variantId: variant.id,
        productId: variant.productId,
        skuCode: variant.skuCode,
        barcode: variant.barcode,
        variantName: variant.variantName,
        imageUrl: variant.imageUrl,
        quantity: qty,
        retailPrice,
        discountPercent: itemDiscPct,
        discountAmount: unitDiscAmount * qty,
        finalUnitPrice,
        lineTotalAmount: lineTotal,
        costPrice: resolvedLineUnitCost,
        weightGrams: Number(variant.weightGrams || 300) * qty,
        isBundleBom: variant.isBundleBom,
        isFreeGift: variant.isFreeGiftItem,
        warehouseId: allocWhId,
        warehouseName:
          routingPlan.allocationsByWarehouse.find((a) => a.warehouseId === allocWhId)
            ?.warehouseName || primaryWh.name,
        assignedSerialNumbers: reqItem.serialNumbers || [],
        ...(bundleComponentAllocations ? { bundleComponentAllocations } : {}),
      });
    }

    // 5. Đánh giá Quy tắc Quà tặng kèm 0đ Động do Người bán tự cấu hình (`catalogConfig.freeGiftRules` — F05.7)
    const activeGiftRules = (catalogConfig.freeGiftRules || []).filter((r) => r.isActive);
    for (const rule of activeGiftRules) {
      if (subtotalAmount < Number(rule.minOrderSubtotalVnd || 0)) continue;
      if (rule.requiredCategoryId && !orderedCategoryIds.has(rule.requiredCategoryId)) {
        continue;
      }

      const giftVariant = await this.variantRepo.findOne({
        where: { id: rule.giftVariantId, shopId, isActive: true },
      });
      if (!giftVariant) continue;

      const giftStock = await this.stockRepo.findOne({
        where: { shopId, warehouseId: primaryWh.id, variantId: giftVariant.id },
      });
      const giftQty = Math.max(1, Number(rule.giftQty || 1));
      if (!giftStock || giftStock.availableQty < giftQty) continue;

      orderLines.push({
        variantId: giftVariant.id,
        productId: giftVariant.productId,
        skuCode: giftVariant.skuCode,
        barcode: giftVariant.barcode,
        variantName: `[🎁 ${rule.ruleName}] ${giftVariant.variantName}`,
        imageUrl: giftVariant.imageUrl,
        quantity: giftQty,
        retailPrice: 0,
        discountPercent: 100,
        discountAmount: 0,
        finalUnitPrice: 0,
        lineTotalAmount: 0,
        costPrice: Number(giftVariant.costPrice || 0),
        weightGrams: Number(giftVariant.weightGrams || 100) * giftQty,
        isBundleBom: false,
        isFreeGift: true,
        warehouseId: primaryWh.id,
        warehouseName: primaryWh.name,
      });
    }

    const effectiveDiscountPercent =
      subtotalAmount > 0 ? Math.round((totalItemDiscountAmount / subtotalAmount) * 100) : 0;
    const allowedMaxDiscountPercent = isOwnerOrManager
      ? 100
      : Math.min(memberMaxDiscount, minVariantMaxDiscount);
    const requiresManagerDiscountApproval =
      !isOwnerOrManager && effectiveDiscountPercent > allowedMaxDiscountPercent;

    const shippingFeeAmount =
      dto.carrierCode === 'COUNTER_PICKUP'
        ? 0
        : Math.max(0, Number(dto.shippingFeeAmount ?? 25000));
    const customerShippingCharge = dto.isFreeShippingForCustomer ? 0 : shippingFeeAmount;

    const pointsRedeemed = Math.max(0, Number(dto.loyaltyPointsRedeemed || 0));
    const pointsDiscountVnd = pointsRedeemed * 1000;
    const walletApplied = Math.max(0, Number(dto.walletCreditAppliedAmount || 0));

    const totalPayableAmount = Math.max(
      0,
      subtotalAmount -
        totalItemDiscountAmount +
        customerShippingCharge -
        pointsDiscountVnd -
        walletApplied,
    );

    const isHighRiskCustomer = Boolean(enrichedCustomer?.trustEvaluation?.requireDepositVietQr);
    const depositRequiredAmount = isHighRiskCustomer
      ? Math.max(50000, Math.round(totalPayableAmount * 0.3))
      : dto.paymentMethod === PosOrderPaymentMethodEnum.DEPOSIT_AND_COD
        ? Math.round(totalPayableAmount * 0.3)
        : 0;

    const isCounterImmediatePaid =
      dto.paymentMethod === PosOrderPaymentMethodEnum.COUNTER_CASH ||
      dto.paymentMethod === PosOrderPaymentMethodEnum.WALLET_CREDIT;

    const paidTransferAmount = isCounterImmediatePaid ? totalPayableAmount : 0;
    const codCollectAmount = Math.max(0, totalPayableAmount - paidTransferAmount);

    let initialStatus = PosOrderStatusEnum.CONFIRMED;
    if (requiresManagerDiscountApproval) {
      initialStatus = PosOrderStatusEnum.PENDING_PRICE_APPROVAL;
    } else if (isHighRiskCustomer || depositRequiredAmount > 0) {
      initialStatus = PosOrderStatusEnum.WAITING_DEPOSIT;
    } else if (dto.carrierCode === 'COUNTER_PICKUP' && isCounterImmediatePaid) {
      initialStatus = PosOrderStatusEnum.DELIVERED_RECONCILED;
    }

    const orderCode = this.generateOrderCode();
    const vietQrAmount =
      depositRequiredAmount > 0 ? depositRequiredAmount : Math.max(1000, totalPayableAmount);
    const bankCfg = catalogConfig.vietQrBankConfig;
    const vietqrPayload = this.vietQrService.buildDynamicVietQrPayload({
      orderCode,
      amountVnd: vietQrAmount,
      bankBin: bankCfg?.bankBin,
      bankShortName: bankCfg?.bankShortName,
      accountNumber: bankCfg?.accountNumber,
      accountName: bankCfg?.accountName,
      transferPrefix: bankCfg?.transferPrefix,
    });

    const estimatedNetProfitAmount = totalPayableAmount - cogsSnapshotAmount - shippingFeeAmount;

    const primaryOrder = await this.orderRepo.save(
      this.orderRepo.create({
        shopId,
        orderCode,
        conversationId: dto.conversationId || null,
        customerId: customer?.id || dto.customerId || null,
        customerName: dto.customerName.trim(),
        customerPhoneMasked:
          customer?.phoneMasked ||
          (dto.rawPhone ? this.piiVaultService.maskPhoneNumber(dto.rawPhone) : '') ||
          '',
        customerPhoneEncrypted: customer?.phoneEncrypted || null,
        channelType: dto.channelType || ChannelTypeEnum.FACEBOOK_PAGE,
        pageShortCode: dto.pageShortCode || 'POS',
        warehouseId: primaryWh.id,
        warehouseName: primaryWh.name,
        status: initialStatus,
        addressTierMode: dto.addressTierMode || '3_TIER',
        receiverProvinceCode: addressCrosswalk.threeTierAddress.provinceCode,
        receiverProvinceName: addressCrosswalk.threeTierAddress.provinceName,
        receiverDistrictCode: addressCrosswalk.fourTierAddress.districtCode,
        receiverDistrictName: addressCrosswalk.fourTierAddress.districtName,
        receiverWardCode:
          (dto.addressTierMode || '3_TIER') === '3_TIER'
            ? addressCrosswalk.threeTierAddress.wardCode
            : addressCrosswalk.fourTierAddress.wardCode,
        receiverWardName:
          (dto.addressTierMode || '3_TIER') === '3_TIER'
            ? addressCrosswalk.threeTierAddress.wardName
            : addressCrosswalk.fourTierAddress.wardName,
        receiverHamletCode: addressCrosswalk.threeTierAddress.hamletCode,
        receiverHamletName: addressCrosswalk.threeTierAddress.hamletName,
        receiverAddressLine: addressCrosswalk.threeTierAddress.addressLine,
        fullThreeTierAddress: addressCrosswalk.threeTierAddress.fullFormattedAddress,
        fullFourTierAddress: addressCrosswalk.fourTierAddress.fullFormattedAddress,
        itemsJson: orderLines,
        totalWeightGrams,
        carrierCode: dto.carrierCode || 'GHN',
        carrierServiceName:
          dto.carrierCode === 'COUNTER_PICKUP' ? 'Nhận trực tiếp tại quầy' : 'Chuẩn Express',
        shippingFeeAmount,
        isFreeShippingForCustomer: Boolean(dto.isFreeShippingForCustomer),
        subtotalAmount,
        discountPercent: effectiveDiscountPercent,
        discountAmount: totalItemDiscountAmount,
        loyaltyPointsRedeemed: pointsRedeemed,
        walletCreditAppliedAmount: walletApplied,
        totalPayableAmount,
        depositRequiredAmount,
        paidTransferAmount,
        codCollectAmount,
        cogsSnapshotAmount,
        estimatedNetProfitAmount,
        paymentMethod: dto.paymentMethod || PosOrderPaymentMethodEnum.COD,
        paymentStatus: isCounterImmediatePaid
          ? PosOrderPaymentStatusEnum.PAID_IN_FULL
          : PosOrderPaymentStatusEnum.UNPAID,
        discountApprovalStatus: requiresManagerDiscountApproval
          ? DiscountApprovalStatusEnum.PENDING
          : DiscountApprovalStatusEnum.NOT_REQUIRED,
        discountApprovalReason: dto.discountApprovalReason || null,
        vietqrPayloadJson: vietqrPayload,
        reservationCartId: dto.reservationCartId || null,
        note: dto.note || null,
        createdByUserId: actorUserId,
      }),
    );

    const splitChildOrders: PosOrderEntity[] = [];
    if (
      dto.allowMultiWarehouseSplit &&
      routingPlan.requiresMultiWarehouseSplit &&
      routingPlan.allocationsByWarehouse.length > 1
    ) {
      const childIds: string[] = [];
      for (let idx = 0; idx < routingPlan.allocationsByWarehouse.length; idx++) {
        const alloc = routingPlan.allocationsByWarehouse[idx];
        const suffixLetter = String.fromCharCode(65 + idx);
        const childCode = `${orderCode}-${suffixLetter}`;
        const childLines = orderLines.filter((l) => l.warehouseId === alloc.warehouseId);
        const childSubtotal = childLines.reduce((s, l) => s + l.lineTotalAmount, 0);
        const childWeight = childLines.reduce((s, l) => s + l.weightGrams, 0);

        const childOrder = await this.orderRepo.save(
          this.orderRepo.create({
            ...primaryOrder,
            id: undefined as any,
            orderCode: childCode,
            parentOrderId: primaryOrder.id,
            warehouseId: alloc.warehouseId,
            warehouseName: alloc.warehouseName,
            itemsJson: childLines,
            totalWeightGrams: childWeight,
            subtotalAmount: childSubtotal,
            totalPayableAmount: childSubtotal,
            codCollectAmount: childSubtotal,
            note: `Đơn tách tự động từ đơn gốc ${orderCode} xuất tại [${alloc.warehouseName}]`,
          }),
        );
        splitChildOrders.push(childOrder);
        childIds.push(childOrder.id);
      }
      primaryOrder.splitChildOrderIdsJson = childIds;
      await this.orderRepo.save(primaryOrder);
    }

    if (requiresManagerDiscountApproval) {
      const managers = await this.memberRepo.find({
        where: { shopId, membershipStatus: MembershipStatusEnum.ACTIVE },
      });
      const managerIds = managers
        .filter((m) => m.role === ShopRoleEnum.SHOP_OWNER || m.role === ShopRoleEnum.SHOP_MANAGER)
        .map((m) => m.userId);

      if (managerIds.length > 0) {
        await this.notificationsService
          .createAndDispatch({
            recipientIds: managerIds,
            actorId: actorUserId,
            type: NotificationTypeEnum.POS_DISCOUNT_APPROVAL_REQUEST,
            title: `⏳ Yêu cầu duyệt giảm giá vượt trần (${effectiveDiscountPercent}%)`,
            content: `Đơn hàng ${primaryOrder.orderCode} của khách ${primaryOrder.customerName} đề xuất giảm ${effectiveDiscountPercent}% (trần cho phép ${allowedMaxDiscountPercent}%).`,
            resourceType: NotificationResourceTypeEnum.POS_ORDER,
            resourceId: primaryOrder.id,
            dedupeKey: `pos_disc_req:${primaryOrder.id}`,
            metadata: {
              orderId: primaryOrder.id,
              orderCode: primaryOrder.orderCode,
              discountPercent: effectiveDiscountPercent,
              allowedMaxDiscountPercent,
              conversationId: dto.conversationId,
            },
          })
          .catch(() => null);
      }

      if (dto.conversationId) {
        this.realtimeEmitter.emitToConversation(
          SOCKET_CONFIG.namespaces.CHAT,
          dto.conversationId,
          SOCKET_CONFIG.events.POS_OMS.DISCOUNT_APPROVAL_REQUESTED,
          {
            shopId,
            conversationId: dto.conversationId,
            orderId: primaryOrder.id,
            orderCode: primaryOrder.orderCode,
            discountPercent: effectiveDiscountPercent,
            allowedMaxDiscountPercent,
          },
        );
      }
    }

    if (customer && pointsRedeemed > 0) {
      await this.rfmAndLoyaltyService
        .adjustCustomerWalletOrPoints({
          shopId,
          customerId: customer.id,
          actorUserId,
          dto: {
            ledgerType: CustomerWalletLedgerTypeEnum.LOYALTY_POINT,
            transactionType: CustomerWalletTransactionTypeEnum.REDEEM_ON_ORDER,
            deltaAmount: -pointsRedeemed,
            referenceOrderId: primaryOrder.orderCode,
            note: `Đổi ${pointsRedeemed} điểm thưởng trừ vào đơn hàng ${primaryOrder.orderCode}`,
          },
        })
        .catch(() => null);
    }

    if (customer && walletApplied > 0) {
      await this.rfmAndLoyaltyService
        .adjustCustomerWalletOrPoints({
          shopId,
          customerId: customer.id,
          actorUserId,
          dto: {
            ledgerType: CustomerWalletLedgerTypeEnum.WALLET_CREDIT,
            transactionType: CustomerWalletTransactionTypeEnum.REDEEM_ON_ORDER,
            deltaAmount: -walletApplied,
            referenceOrderId: primaryOrder.orderCode,
            note: `Sử dụng Ví tiền thừa (-${walletApplied.toLocaleString('vi-VN')}đ) thanh toán đơn ${primaryOrder.orderCode}`,
          },
        })
        .catch(() => null);
    }

    if (dto.conversationId) {
      await this.adsConversionSyncService
        .dispatchConversionEvent(shopId, {
          platform: AdsConversionPlatformEnum.META_CAPI,
          eventName:
            primaryOrder.status === PosOrderStatusEnum.CONFIRMED ||
            primaryOrder.status === PosOrderStatusEnum.DELIVERED_RECONCILED
              ? AdsConversionEventNameEnum.PURCHASE
              : AdsConversionEventNameEnum.INITIATE_CHECKOUT,
          conversationId: dto.conversationId,
          customerId: customer?.id,
          orderId: primaryOrder.orderCode,
          valueAmount: primaryOrder.totalPayableAmount,
          currency: 'VND',
        })
        .catch(() => null);
    }

    return {
      primaryOrder,
      splitChildOrders,
      mergeableDuplicateOrders,
      requiresManagerDiscountApproval,
      allowedMaxDiscountPercent,
    };
  }

  /**
   * F06.5: Gộp đơn trùng khách 1 chạm (`Merge Duplicate Orders`)
   */
  public async mergeDuplicateOrdersOneClick(params: {
    shopId: string;
    actorUserId: string;
    dto: MergeDuplicatePosOrdersDto;
  }): Promise<PosOrderEntity> {
    const { shopId, actorUserId, dto } = params;
    const [primaryOrder, catalogConfig] = await Promise.all([
      this.orderRepo.findOne({
        where: { id: dto.targetPrimaryOrderId, shopId },
      }),
      this.catalogService.getShopCatalogAndPosConfig(shopId),
    ]);
    if (!primaryOrder) {
      throw new NotFoundException('PRIMARY_POS_ORDER_NOT_FOUND');
    }

    const mergedLines = [...(primaryOrder.itemsJson || [])];
    const mergedFromIds = new Set<string>(primaryOrder.mergedFromOrderIdsJson || []);

    if (dto.sourceDuplicateOrderId && dto.sourceDuplicateOrderId !== primaryOrder.id) {
      const dupOrder = await this.orderRepo.findOne({
        where: { id: dto.sourceDuplicateOrderId, shopId },
      });
      if (dupOrder) {
        for (const dupLine of dupOrder.itemsJson || []) {
          const existingLine = mergedLines.find(
            (l) => l.variantId === dupLine.variantId && !l.isFreeGift,
          );
          if (existingLine) {
            existingLine.quantity += dupLine.quantity;
            existingLine.lineTotalAmount = existingLine.finalUnitPrice * existingLine.quantity;
            existingLine.weightGrams += dupLine.weightGrams;
          } else {
            mergedLines.push(dupLine);
          }
        }
        mergedFromIds.add(dupOrder.orderCode);
        dupOrder.status = PosOrderStatusEnum.CANCELLED;
        dupOrder.note = `Đã gộp vào đơn chính ${primaryOrder.orderCode}`;
        await this.orderRepo.save(dupOrder);
      }
    }

    if (Array.isArray(dto.additionalCartItems) && dto.additionalCartItems.length > 0) {
      for (const addItem of dto.additionalCartItems) {
        const variant = await this.variantRepo.findOne({
          where: { id: addItem.variantId, shopId },
        });
        if (!variant) continue;
        const qty = Math.max(1, Number(addItem.quantity || 1));
        const retail = Number(variant.retailPrice || 0);
        const discPct = Math.max(0, Number(addItem.discountPercent || 0));
        const discAmt = Math.round((retail * discPct) / 100);
        const finalPrice = Math.max(0, retail - discAmt);

        await this.inventoryService.reserveStockAtomicWithRedisLua({
          shopId,
          actorUserId,
          dto: {
            draftCartId: `merge_${primaryOrder.orderCode}`,
            warehouseId: primaryOrder.warehouseId,
            variantId: variant.id,
            quantity: qty,
            conversationId: primaryOrder.conversationId || undefined,
          },
        });

        const existingLine = mergedLines.find((l) => l.variantId === variant.id && !l.isFreeGift);
        if (existingLine) {
          existingLine.quantity += qty;
          existingLine.lineTotalAmount = existingLine.finalUnitPrice * existingLine.quantity;
          existingLine.weightGrams += Number(variant.weightGrams || 300) * qty;
        } else {
          mergedLines.push({
            variantId: variant.id,
            productId: variant.productId,
            skuCode: variant.skuCode,
            barcode: variant.barcode,
            variantName: variant.variantName,
            imageUrl: variant.imageUrl,
            quantity: qty,
            retailPrice: retail,
            discountPercent: discPct,
            discountAmount: discAmt * qty,
            finalUnitPrice: finalPrice,
            lineTotalAmount: finalPrice * qty,
            costPrice: Number(variant.costPrice || 0),
            weightGrams: Number(variant.weightGrams || 300) * qty,
            isBundleBom: variant.isBundleBom,
            isFreeGift: false,
            warehouseId: primaryOrder.warehouseId,
            warehouseName: primaryOrder.warehouseName,
          });
        }
      }
    }

    const nextSubtotal = mergedLines.reduce((s, l) => s + l.retailPrice * l.quantity, 0);
    const nextDiscount = mergedLines.reduce((s, l) => s + l.discountAmount, 0);
    const nextWeight = mergedLines.reduce((s, l) => s + l.weightGrams, 0);
    const nextCogs = mergedLines.reduce((s, l) => s + l.costPrice * l.quantity, 0);
    const shipCharge = primaryOrder.isFreeShippingForCustomer
      ? 0
      : Number(primaryOrder.shippingFeeAmount || 0);
    const nextPayable = Math.max(
      0,
      nextSubtotal -
        nextDiscount +
        shipCharge -
        Number(primaryOrder.loyaltyPointsRedeemed || 0) * 1000 -
        Number(primaryOrder.walletCreditAppliedAmount || 0),
    );

    const bankCfg = catalogConfig.vietQrBankConfig;
    primaryOrder.itemsJson = mergedLines;
    primaryOrder.mergedFromOrderIdsJson = Array.from(mergedFromIds);
    primaryOrder.totalWeightGrams = nextWeight;
    primaryOrder.subtotalAmount = nextSubtotal;
    primaryOrder.discountAmount = nextDiscount;
    primaryOrder.totalPayableAmount = nextPayable;
    primaryOrder.codCollectAmount = Math.max(
      0,
      nextPayable - Number(primaryOrder.paidTransferAmount || 0),
    );
    primaryOrder.cogsSnapshotAmount = nextCogs;
    primaryOrder.estimatedNetProfitAmount =
      nextPayable - nextCogs - Number(primaryOrder.shippingFeeAmount || 0);
    primaryOrder.vietqrPayloadJson = this.vietQrService.buildDynamicVietQrPayload({
      orderCode: primaryOrder.orderCode,
      amountVnd: primaryOrder.codCollectAmount || nextPayable,
      bankBin: bankCfg?.bankBin,
      bankShortName: bankCfg?.bankShortName,
      accountNumber: bankCfg?.accountNumber,
      accountName: bankCfg?.accountName,
      transferPrefix: bankCfg?.transferPrefix,
    });

    return this.orderRepo.save(primaryOrder);
  }

  /**
   * F06.3: Quản lý phê duyệt hoặc từ chối giảm giá vượt trần 1 chạm (`One-Click Manager Discount Approval`)
   */
  public async resolveDiscountApprovalOneClick(params: {
    shopId: string;
    orderId: string;
    actorUserId: string;
    dto: ResolveDiscountApprovalDto;
  }): Promise<PosOrderEntity> {
    const { shopId, orderId, actorUserId, dto } = params;
    const order = await this.orderRepo.findOne({ where: { id: orderId, shopId } });
    if (!order) {
      throw new NotFoundException('POS_ORDER_NOT_FOUND');
    }

    if (dto.approved) {
      order.discountApprovalStatus = DiscountApprovalStatusEnum.APPROVED;
      order.discountApprovedByUserId = actorUserId;
      order.status =
        Number(order.depositRequiredAmount || 0) > Number(order.paidTransferAmount || 0)
          ? PosOrderStatusEnum.WAITING_DEPOSIT
          : PosOrderStatusEnum.CONFIRMED;
    } else {
      order.discountApprovalStatus = DiscountApprovalStatusEnum.REJECTED;
      order.discountApprovedByUserId = actorUserId;
      order.status = PosOrderStatusEnum.DRAFT;
    }

    if (dto.managerNote) {
      order.discountApprovalReason = [order.discountApprovalReason, dto.managerNote]
        .filter(Boolean)
        .join(' | ');
    }

    const saved = await this.orderRepo.save(order);

    await this.piiVaultService.recordSecurityAuditLog({
      shopId,
      actorUserId,
      actionCode: SecurityAuditActionCodeEnum.OVERRIDE_DISCOUNT,
      targetResourceType: 'POS_ORDER',
      targetResourceId: saved.id,
      afterSnapshotJson: {
        orderCode: saved.orderCode,
        approved: dto.approved,
        discountPercent: saved.discountPercent,
        discountAmount: saved.discountAmount,
        totalPayableAmount: saved.totalPayableAmount,
        managerNote: dto.managerNote || null,
      },
    });

    if (saved.conversationId) {
      this.realtimeEmitter.emitToConversation(
        SOCKET_CONFIG.namespaces.CHAT,
        saved.conversationId,
        SOCKET_CONFIG.events.POS_OMS.DISCOUNT_APPROVAL_RESOLVED,
        {
          shopId,
          conversationId: saved.conversationId,
          orderId: saved.id,
          orderCode: saved.orderCode,
          approved: dto.approved,
          status: saved.status,
          discountApprovalStatus: saved.discountApprovalStatus,
        },
      );
    }

    return saved;
  }

  public async listPosOrders(
    shopId: string,
    query: PosOrderListQueryDto,
  ): Promise<PosOrderEntity[]> {
    const qb = this.orderRepo.createQueryBuilder('o').where('o.shop_id = :shopId', { shopId });

    if (query.status) {
      qb.andWhere('o.status = :status', { status: query.status });
    }
    if (query.conversationId) {
      qb.andWhere('o.conversation_id = :conversationId', {
        conversationId: query.conversationId,
      });
    }
    if (query.customerId) {
      qb.andWhere('o.customer_id = :customerId', { customerId: query.customerId });
    }
    if (query.search && query.search.trim()) {
      qb.andWhere('(o.order_code LIKE :q OR o.customer_name LIKE :q)', {
        q: `%${query.search.trim()}%`,
      });
    }

    return qb.orderBy('o.createdAt', 'DESC').take(50).getMany();
  }
}
