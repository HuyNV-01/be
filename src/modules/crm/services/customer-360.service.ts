import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import * as crypto from 'crypto';
import {
  AdsConversionEventNameEnum,
  AdsConversionPlatformEnum,
  ChannelTypeEnum,
  CustomerTierEnum,
  PhoneTrustLookupSourceEnum,
  RfmSegmentCodeEnum,
  SecurityAuditActionCodeEnum,
  ShopBusinessCategoryEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  CustomerListQueryDto,
  ExportCustomersAuditDto,
  LookupPhoneTrustFromSourcesDto,
  MergeCustomerProfilesDto,
  OverrideDeliveryTrustScoreDto,
  ReportCustomerPhoneAbuseDto,
  ToggleCustomerBlacklistDto,
  UpdateShopCrmConfigDto,
  UpsertCustomerProfileDto,
} from 'src/dto/crm/crm.dto';
import { ConversationEntity } from 'src/entity/conversation.entity';
import {
  CustomerAbuseReportItem,
  CustomerCustomAttributeItem,
  CustomerProfileEntity,
  LinkedExternalIdentityItem,
} from 'src/entity/customer-profile.entity';
import { CustomerWalletLedgerEntity } from 'src/entity/customer-wallet-ledger.entity';
import {
  ExtractedCommerceEntitiesPayload,
  ExtractedPhoneTrustSummary,
  MessageDirectionEnum,
  MessageEntity,
} from 'src/entity/message.entity';
import { CrmTrustAndIndustryConfig, ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { MessageCryptoService } from 'src/modules/chat/services/message-crypto.service';
import { Repository } from 'typeorm';

import { AdsConversionSyncService } from './ads-conversion-sync.service';
import { CustomerRfmAndLoyaltyService } from './customer-rfm-and-loyalty.service';
import {
  DeliveryTrustEvaluationResult,
  DeliveryTrustScoreService,
} from './delivery-trust-score.service';
import { PiiVaultAndAuditService } from './pii-vault-and-audit.service';
import { VietnameseCommerceNerService } from './vietnamese-commerce-ner.service';

export const DEFAULT_INDUSTRY_ATTRIBUTE_TEMPLATES: Record<
  ShopBusinessCategoryEnum,
  Array<{ key: string; label: string; placeholder: string }>
> = {
  [ShopBusinessCategoryEnum.GENERAL_MULTI_CATEGORY]: [
    {
      key: 'preferred_product',
      label: 'Nhóm sản phẩm quan tâm',
      placeholder: 'VD: Gia dụng thông minh',
    },
    {
      key: 'delivery_time_window',
      label: 'Khung giờ nhận hàng',
      placeholder: 'VD: Giờ hành chính 9h-17h',
    },
  ],
  [ShopBusinessCategoryEnum.FASHION_APPAREL]: [
    {
      key: 'style_preference',
      label: 'Phong cách yêu thích',
      placeholder: 'VD: Công sở thanh lịch, màu pastel',
    },
    { key: 'shoe_size', label: 'Cỡ giày dép', placeholder: 'VD: Size 37' },
  ],
  [ShopBusinessCategoryEnum.COSMETICS_BEAUTY]: [
    { key: 'skin_type', label: 'Loại da', placeholder: 'VD: Da hỗn hợp thiên dầu / Nhạy cảm' },
    {
      key: 'skin_concern',
      label: 'Tình trạng quan tâm',
      placeholder: 'VD: Mụn ẩn, dưỡng sáng, cấp ẩm',
    },
    {
      key: 'allergy_history',
      label: 'Tiền sử kích ứng',
      placeholder: 'VD: Dị ứng cồn khô / hương liệu',
    },
  ],
  [ShopBusinessCategoryEnum.ELECTRONICS_TECH]: [
    {
      key: 'device_model',
      label: 'Thiết bị / Hệ sinh thái đang dùng',
      placeholder: 'VD: iPhone 16 Pro Max / MacBook',
    },
    {
      key: 'serial_imei',
      label: 'Serial / IMEI bảo hành gần nhất',
      placeholder: 'VD: SN-882910293',
    },
    {
      key: 'warranty_tier',
      label: 'Chế độ bảo hành',
      placeholder: 'VD: Bảo hành 1 đổi 1 12 tháng',
    },
  ],
  [ShopBusinessCategoryEnum.FOOD_BEVERAGE]: [
    {
      key: 'taste_preference',
      label: 'Khẩu vị yêu thích',
      placeholder: 'VD: Ít ngọt, cay vừa, không hành',
    },
    {
      key: 'food_allergy',
      label: 'Lưu ý dị ứng thực phẩm',
      placeholder: 'VD: Dị ứng hải sản / đậu phộng',
    },
  ],
  [ShopBusinessCategoryEnum.MOTHER_AND_BABY]: [
    { key: 'baby_age_months', label: 'Tháng tuổi của bé', placeholder: 'VD: Bé 14 tháng tuổi' },
    {
      key: 'diaper_milk_brand',
      label: 'Dòng bỉm / sữa đang dùng',
      placeholder: 'VD: Bỉm dán size L, sữa số 2',
    },
  ],
};

@Injectable()
export class Customer360Service {
  private readonly logger = new Logger(Customer360Service.name);

  constructor(
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(CustomerWalletLedgerEntity)
    private readonly walletLedgerRepo: Repository<CustomerWalletLedgerEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(MessageEntity)
    private readonly messageRepo: Repository<MessageEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    private readonly nerService: VietnameseCommerceNerService,
    private readonly trustScoreService: DeliveryTrustScoreService,
    private readonly piiVaultService: PiiVaultAndAuditService,
    private readonly rfmService: CustomerRfmAndLoyaltyService,
    private readonly adsConversionSyncService: AdsConversionSyncService,
    private readonly messageCryptoService: MessageCryptoService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private generateCustomerCode(): string {
    const suffix = String(Date.now()).slice(-6);
    const rand = Math.floor(100 + Math.random() * 900);
    return `KH-${suffix}-${rand}`;
  }

  private decryptCustomLookupApiKeyInRam(
    shopId: string,
    encryptedKey?: string | null,
  ): string | null {
    if (!encryptedKey) return null;
    return (
      this.messageCryptoService.decryptForConversation(encryptedKey, `pii_vault:${shopId}`) || null
    );
  }

  /**
   * Lấy cấu hình Nguồn dữ liệu Tra cứu Uy tín SĐT (Nhận / Hoàn / Bị báo cáo) & Cấu hình Ngành hàng của Cửa hàng
   */
  public async getShopCrmTrustAndIndustryConfig(shopId: string): Promise<
    CrmTrustAndIndustryConfig & {
      requireDepositOnHighRisk: boolean;
      hasCustomLookupApiKey: boolean;
    }
  > {
    const shop = await this.shopRepo.findOne({ where: { id: shopId } });
    const raw = shop?.crmTrustAndIndustryConfigJson;
    const category = raw?.businessCategory || ShopBusinessCategoryEnum.GENERAL_MULTI_CATEGORY;

    return {
      enableAutoTrustLookupOnPhone: raw?.enableAutoTrustLookupOnPhone ?? true,
      useInternalPosHistory: raw?.useInternalPosHistory ?? true,
      usePancakeCommunityNetwork: raw?.usePancakeCommunityNetwork ?? true,
      useCarrier3plLookup: raw?.useCarrier3plLookup ?? true,
      enabledCarriers:
        Array.isArray(raw?.enabledCarriers) && raw.enabledCarriers.length > 0
          ? raw.enabledCarriers
          : ['GHN', 'GHTK', 'VTP', 'JT'],
      customLookupWebhookUrl: raw?.customLookupWebhookUrl || null,
      customLookupApiKeyEncrypted: raw?.customLookupApiKeyEncrypted || null,
      hasCustomLookupApiKey: Boolean(raw?.customLookupApiKeyEncrypted),
      highRiskReturnRateThresholdPercent: Number(raw?.highRiskReturnRateThresholdPercent ?? 30),
      highRiskReportedCountThreshold: Number(raw?.highRiskReportedCountThreshold ?? 1),
      autoMaskBuyerPhoneInChat: raw?.autoMaskBuyerPhoneInChat ?? true,
      autoExtractAddressFromChat: raw?.autoExtractAddressFromChat ?? true,
      businessCategory: category,
      showApparelMeasurementsInProfile:
        raw?.showApparelMeasurementsInProfile ??
        category === ShopBusinessCategoryEnum.FASHION_APPAREL,
      customAttributeTemplates:
        Array.isArray(raw?.customAttributeTemplates) && raw.customAttributeTemplates.length > 0
          ? raw.customAttributeTemplates
          : DEFAULT_INDUSTRY_ATTRIBUTE_TEMPLATES[category] || [],
      requireDepositOnHighRisk: shop?.requireDepositOnHighRisk ?? true,
      updatedAt: raw?.updatedAt || new Date().toISOString(),
    };
  }

  /**
   * Cập nhật cấu hình Nguồn dữ liệu Tra cứu Uy tín SĐT & Cấu hình Ngành hàng Cửa hàng
   */
  public async updateShopCrmTrustAndIndustryConfig(params: {
    shopId: string;
    actorUserId: string;
    dto: UpdateShopCrmConfigDto;
  }): Promise<
    CrmTrustAndIndustryConfig & {
      requireDepositOnHighRisk: boolean;
      hasCustomLookupApiKey: boolean;
    }
  > {
    const shop = await this.shopRepo.findOne({ where: { id: params.shopId } });
    if (!shop) {
      throw new NotFoundException('SHOP_WORKSPACE_NOT_FOUND');
    }

    const current = await this.getShopCrmTrustAndIndustryConfig(params.shopId);
    const nextCategory = params.dto.businessCategory ?? current.businessCategory;
    const categoryChanged =
      params.dto.businessCategory !== undefined &&
      params.dto.businessCategory !== current.businessCategory;

    const encryptedCustomApiKey =
      params.dto.customLookupApiKey && params.dto.customLookupApiKey.trim()
        ? this.messageCryptoService.encryptForConversation(
            params.dto.customLookupApiKey.trim(),
            `pii_vault:${params.shopId}`,
          ).ciphertext
        : current.customLookupApiKeyEncrypted || null;

    const nextConfig: CrmTrustAndIndustryConfig = {
      enableAutoTrustLookupOnPhone:
        params.dto.enableAutoTrustLookupOnPhone ?? current.enableAutoTrustLookupOnPhone,
      useInternalPosHistory: params.dto.useInternalPosHistory ?? current.useInternalPosHistory,
      usePancakeCommunityNetwork:
        params.dto.usePancakeCommunityNetwork ??
        params.dto.enableCommunityTrustLookup ??
        current.usePancakeCommunityNetwork,
      useCarrier3plLookup:
        params.dto.useCarrier3plLookup ??
        params.dto.enableCarrier3plTrustLookup ??
        current.useCarrier3plLookup,
      enabledCarriers: params.dto.enabledCarriers ?? current.enabledCarriers,
      customLookupWebhookUrl:
        params.dto.customLookupWebhookUrl !== undefined
          ? params.dto.customLookupWebhookUrl?.trim() || null
          : current.customLookupWebhookUrl,
      customLookupApiKeyEncrypted: encryptedCustomApiKey,
      highRiskReturnRateThresholdPercent:
        params.dto.highRiskReturnRateThresholdPercent ?? current.highRiskReturnRateThresholdPercent,
      highRiskReportedCountThreshold:
        params.dto.highRiskReportedCountThreshold ?? current.highRiskReportedCountThreshold,
      autoMaskBuyerPhoneInChat:
        params.dto.autoMaskBuyerPhoneInChat ??
        params.dto.autoMaskPhoneInChatMessages ??
        current.autoMaskBuyerPhoneInChat,
      autoExtractAddressFromChat:
        params.dto.autoExtractAddressFromChat ??
        params.dto.autoExtractPhoneAndAddressInChat ??
        current.autoExtractAddressFromChat,
      businessCategory: nextCategory,
      showApparelMeasurementsInProfile:
        params.dto.showApparelMeasurementsInProfile !== undefined
          ? params.dto.showApparelMeasurementsInProfile
          : categoryChanged
            ? nextCategory === ShopBusinessCategoryEnum.FASHION_APPAREL
            : current.showApparelMeasurementsInProfile,
      customAttributeTemplates:
        params.dto.customAttributeTemplates !== undefined
          ? params.dto.customAttributeTemplates
          : categoryChanged
            ? DEFAULT_INDUSTRY_ATTRIBUTE_TEMPLATES[nextCategory] || []
            : current.customAttributeTemplates,
      updatedAt: new Date().toISOString(),
    };

    shop.crmTrustAndIndustryConfigJson = nextConfig;
    if (params.dto.requireDepositOnHighRisk !== undefined) {
      shop.requireDepositOnHighRisk = params.dto.requireDepositOnHighRisk;
    }
    await this.shopRepo.save(shop);

    await this.piiVaultService.recordSecurityAuditLog({
      shopId: params.shopId,
      actorUserId: params.actorUserId,
      actionCode: SecurityAuditActionCodeEnum.CRM_SETTINGS_UPDATE,
      targetResourceType: 'SHOP_CRM_CONFIG',
      targetResourceId: params.shopId,
      afterSnapshotJson: {
        businessCategory: nextConfig.businessCategory,
        usePancakeCommunityNetwork: nextConfig.usePancakeCommunityNetwork,
        useCarrier3plLookup: nextConfig.useCarrier3plLookup,
        hasCustomLookupApiKey: Boolean(encryptedCustomApiKey),
        requireDepositOnHighRisk: shop.requireDepositOnHighRisk,
      },
    });

    return {
      ...nextConfig,
      requireDepositOnHighRisk: shop.requireDepositOnHighRisk,
      hasCustomLookupApiKey: Boolean(encryptedCustomApiKey),
    };
  }

  /**
   * Làm giàu đối tượng `CustomerProfileEntity` với kết quả đánh giá Điểm uy tín nhận hàng (`trustEvaluation`)
   * và đảm bảo ẩn vĩnh viễn `phoneEncrypted` / `phoneSearchHash`.
   */
  public enrichCustomerWithTrustEvaluation(
    customer: CustomerProfileEntity,
    shopRequireDepositOnHighRisk = true,
    crmConfig?: Partial<CrmTrustAndIndustryConfig> | null,
  ): CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult } {
    const trustEvaluation = this.trustScoreService.evaluateCustomerTrustScore({
      successfulDeliveriesCount: customer.successfulDeliveriesCount,
      returnedOrdersCount: customer.returnedOrdersCount,
      networkDeliveredCount: customer.networkDeliveredCount,
      networkReturnedCount: customer.networkReturnedCount,
      reportedCount: customer.reportedCount,
      reportedReasons: customer.reportedReasonsJson,
      isBlacklisted: customer.isBlacklisted,
      shopRequireDepositOnHighRisk,
      highRiskReturnRateThresholdPercent: crmConfig?.highRiskReturnRateThresholdPercent,
      highRiskReportedCountThreshold: crmConfig?.highRiskReportedCountThreshold,
      lookupSource: customer.trustLookupSource,
      enabledCarriers: crmConfig?.enabledCarriers,
      checkedAt: customer.lastTrustLookupAt || customer.updatedAt,
    });

    const clone = { ...customer } as CustomerProfileEntity & {
      trustEvaluation: DeliveryTrustEvaluationResult;
    };
    delete (clone as any).phoneEncrypted;
    delete (clone as any).phoneSearchHash;
    clone.trustEvaluation = trustEvaluation;
    return clone;
  }

  public buildPhoneTrustSummaryForMessage(
    enrichedCustomer: CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult },
    carrierName?: string,
  ): ExtractedPhoneTrustSummary {
    const trust = enrichedCustomer.trustEvaluation;
    return {
      customerId: enrichedCustomer.id,
      phoneMasked: enrichedCustomer.phoneMasked || '098***678',
      carrierName: carrierName || 'VN Telecom',
      score: trust.score,
      band: trust.band,
      badgeVariant: trust.badgeVariant,
      headline: trust.headline,
      recommendation: trust.recommendation,
      totalDeliveredCount: trust.totalDeliveredCount,
      shopDeliveredCount: trust.shopDeliveredCount,
      networkDeliveredCount: trust.networkDeliveredCount,
      totalReturnedCount: trust.totalReturnedCount,
      shopReturnedCount: trust.shopReturnedCount,
      networkReturnedCount: trust.networkReturnedCount,
      reportedCount: trust.reportedCount,
      returnRatePercent: trust.returnRatePercent,
      successRatePercent: trust.successRatePercent,
      requireDepositVietQr: trust.requireDepositVietQr,
      isBlacklisted: enrichedCustomer.isBlacklisted,
      lookupSource: trust.lookupSource,
      lookupSourceLabel: trust.lookupSourceLabel,
      latestReportReason:
        trust.reportedReasons?.[0]?.reason || enrichedCustomer.blacklistReason || null,
      checkedAt: trust.checkedAt,
    };
  }

  /**
   * F04.1, F04.2, F04.3, F04.5 & F11.1:
   * Tự động nhận diện và hợp nhất Hồ sơ Khách hàng Đa kênh ngay khi khách hàng nhắn tin / bình luận:
   * 1. Nếu bóc tách được SĐT hợp lệ từ tin nhắn (`extractedNer.phones[0]`):
   *    - Tính `phoneSearchHash = HMAC-SHA256(normalizedPhone, SHOP_PII_SALT)`.
   *    - Tìm hồ sơ khách hàng đã tồn tại theo `(shopId, phoneSearchHash)` trên mọi kênh.
   *    - Tự động tra cứu chỉ số Nhận / Hoàn / Bị báo cáo từ nguồn dữ liệu đã cài đặt (`lookupPhoneReputationFromSources`).
   * 2. Nếu tin nhắn chỉ chứa Địa chỉ (không chứa SĐT):
   *    - Tìm theo `conversation.customerId` hoặc `externalUserId` và tự động cập nhật ngay Địa chỉ 3 cấp / `defaultAddressLine` vào hồ sơ khách hàng!
   * 3. Nếu cuộc hội thoại đến từ Quảng cáo (`sourceAdId` / `ctwaClickId`) và vừa thu thập được SĐT mới:
   *    - Tự động bắn sự kiện `LeadSubmitted` (`QualifiedLead`) lên Meta CAPI!
   */
  public async resolveOrUpsertCustomerFromOmnichannelEvent(params: {
    shopId: string;
    conversation: ConversationEntity;
    channelType: ChannelTypeEnum;
    channelIntegrationId: string | null;
    pageShortCode?: string | null;
    pageName?: string | null;
    externalUserId?: string | null;
    customerName: string;
    customerAvatarUrl?: string | null;
    extractedNer: ExtractedCommerceEntitiesPayload;
  }): Promise<{
    customer: CustomerProfileEntity;
    enrichedCustomer: CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult };
    phoneTrustSummary: ExtractedPhoneTrustSummary | null;
    isNewlyCollectedPhone: boolean;
  }> {
    const {
      shopId,
      conversation,
      channelType,
      channelIntegrationId,
      pageShortCode,
      pageName,
      externalUserId,
      customerName,
      customerAvatarUrl,
      extractedNer,
    } = params;

    const crmConfig = await this.getShopCrmTrustAndIndustryConfig(shopId);
    const firstExtractedPhone =
      extractedNer.normalizedPhones?.[0]?.localPhone ||
      extractedNer.phones?.find((p) => !p.includes('*')) ||
      null;
    const firstCarrierName = extractedNer.normalizedPhones?.[0]?.carrierName || 'VN Telecom';

    const encryptedPhonePack = firstExtractedPhone
      ? this.piiVaultService.encryptRawPhoneForShop(shopId, firstExtractedPhone)
      : null;

    let customer: CustomerProfileEntity | null = null;

    // 1. Ưu tiên hợp nhất theo Chỉ mục mù SĐT (`phoneSearchHash`) xuyên suốt mọi kênh
    if (encryptedPhonePack) {
      customer = await this.customerRepo.findOne({
        where: {
          shopId,
          phoneSearchHash: encryptedPhonePack.phoneSearchHash,
        },
      });
    }

    // 2. Nếu cuộc hội thoại đã gắn sẵn customerId
    if (!customer && conversation.customerId) {
      customer = await this.customerRepo.findOne({
        where: { id: conversation.customerId, shopId },
      });
    }

    // 3. Tra cứu tự động chỉ số Nhận / Hoàn / Bị báo cáo từ nguồn dữ liệu (Pancake Community + 3PL GHN/GHTK + Custom API)
    const decryptedCustomKey = this.decryptCustomLookupApiKeyInRam(
      shopId,
      crmConfig.customLookupApiKeyEncrypted,
    );
    const externalTrustLookup =
      firstExtractedPhone && crmConfig.enableAutoTrustLookupOnPhone !== false
        ? await this.trustScoreService.lookupPhoneReputationFromSources({
            rawPhone: firstExtractedPhone,
            config: crmConfig,
            decryptedCustomApiKey: decryptedCustomKey,
          })
        : null;

    const now = new Date();
    const nowIso = now.toISOString();
    let isNewlyCollectedPhone = false;

    if (!customer) {
      isNewlyCollectedPhone = Boolean(encryptedPhonePack);
      customer = this.customerRepo.create({
        shopId,
        code: this.generateCustomerCode(),
        fullName: customerName || 'Khách hàng mới',
        avatarUrl: customerAvatarUrl || conversation.avatar || null,
        phoneMasked: encryptedPhonePack?.phoneMasked || null,
        phoneEncrypted: encryptedPhonePack?.phoneEncrypted || null,
        phoneSearchHash: encryptedPhonePack?.phoneSearchHash || null,
        defaultProvinceCode: extractedNer.provinceCode || null,
        defaultProvinceName: extractedNer.provinceName || null,
        defaultDistrictCode: extractedNer.districtCode || null,
        defaultDistrictName: extractedNer.districtName || null,
        defaultWardCode: extractedNer.wardCode || null,
        defaultWardName: extractedNer.wardName || null,
        defaultAddressLine: extractedNer.addressLine || extractedNer.fullFormattedAddress || null,
        tier: CustomerTierEnum.NEW,
        rfmScoreR: 3,
        rfmScoreF: 1,
        rfmScoreM: 1,
        rfmSegmentCode: RfmSegmentCodeEnum.NEW_CUSTOMERS,
        totalOrdersCount: 0,
        successfulDeliveriesCount: 0,
        returnedOrdersCount: 0,
        networkDeliveredCount: externalTrustLookup?.networkDeliveredCount || 0,
        networkReturnedCount: externalTrustLookup?.networkReturnedCount || 0,
        reportedCount: externalTrustLookup?.reportedCount || 0,
        reportedReasonsJson: externalTrustLookup?.reportedReasons || [],
        trustLookupSource:
          externalTrustLookup?.lookupSource || PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE,
        lastTrustLookupAt: externalTrustLookup ? now : null,
        deliveryTrustScore: 80,
        isBlacklisted: false,
        lifetimeValueAmount: 0,
        loyaltyPointsBalance: 0,
        walletCreditBalance: 0,
        industryCategory: crmConfig.businessCategory,
        heightCm: extractedNer.heightCm || null,
        weightKg: extractedNer.weightKg || null,
        preferredSize: extractedNer.sizes?.[0] || null,
        customAttributesJson: [],
        notes: extractedNer.deliveryTimeNote || null,
        linkedExternalIdentitiesJson: externalUserId
          ? [
              {
                channelType,
                channelIntegrationId,
                pageShortCode: pageShortCode || null,
                pageName: pageName || null,
                externalUserId,
                externalUsername: customerName,
                avatarUrl: customerAvatarUrl || null,
                firstSeenAt: nowIso,
                lastSeenAt: nowIso,
              },
            ]
          : [],
        activeTagIdsJson: conversation.activeTagIdsJson || [],
        recentOrdersSnapshotJson: [],
      });
    } else {
      if (encryptedPhonePack && !customer.phoneSearchHash) {
        isNewlyCollectedPhone = true;
      }
      if (encryptedPhonePack) {
        customer.phoneMasked = encryptedPhonePack.phoneMasked;
        customer.phoneEncrypted = encryptedPhonePack.phoneEncrypted;
        customer.phoneSearchHash = encryptedPhonePack.phoneSearchHash;
      }
      if (externalTrustLookup) {
        customer.networkDeliveredCount = Math.max(
          Number(customer.networkDeliveredCount || 0),
          externalTrustLookup.networkDeliveredCount,
        );
        customer.networkReturnedCount = Math.max(
          Number(customer.networkReturnedCount || 0),
          externalTrustLookup.networkReturnedCount,
        );
        if (Number(customer.reportedCount || 0) === 0 && externalTrustLookup.reportedCount > 0) {
          customer.reportedCount = externalTrustLookup.reportedCount;
          customer.reportedReasonsJson = externalTrustLookup.reportedReasons;
        }
        customer.trustLookupSource = externalTrustLookup.lookupSource;
        customer.lastTrustLookupAt = now;
      }
      if (customerName && !customerName.includes('#') && customer.fullName.includes('#')) {
        customer.fullName = customerName;
      }
      if (customerAvatarUrl && !customer.avatarUrl) {
        customer.avatarUrl = customerAvatarUrl;
      }
      if (extractedNer.provinceCode) {
        customer.defaultProvinceCode = extractedNer.provinceCode;
        customer.defaultProvinceName = extractedNer.provinceName || customer.defaultProvinceName;
      }
      if (extractedNer.districtCode) {
        customer.defaultDistrictCode = extractedNer.districtCode;
        customer.defaultDistrictName = extractedNer.districtName || customer.defaultDistrictName;
      }
      if (extractedNer.wardCode) {
        customer.defaultWardCode = extractedNer.wardCode;
        customer.defaultWardName = extractedNer.wardName || customer.defaultWardName;
      }
      if (extractedNer.addressLine || extractedNer.fullFormattedAddress) {
        customer.defaultAddressLine =
          extractedNer.addressLine ||
          extractedNer.fullFormattedAddress ||
          customer.defaultAddressLine;
      }
      if (extractedNer.heightCm) {
        customer.heightCm = extractedNer.heightCm;
      }
      if (extractedNer.weightKg) {
        customer.weightKg = extractedNer.weightKg;
      }
      if (extractedNer.sizes?.[0]) {
        customer.preferredSize = extractedNer.sizes[0];
      }
      if (extractedNer.deliveryTimeNote && !customer.notes) {
        customer.notes = extractedNer.deliveryTimeNote;
      }

      if (externalUserId) {
        const currentIdentities: LinkedExternalIdentityItem[] = Array.isArray(
          customer.linkedExternalIdentitiesJson,
        )
          ? [...customer.linkedExternalIdentitiesJson]
          : [];
        const existingIdx = currentIdentities.findIndex(
          (item) =>
            item.channelType === channelType &&
            item.externalUserId === externalUserId &&
            item.channelIntegrationId === channelIntegrationId,
        );
        if (existingIdx !== -1) {
          currentIdentities[existingIdx] = {
            ...currentIdentities[existingIdx],
            externalUsername: customerName || currentIdentities[existingIdx].externalUsername,
            avatarUrl: customerAvatarUrl || currentIdentities[existingIdx].avatarUrl,
            lastSeenAt: nowIso,
          };
        } else {
          currentIdentities.push({
            channelType,
            channelIntegrationId,
            pageShortCode: pageShortCode || null,
            pageName: pageName || null,
            externalUserId,
            externalUsername: customerName,
            avatarUrl: customerAvatarUrl || null,
            firstSeenAt: nowIso,
            lastSeenAt: nowIso,
          });
        }
        customer.linkedExternalIdentitiesJson = currentIdentities;
      }
    }

    // Cập nhật điểm uy tín tổng hợp vào bản ghi khách hàng trước khi lưu
    const computedEval = this.trustScoreService.evaluateCustomerTrustScore({
      successfulDeliveriesCount: customer.successfulDeliveriesCount,
      returnedOrdersCount: customer.returnedOrdersCount,
      networkDeliveredCount: customer.networkDeliveredCount,
      networkReturnedCount: customer.networkReturnedCount,
      reportedCount: customer.reportedCount,
      reportedReasons: customer.reportedReasonsJson,
      isBlacklisted: customer.isBlacklisted,
      shopRequireDepositOnHighRisk: crmConfig.requireDepositOnHighRisk,
      highRiskReturnRateThresholdPercent: crmConfig.highRiskReturnRateThresholdPercent,
      highRiskReportedCountThreshold: crmConfig.highRiskReportedCountThreshold,
      lookupSource: customer.trustLookupSource,
      enabledCarriers: crmConfig.enabledCarriers,
      checkedAt: customer.lastTrustLookupAt || now,
    });
    customer.deliveryTrustScore = computedEval.score;

    const savedCustomer = await this.customerRepo.save(customer);

    if (conversation.customerId !== savedCustomer.id || isNewlyCollectedPhone) {
      conversation.customerId = savedCustomer.id;
      if (encryptedPhonePack) {
        conversation.hasPhoneCollected = true;
      }
      await this.conversationRepo.update(conversation.id, {
        customerId: savedCustomer.id,
        ...(encryptedPhonePack ? { hasPhoneCollected: true } : {}),
      });
    }

    // Tự động bắn sự kiện LeadSubmitted lên Meta CAPI ngay khi thu thập được SĐT từ hội thoại có gắn Quảng cáo (F11.1)
    if (
      isNewlyCollectedPhone &&
      (conversation.sourceAdId || conversation.ctwaClickId || conversation.sourcePostId)
    ) {
      void this.adsConversionSyncService
        .dispatchConversionEvent(shopId, {
          platform:
            channelType === ChannelTypeEnum.TIKTOK_SHOP
              ? AdsConversionPlatformEnum.TIKTOK_EVENTS
              : AdsConversionPlatformEnum.META_CAPI,
          eventName: AdsConversionEventNameEnum.LEAD_SUBMITTED,
          conversationId: conversation.id,
          customerId: savedCustomer.id,
          channelIntegrationId: channelIntegrationId || undefined,
          ctwaClickId: conversation.ctwaClickId || undefined,
          sourceAdId: conversation.sourceAdId || undefined,
          valueAmount: 0,
          currency: 'VND',
        })
        .catch((err) => {
          this.logger.warn(`Auto CAPI LeadSubmitted warning: ${String(err)}`);
        });
    }

    const enrichedCustomer = this.enrichCustomerWithTrustEvaluation(
      savedCustomer,
      crmConfig.requireDepositOnHighRisk,
      crmConfig,
    );

    const phoneTrustSummary =
      savedCustomer.phoneMasked && (encryptedPhonePack || savedCustomer.phoneSearchHash)
        ? this.buildPhoneTrustSummaryForMessage(enrichedCustomer, firstCarrierName)
        : null;

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      conversation.id,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.CRM_PROFILE_UPDATED,
      {
        conversationId: conversation.id,
        customer: enrichedCustomer,
      },
    );

    return {
      customer: savedCustomer,
      enrichedCustomer,
      phoneTrustSummary,
      isNewlyCollectedPhone,
    };
  }

  /**
   * Tra cứu / Làm mới chỉ số Nhận, Hoàn, Bị báo cáo từ nguồn dữ liệu bên ngoài (Pancake Community + 3PL GHN/GHTK + Custom Webhook)
   */
  public async refreshCustomerTrustLookup(params: {
    shopId: string;
    customerId: string;
    dto?: LookupPhoneTrustFromSourcesDto;
  }): Promise<CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult }> {
    const customer = await this.customerRepo.findOne({
      where: { id: params.customerId, shopId: params.shopId },
    });
    if (!customer) {
      throw new NotFoundException('CUSTOMER_PROFILE_NOT_FOUND');
    }

    const crmConfig = await this.getShopCrmTrustAndIndustryConfig(params.shopId);
    const decryptedPhone =
      params.dto?.rawPhone?.trim() ||
      this.piiVaultService.decryptPhoneInRam(params.shopId, customer.phoneEncrypted) ||
      customer.phoneMasked ||
      '0988123456';

    const decryptedCustomKey = this.decryptCustomLookupApiKeyInRam(
      params.shopId,
      crmConfig.customLookupApiKeyEncrypted,
    );

    const lookupRes = await this.trustScoreService.lookupPhoneReputationFromSources({
      rawPhone: decryptedPhone,
      config: crmConfig,
      decryptedCustomApiKey: decryptedCustomKey,
    });

    customer.networkDeliveredCount = Math.max(
      Number(customer.networkDeliveredCount || 0),
      lookupRes.networkDeliveredCount,
    );
    customer.networkReturnedCount = Math.max(
      Number(customer.networkReturnedCount || 0),
      lookupRes.networkReturnedCount,
    );
    if (lookupRes.reportedCount > Number(customer.reportedCount || 0)) {
      customer.reportedCount = lookupRes.reportedCount;
    }
    const existingReports = Array.isArray(customer.reportedReasonsJson)
      ? customer.reportedReasonsJson
      : [];
    const existingIds = new Set(existingReports.map((r) => r.reportId));
    for (const rep of lookupRes.reportedReasons) {
      if (!existingIds.has(rep.reportId)) {
        existingReports.push(rep);
      }
    }
    customer.reportedReasonsJson = existingReports;
    customer.trustLookupSource = lookupRes.lookupSource;
    customer.lastTrustLookupAt = new Date();

    const evalRes = this.trustScoreService.evaluateCustomerTrustScore({
      successfulDeliveriesCount: customer.successfulDeliveriesCount,
      returnedOrdersCount: customer.returnedOrdersCount,
      networkDeliveredCount: customer.networkDeliveredCount,
      networkReturnedCount: customer.networkReturnedCount,
      reportedCount: customer.reportedCount,
      reportedReasons: customer.reportedReasonsJson,
      isBlacklisted: customer.isBlacklisted,
      shopRequireDepositOnHighRisk: crmConfig.requireDepositOnHighRisk,
      highRiskReturnRateThresholdPercent: crmConfig.highRiskReturnRateThresholdPercent,
      highRiskReportedCountThreshold: crmConfig.highRiskReportedCountThreshold,
      lookupSource: customer.trustLookupSource,
      enabledCarriers: crmConfig.enabledCarriers,
      checkedAt: customer.lastTrustLookupAt,
    });
    customer.deliveryTrustScore = evalRes.score;

    const saved = await this.customerRepo.save(customer);
    const enriched = this.enrichCustomerWithTrustEvaluation(
      saved,
      crmConfig.requireDepositOnHighRisk,
      crmConfig,
    );

    if (params.dto?.conversationId) {
      this.realtimeEmitter.emitToConversation(
        SOCKET_CONFIG.namespaces.CHAT,
        params.dto.conversationId,
        SOCKET_CONFIG.events.OMNICHANNEL_INBOX.CRM_PROFILE_UPDATED,
        {
          conversationId: params.dto.conversationId,
          customer: enriched,
        },
      );
    }

    return enriched;
  }

  /**
   * Báo xấu SĐT khách bom hàng / Ghi nhận lượt bị báo cáo (`reportCustomerPhoneAbuse`)
   */
  public async reportCustomerPhoneAbuse(params: {
    shopId: string;
    customerId: string;
    actorUserId: string;
    dto: ReportCustomerPhoneAbuseDto;
  }): Promise<CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult }> {
    const customer = await this.customerRepo.findOne({
      where: { id: params.customerId, shopId: params.shopId },
    });
    if (!customer) {
      throw new NotFoundException('CUSTOMER_PROFILE_NOT_FOUND');
    }

    const crmConfig = await this.getShopCrmTrustAndIndustryConfig(params.shopId);
    const beforeState = {
      reportedCount: customer.reportedCount,
      returnedOrdersCount: customer.returnedOrdersCount,
      isBlacklisted: customer.isBlacklisted,
      deliveryTrustScore: customer.deliveryTrustScore,
    };

    const resolvedReasonText = (
      params.dto.reason ||
      params.dto.reasonNote ||
      params.dto.reasonCode ||
      'Khách đặt đơn nhưng từ chối nhận hàng (Bom hàng)'
    ).trim();

    const newReport: CustomerAbuseReportItem = {
      reportId: `rep_${crypto.randomBytes(4).toString('hex')}`,
      reason: resolvedReasonText,
      reasonCode: params.dto.reasonCode || 'BOM_HANG',
      reasonNote: resolvedReasonText,
      carrierCode: params.dto.carrierCode || null,
      orderCode: params.dto.orderCode || null,
      source: params.dto.source || 'SHOP_INTERNAL',
      reportedByName: 'Cửa hàng & Cộng đồng Pancake POS',
      reportedAt: new Date().toISOString(),
    };

    const currentReports = Array.isArray(customer.reportedReasonsJson)
      ? [...customer.reportedReasonsJson]
      : [];
    currentReports.unshift(newReport);

    customer.reportedCount = Number(customer.reportedCount || 0) + 1;
    customer.reportedReasonsJson = currentReports;

    if (params.dto.additionalReturnedOrders && params.dto.additionalReturnedOrders > 0) {
      customer.returnedOrdersCount =
        Number(customer.returnedOrdersCount || 0) + params.dto.additionalReturnedOrders;
    }

    const shouldAutoBlacklist = params.dto.markBlacklisted ?? params.dto.autoBlacklist ?? true;
    if (shouldAutoBlacklist && customer.reportedCount >= crmConfig.highRiskReportedCountThreshold) {
      customer.isBlacklisted = true;
      customer.blacklistReason = resolvedReasonText;
      customer.tier = CustomerTierEnum.BLACKLIST;
    }

    const evalRes = this.trustScoreService.evaluateCustomerTrustScore({
      successfulDeliveriesCount: customer.successfulDeliveriesCount,
      returnedOrdersCount: customer.returnedOrdersCount,
      networkDeliveredCount: customer.networkDeliveredCount,
      networkReturnedCount: customer.networkReturnedCount,
      reportedCount: customer.reportedCount,
      reportedReasons: customer.reportedReasonsJson,
      isBlacklisted: customer.isBlacklisted,
      shopRequireDepositOnHighRisk: crmConfig.requireDepositOnHighRisk,
      highRiskReturnRateThresholdPercent: crmConfig.highRiskReturnRateThresholdPercent,
      highRiskReportedCountThreshold: crmConfig.highRiskReportedCountThreshold,
      lookupSource: customer.trustLookupSource,
      enabledCarriers: crmConfig.enabledCarriers,
    });
    customer.deliveryTrustScore = evalRes.score;

    const saved = await this.customerRepo.save(customer);

    await this.piiVaultService.recordSecurityAuditLog({
      shopId: params.shopId,
      actorUserId: params.actorUserId,
      actionCode: SecurityAuditActionCodeEnum.PHONE_ABUSE_REPORT,
      targetResourceType: 'CUSTOMER_PROFILE',
      targetResourceId: customer.id,
      beforeSnapshotJson: beforeState,
      afterSnapshotJson: {
        reportedCount: saved.reportedCount,
        returnedOrdersCount: saved.returnedOrdersCount,
        isBlacklisted: saved.isBlacklisted,
        deliveryTrustScore: saved.deliveryTrustScore,
        reportReason: resolvedReasonText,
      },
    });

    const enriched = this.enrichCustomerWithTrustEvaluation(
      saved,
      crmConfig.requireDepositOnHighRisk,
      crmConfig,
    );

    if (params.dto.conversationId) {
      this.realtimeEmitter.emitToConversation(
        SOCKET_CONFIG.namespaces.CHAT,
        params.dto.conversationId,
        SOCKET_CONFIG.events.OMNICHANNEL_INBOX.CRM_PROFILE_UPDATED,
        {
          conversationId: params.dto.conversationId,
          customer: enriched,
        },
      );
    }

    return enriched;
  }

  /**
   * Ghi nhận kiểm toán bảo mật khi người dùng xuất danh sách khách hàng (`EXPORT_CUSTOMERS`)
   */
  public async recordCustomerExportAudit(params: {
    shopId: string;
    actorUserId: string;
    dto: ExportCustomersAuditDto;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const log = await this.piiVaultService.recordSecurityAuditLog({
      shopId: params.shopId,
      actorUserId: params.actorUserId,
      actionCode: SecurityAuditActionCodeEnum.EXPORT_CUSTOMERS,
      targetResourceType: 'CUSTOMER_DIRECTORY',
      targetResourceId: params.shopId,
      afterSnapshotJson: {
        exportedCount: params.dto.exportedCount ?? 0,
        filterSummary: params.dto.filterSummary || 'ALL',
        piiProtectionMode: 'MASKED_PHONE_ONLY',
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    return {
      auditLogId: log.id,
      entryHmacHash: log.entryHmacHash,
      recordedAt: log.createdAt,
    };
  }

  /**
   * Khởi tạo dữ liệu mẫu chuẩn nghiệp vụ cho cửa hàng mới nếu danh sách khách hàng đang trống
   */
  private async ensureSeededShopCustomersIfEmpty(shopId: string): Promise<void> {
    const count = await this.customerRepo.count({ where: { shopId } });
    if (count > 0) return;

    const now = new Date();
    const pack1 = this.piiVaultService.encryptRawPhoneForShop(shopId, '0988123456');
    const pack2 = this.piiVaultService.encryptRawPhoneForShop(shopId, '0912345678');
    const pack3 = this.piiVaultService.encryptRawPhoneForShop(shopId, '0977888999');

    const seeds = [
      this.customerRepo.create({
        shopId,
        code: 'KH-VIP-001',
        fullName: 'Nguyễn Minh Anh',
        avatarUrl: 'https://api.dicebear.com/7.x/initials/svg?seed=Nguyen+Minh+Anh',
        phoneMasked: pack1.phoneMasked,
        phoneEncrypted: pack1.phoneEncrypted,
        phoneSearchHash: pack1.phoneSearchHash,
        email: 'minhanh.nguyen@gmail.com',
        defaultProvinceCode: 'VN-HN',
        defaultProvinceName: 'Thành phố Hà Nội',
        defaultDistrictCode: 'VN-HN-CG',
        defaultDistrictName: 'Quận Cầu Giấy',
        defaultWardCode: 'VN-HN-CG-QH',
        defaultWardName: 'Phường Quan Hoa',
        defaultAddressLine: 'Số 15 Ngõ 68 Cầu Giấy',
        tier: CustomerTierEnum.VIP,
        rfmScoreR: 5,
        rfmScoreF: 5,
        rfmScoreM: 5,
        rfmSegmentCode: RfmSegmentCodeEnum.CHAMPIONS,
        totalOrdersCount: 12,
        successfulDeliveriesCount: 12,
        returnedOrdersCount: 0,
        networkDeliveredCount: 28,
        networkReturnedCount: 0,
        reportedCount: 0,
        reportedReasonsJson: [],
        trustLookupSource: PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE,
        lastTrustLookupAt: now,
        deliveryTrustScore: 98,
        isBlacklisted: false,
        lifetimeValueAmount: 18500000,
        loyaltyPointsBalance: 1850,
        walletCreditBalance: 250000,
        industryCategory: ShopBusinessCategoryEnum.GENERAL_MULTI_CATEGORY,
        heightCm: 162,
        weightKg: 51,
        preferredSize: 'M',
        customAttributesJson: [
          {
            key: 'preferred_product',
            label: 'Nhóm sản phẩm quan tâm',
            value: 'Sản phẩm cao cấp / Bộ sưu tập mới',
          },
          {
            key: 'delivery_time_window',
            label: 'Khung giờ nhận hàng',
            value: 'Giờ hành chính (9h00 - 17h00)',
          },
        ],
        notes: 'Khách VIP ưu tiên giao giờ hành chính.',
        linkedExternalIdentitiesJson: [
          {
            channelType: ChannelTypeEnum.FACEBOOK_PAGE,
            channelIntegrationId: null,
            pageShortCode: 'FB-MAIN',
            pageName: 'Fanpage Chính Thức',
            externalUserId: 'psid_vip_001',
            externalUsername: 'Nguyễn Minh Anh',
            firstSeenAt: new Date(now.getTime() - 60 * 86400000).toISOString(),
            lastSeenAt: now.toISOString(),
          },
          {
            channelType: ChannelTypeEnum.ZALO_OA,
            channelIntegrationId: null,
            pageShortCode: 'ZALO-OA',
            pageName: 'Zalo Official Account',
            externalUserId: 'zalo_vip_001',
            externalUsername: 'Minh Anh Nguyễn',
            firstSeenAt: new Date(now.getTime() - 30 * 86400000).toISOString(),
            lastSeenAt: now.toISOString(),
          },
        ],
        recentOrdersSnapshotJson: [
          {
            orderId: 'ord_vip_01',
            orderCode: 'DH-2611-089',
            channelType: ChannelTypeEnum.FACEBOOK_PAGE,
            pageShortCode: 'FB-MAIN',
            totalAmount: 1650000,
            status: 'DELIVERED_RECONCILED',
            carrierCode: 'GHN',
            trackingNumber: 'GHN8829102',
            createdAt: new Date(now.getTime() - 3 * 86400000).toISOString(),
          },
          {
            orderId: 'ord_vip_02',
            orderCode: 'DH-2610-042',
            channelType: ChannelTypeEnum.ZALO_OA,
            pageShortCode: 'ZALO-OA',
            totalAmount: 2150000,
            status: 'DELIVERED_RECONCILED',
            carrierCode: 'GHTK',
            trackingNumber: 'S21902.GHTK.991',
            createdAt: new Date(now.getTime() - 18 * 86400000).toISOString(),
          },
        ],
        lastOrderAt: new Date(now.getTime() - 3 * 86400000),
      }),
      this.customerRepo.create({
        shopId,
        code: 'KH-GOLD-002',
        fullName: 'Trần Thảo Vy',
        avatarUrl: 'https://api.dicebear.com/7.x/initials/svg?seed=Tran+Thao+Vy',
        phoneMasked: pack2.phoneMasked,
        phoneEncrypted: pack2.phoneEncrypted,
        phoneSearchHash: pack2.phoneSearchHash,
        email: 'thaovy.tran@gmail.com',
        defaultProvinceCode: 'VN-SG',
        defaultProvinceName: 'Thành phố Hồ Chí Minh',
        defaultDistrictCode: 'VN-SG-BT',
        defaultDistrictName: 'Quận Bình Thạnh',
        defaultWardCode: 'VN-SG-BT-P22',
        defaultWardName: 'Phường 22',
        defaultAddressLine: 'Park 5 Vinhomes Central Park, 208 Nguyễn Hữu Cảnh',
        tier: CustomerTierEnum.GOLD,
        rfmScoreR: 4,
        rfmScoreF: 4,
        rfmScoreM: 4,
        rfmSegmentCode: RfmSegmentCodeEnum.LOYAL,
        totalOrdersCount: 5,
        successfulDeliveriesCount: 5,
        returnedOrdersCount: 0,
        networkDeliveredCount: 14,
        networkReturnedCount: 1,
        reportedCount: 0,
        reportedReasonsJson: [],
        trustLookupSource: PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE,
        lastTrustLookupAt: now,
        deliveryTrustScore: 90,
        isBlacklisted: false,
        lifetimeValueAmount: 6200000,
        loyaltyPointsBalance: 620,
        walletCreditBalance: 120000,
        industryCategory: ShopBusinessCategoryEnum.COSMETICS_BEAUTY,
        customAttributesJson: [
          { key: 'skin_type', label: 'Loại da', value: 'Da hỗn hợp thiên dầu' },
          { key: 'skin_concern', label: 'Tình trạng quan tâm', value: 'Dưỡng sáng & chống nắng' },
        ],
        notes: 'Khách thân thiết TP.HCM, hay mua qua Livestream.',
        linkedExternalIdentitiesJson: [
          {
            channelType: ChannelTypeEnum.INSTAGRAM,
            channelIntegrationId: null,
            pageShortCode: 'IG-OFFICIAL',
            pageName: 'Instagram Official',
            externalUserId: 'ig_vy_002',
            externalUsername: 'thaovy.official',
            firstSeenAt: new Date(now.getTime() - 45 * 86400000).toISOString(),
            lastSeenAt: now.toISOString(),
          },
        ],
        recentOrdersSnapshotJson: [
          {
            orderId: 'ord_gold_01',
            orderCode: 'DH-2611-051',
            channelType: ChannelTypeEnum.INSTAGRAM,
            pageShortCode: 'IG-OFFICIAL',
            totalAmount: 1290000,
            status: 'DELIVERED_RECONCILED',
            carrierCode: 'GHN',
            trackingNumber: 'GHN7712901',
            createdAt: new Date(now.getTime() - 9 * 86400000).toISOString(),
          },
        ],
        lastOrderAt: new Date(now.getTime() - 9 * 86400000),
      }),
      this.customerRepo.create({
        shopId,
        code: 'KH-RISK-003',
        fullName: 'Lê Hoàng Nam (Cảnh báo hoàn đơn)',
        avatarUrl: 'https://api.dicebear.com/7.x/initials/svg?seed=Le+Hoang+Nam',
        phoneMasked: pack3.phoneMasked,
        phoneEncrypted: pack3.phoneEncrypted,
        phoneSearchHash: pack3.phoneSearchHash,
        defaultProvinceCode: 'VN-SG',
        defaultProvinceName: 'Thành phố Hồ Chí Minh',
        defaultDistrictCode: 'VN-SG-Q10',
        defaultDistrictName: 'Quận 10',
        defaultWardCode: 'VN-SG-Q10-P12',
        defaultWardName: 'Phường 12',
        defaultAddressLine: '120 Sư Vạn Hạnh',
        tier: CustomerTierEnum.BLACKLIST,
        rfmScoreR: 2,
        rfmScoreF: 1,
        rfmScoreM: 1,
        rfmSegmentCode: RfmSegmentCodeEnum.AT_RISK,
        totalOrdersCount: 3,
        successfulDeliveriesCount: 0,
        returnedOrdersCount: 3,
        networkDeliveredCount: 1,
        networkReturnedCount: 7,
        reportedCount: 4,
        reportedReasonsJson: [
          {
            reportId: 'rep_seed_01',
            reason: 'Đặt 3 đơn COD liên tiếp nhưng shipper GHN gọi tắt máy không nhận hàng',
            source: 'CARRIER_3PL_GHN',
            reportedByName: 'Hệ thống Đối soát GHN & Pancake POS',
            reportedAt: '2026-11-01T09:30:00.000Z',
          },
          {
            reportId: 'rep_seed_02',
            reason: 'Báo xấu từ Cộng đồng Shop: Khách đặt nhiều shop cùng lúc rồi từ chối nhận',
            source: 'PANCAKE_COMMUNITY',
            reportedByName: 'Cộng đồng Nhà bán hàng Pancake',
            reportedAt: '2026-10-20T14:15:00.000Z',
          },
        ],
        trustLookupSource: PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE,
        lastTrustLookupAt: now,
        deliveryTrustScore: 14,
        isBlacklisted: true,
        blacklistReason: 'Đặt 3 đơn COD liên tiếp nhưng tắt máy không nhận hàng (Bom hàng).',
        lifetimeValueAmount: 0,
        loyaltyPointsBalance: 0,
        walletCreditBalance: 0,
        industryCategory: ShopBusinessCategoryEnum.GENERAL_MULTI_CATEGORY,
        notes: 'Bắt buộc yêu cầu chuyển khoản đặt cọc VietQR 100% trước khi gửi hàng.',
        linkedExternalIdentitiesJson: [
          {
            channelType: ChannelTypeEnum.FACEBOOK_PAGE,
            channelIntegrationId: null,
            pageShortCode: 'FB-MAIN',
            pageName: 'Fanpage Chính Thức',
            externalUserId: 'psid_risk_003',
            externalUsername: 'Hoàng Nam',
            firstSeenAt: new Date(now.getTime() - 25 * 86400000).toISOString(),
            lastSeenAt: now.toISOString(),
          },
        ],
        recentOrdersSnapshotJson: [
          {
            orderId: 'ord_risk_01',
            orderCode: 'DH-2610-911',
            channelType: ChannelTypeEnum.FACEBOOK_PAGE,
            pageShortCode: 'FB-MAIN',
            totalAmount: 890000,
            status: 'RETURNED',
            carrierCode: 'GHTK',
            trackingNumber: 'S21902.GHTK.404',
            createdAt: new Date(now.getTime() - 14 * 86400000).toISOString(),
          },
        ],
        lastOrderAt: new Date(now.getTime() - 14 * 86400000),
      }),
    ];

    await this.customerRepo.save(seeds).catch(() => undefined);
  }

  /**
   * Danh sách Hồ sơ Khách hàng CRM 360° có hỗ trợ tìm kiếm theo Chỉ mục mù SĐT (`phoneSearchHash`) trong < 2ms
   */
  public async listCustomers(
    shopId: string,
    query: CustomerListQueryDto,
  ): Promise<{
    items: Array<CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult }>;
    total: number;
    page: number;
    limit: number;
  }> {
    await this.ensureSeededShopCustomersIfEmpty(shopId);

    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 25)));
    const crmConfig = await this.getShopCrmTrustAndIndustryConfig(shopId);

    const qb = this.customerRepo.createQueryBuilder('c').where('c.shop_id = :shopId', { shopId });

    if (query.tier) {
      qb.andWhere('c.tier = :tier', { tier: query.tier });
    }
    if (query.rfmSegment) {
      qb.andWhere('c.rfm_segment_code = :rfmSegment', { rfmSegment: query.rfmSegment });
    }
    if (query.highRiskOnly) {
      qb.andWhere(
        '(c.delivery_trust_score < 50 OR c.is_blacklisted = true OR c.returned_orders_count >= 2 OR c.reported_count >= 1)',
      );
    }
    if (query.blacklistedOnly) {
      qb.andWhere('c.is_blacklisted = true');
    }

    if (query.search && query.search.trim()) {
      const kw = query.search.trim();
      const digitsOnly = kw.replace(/\D/g, '');
      if (digitsOnly.length >= 9) {
        const blindHash = this.piiVaultService.computePhoneBlindSearchHash(shopId, digitsOnly);
        qb.andWhere(
          '(c.phone_search_hash = :blindHash OR c.full_name LIKE :likeKw OR c.code LIKE :likeKw)',
          {
            blindHash,
            likeKw: `%${kw}%`,
          },
        );
      } else {
        qb.andWhere(
          '(c.full_name LIKE :likeKw OR c.code LIKE :likeKw OR c.phone_masked LIKE :likeKw OR c.email LIKE :likeKw)',
          {
            likeKw: `%${kw}%`,
          },
        );
      }
    }

    qb.orderBy('c.updatedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rawItems, total] = await qb.getManyAndCount();
    const items = rawItems.map((c) =>
      this.enrichCustomerWithTrustEvaluation(c, crmConfig.requireDepositOnHighRisk, crmConfig),
    );

    return { items, total, page, limit };
  }

  /**
   * Xem chi tiết Hồ sơ Khách hàng CRM 360° theo `customerId`
   */
  public async getCustomer360ById(
    shopId: string,
    customerId: string,
  ): Promise<{
    customer: CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult };
    walletLedgers: CustomerWalletLedgerEntity[];
    linkedConversations: ConversationEntity[];
    crmConfig: CrmTrustAndIndustryConfig & {
      requireDepositOnHighRisk: boolean;
      hasCustomLookupApiKey: boolean;
    };
  }> {
    const [customer, crmConfig] = await Promise.all([
      this.customerRepo.findOne({ where: { id: customerId, shopId } }),
      this.getShopCrmTrustAndIndustryConfig(shopId),
    ]);

    if (!customer) {
      throw new NotFoundException('CUSTOMER_PROFILE_NOT_FOUND');
    }

    const [walletLedgers, linkedConversations] = await Promise.all([
      this.walletLedgerRepo.find({
        where: { shopId, customerId: customer.id },
        order: { createdAt: 'DESC' },
        take: 30,
      }),
      this.conversationRepo.find({
        where: { shopId, customerId: customer.id },
        order: { lastMessageAt: 'DESC' },
        take: 15,
      }),
    ]);

    return {
      customer: this.enrichCustomerWithTrustEvaluation(
        customer,
        crmConfig.requireDepositOnHighRisk,
        crmConfig,
      ),
      walletLedgers,
      linkedConversations,
      crmConfig,
    };
  }

  /**
   * Quét lịch sử các tin nhắn gần nhất trong cuộc hội thoại để tổng hợp SĐT & Địa chỉ 3 cấp mà khách đã nhắn
   */
  private async aggregateNerFromConversationMessages(
    conversationId: string,
    fallbackText: string,
  ): Promise<ExtractedCommerceEntitiesPayload> {
    const recentMsgs = await this.messageRepo.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: 20,
    });

    const combinedTexts: string[] = [];
    for (const msg of recentMsgs) {
      if (msg.direction === MessageDirectionEnum.OUTBOUND || msg.isInternalNote) {
        continue;
      }
      if (msg.content) {
        const decrypted = this.messageCryptoService.decryptForConversation(
          msg.content,
          conversationId,
        );
        if (decrypted) {
          combinedTexts.push(decrypted);
        }
      }
    }
    if (fallbackText) {
      combinedTexts.push(fallbackText);
    }

    const mergedRawText = combinedTexts.join('\n');
    const aggregateNer = this.nerService.extractCommerceEntities(mergedRawText);

    // Kết hợp thêm các thực thể đã được lưu sẵn trong extractedEntitiesJson của từng tin nhắn
    for (const msg of recentMsgs) {
      const ext = msg.extractedEntitiesJson;
      if (!ext) continue;
      if (!aggregateNer.provinceCode && ext.provinceCode) {
        aggregateNer.hasAddressDetected = true;
        aggregateNer.provinceCode = ext.provinceCode;
        aggregateNer.provinceName = ext.provinceName;
        aggregateNer.districtCode = ext.districtCode;
        aggregateNer.districtName = ext.districtName;
        aggregateNer.wardCode = ext.wardCode;
        aggregateNer.wardName = ext.wardName;
      }
      if (!aggregateNer.addressLine && (ext.addressLine || ext.fullFormattedAddress)) {
        aggregateNer.hasAddressDetected = true;
        aggregateNer.addressLine = ext.addressLine || ext.fullFormattedAddress;
        aggregateNer.fullFormattedAddress = ext.fullFormattedAddress || ext.addressLine;
      }
      if (!aggregateNer.heightCm && ext.heightCm) aggregateNer.heightCm = ext.heightCm;
      if (!aggregateNer.weightKg && ext.weightKg) aggregateNer.weightKg = ext.weightKg;
    }

    return aggregateNer;
  }

  /**
   * Lấy Hồ sơ Khách hàng CRM 360° gắn với một cuộc hội thoại (`conversationId`) để hiển thị ngay trên `Customer360Panel` bên phải khung Chat.
   * Quét lịch sử các tin nhắn gần nhất trong cuộc hội thoại để đảm bảo không bỏ sót SĐT hoặc Địa chỉ nào mà khách đã nhắn.
   */
  public async getCustomer360ByConversationId(
    shopId: string,
    conversationId: string,
  ): Promise<{
    customer: (CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult }) | null;
    walletLedgers: CustomerWalletLedgerEntity[];
    linkedConversations: ConversationEntity[];
    crmConfig: CrmTrustAndIndustryConfig & {
      requireDepositOnHighRisk: boolean;
      hasCustomLookupApiKey: boolean;
    };
  }> {
    const conv = await this.conversationRepo.findOne({
      where: { id: conversationId },
    });
    if (!conv) {
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    const effectiveShopId = conv.shopId || shopId;
    if (conv.customerId) {
      const existing = await this.customerRepo.findOne({
        where: { id: conv.customerId, shopId: effectiveShopId },
      });
      if (existing) {
        // Nếu hồ sơ đã tồn tại nhưng chưa có Địa chỉ 3 cấp hoặc chưa có SĐT, quét lại 20 tin nhắn gần nhất để tự động bổ sung
        if (!existing.defaultProvinceCode || !existing.phoneSearchHash) {
          const retroNer = await this.aggregateNerFromConversationMessages(
            conversationId,
            conv.lastMessage || '',
          );
          if (
            retroNer.hasAddressDetected ||
            retroNer.provinceCode ||
            (retroNer.phones && retroNer.phones.length > 0)
          ) {
            await this.resolveOrUpsertCustomerFromOmnichannelEvent({
              shopId: effectiveShopId,
              conversation: conv,
              channelType: conv.channelType,
              channelIntegrationId: conv.channelIntegrationId,
              externalUserId: conv.externalThreadId || conv.id,
              customerName: conv.name || existing.fullName,
              customerAvatarUrl: conv.avatar || existing.avatarUrl,
              extractedNer: retroNer,
            });
          }
        }
        return this.getCustomer360ById(effectiveShopId, existing.id);
      }
    }

    // Tự động khởi tạo hồ sơ CRM 360° từ thông tin cuộc hội thoại và lịch sử tin nhắn
    const extractedNer = await this.aggregateNerFromConversationMessages(
      conversationId,
      conv.lastMessage || '',
    );
    const resolved = await this.resolveOrUpsertCustomerFromOmnichannelEvent({
      shopId: effectiveShopId,
      conversation: conv,
      channelType: conv.channelType,
      channelIntegrationId: conv.channelIntegrationId,
      externalUserId: conv.externalThreadId || conv.id,
      customerName: conv.name || 'Khách hàng',
      customerAvatarUrl: conv.avatar,
      extractedNer,
    });

    return this.getCustomer360ById(effectiveShopId, resolved.customer.id);
  }

  /**
   * Tạo mới hoặc cập nhật Hồ sơ Khách hàng CRM 360° (Hỗ trợ đa ngành hàng & thuộc tính tùy chỉnh)
   */
  public async upsertCustomerProfile(
    shopId: string,
    customerId: string | null,
    dto: UpsertCustomerProfileDto,
  ): Promise<CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult }> {
    const crmConfig = await this.getShopCrmTrustAndIndustryConfig(shopId);
    let customer = customerId
      ? await this.customerRepo.findOne({ where: { id: customerId, shopId } })
      : null;

    const encryptedPack =
      dto.rawPhone && dto.rawPhone.trim()
        ? this.piiVaultService.encryptRawPhoneForShop(shopId, dto.rawPhone.trim())
        : null;

    if (!customer && encryptedPack) {
      customer = await this.customerRepo.findOne({
        where: { shopId, phoneSearchHash: encryptedPack.phoneSearchHash },
      });
    }

    const decryptedCustomKey = this.decryptCustomLookupApiKeyInRam(
      shopId,
      crmConfig.customLookupApiKeyEncrypted,
    );
    const externalTrustLookup =
      dto.rawPhone && dto.rawPhone.trim() && crmConfig.enableAutoTrustLookupOnPhone !== false
        ? await this.trustScoreService.lookupPhoneReputationFromSources({
            rawPhone: dto.rawPhone.trim(),
            config: crmConfig,
            decryptedCustomApiKey: decryptedCustomKey,
          })
        : null;

    const adminTree = this.nerService.getAdministrativeTree();
    const matchedProv = dto.defaultProvinceCode
      ? adminTree.find((p) => p.code === dto.defaultProvinceCode)
      : null;
    const matchedDist =
      matchedProv && dto.defaultDistrictCode
        ? matchedProv.districts.find((d) => d.code === dto.defaultDistrictCode)
        : null;
    const matchedWard =
      matchedDist && dto.defaultWardCode
        ? matchedDist.wards.find((w) => w.code === dto.defaultWardCode)
        : null;

    const sanitizedCustomAttrs: CustomerCustomAttributeItem[] | undefined = Array.isArray(
      dto.customAttributesJson,
    )
      ? dto.customAttributesJson
          .filter((a) => Boolean(a && (a.label?.trim() || a.key?.trim())))
          .map((a) => ({
            key: (a.key || a.label || 'attr').trim(),
            label: (a.label || a.key || 'Thuộc tính').trim(),
            value: String(a.value ?? '').trim(),
          }))
      : undefined;

    if (!customer) {
      customer = this.customerRepo.create({
        shopId,
        code: this.generateCustomerCode(),
        fullName: dto.fullName.trim(),
        phoneMasked: encryptedPack?.phoneMasked || null,
        phoneEncrypted: encryptedPack?.phoneEncrypted || null,
        phoneSearchHash: encryptedPack?.phoneSearchHash || null,
        email: dto.email?.trim() || null,
        defaultProvinceCode: dto.defaultProvinceCode || null,
        defaultProvinceName: matchedProv?.name || null,
        defaultDistrictCode: dto.defaultDistrictCode || null,
        defaultDistrictName: matchedDist?.name || null,
        defaultWardCode: dto.defaultWardCode || null,
        defaultWardName: matchedWard?.name || null,
        defaultAddressLine: dto.defaultAddressLine?.trim() || null,
        tier: dto.tier || CustomerTierEnum.NEW,
        networkDeliveredCount: externalTrustLookup?.networkDeliveredCount || 0,
        networkReturnedCount: externalTrustLookup?.networkReturnedCount || 0,
        reportedCount: externalTrustLookup?.reportedCount || 0,
        reportedReasonsJson: externalTrustLookup?.reportedReasons || [],
        trustLookupSource:
          externalTrustLookup?.lookupSource || PhoneTrustLookupSourceEnum.COMBINED_MULTI_SOURCE,
        lastTrustLookupAt: externalTrustLookup ? new Date() : null,
        industryCategory: dto.industryCategory || crmConfig.businessCategory,
        heightCm: dto.heightCm ?? null,
        weightKg: dto.weightKg ?? null,
        preferredSize: dto.preferredSize?.trim() || null,
        customAttributesJson: sanitizedCustomAttrs || [],
        notes: dto.notes?.trim() || null,
        activeTagIdsJson: dto.activeTagIdsJson || [],
        linkedExternalIdentitiesJson: [],
        recentOrdersSnapshotJson: [],
      });
    } else {
      customer.fullName = dto.fullName.trim();
      if (encryptedPack) {
        customer.phoneMasked = encryptedPack.phoneMasked;
        customer.phoneEncrypted = encryptedPack.phoneEncrypted;
        customer.phoneSearchHash = encryptedPack.phoneSearchHash;
      }
      if (externalTrustLookup) {
        customer.networkDeliveredCount = Math.max(
          Number(customer.networkDeliveredCount || 0),
          externalTrustLookup.networkDeliveredCount,
        );
        customer.networkReturnedCount = Math.max(
          Number(customer.networkReturnedCount || 0),
          externalTrustLookup.networkReturnedCount,
        );
        if (Number(customer.reportedCount || 0) === 0 && externalTrustLookup.reportedCount > 0) {
          customer.reportedCount = externalTrustLookup.reportedCount;
          customer.reportedReasonsJson = externalTrustLookup.reportedReasons;
        }
        customer.trustLookupSource = externalTrustLookup.lookupSource;
        customer.lastTrustLookupAt = new Date();
      }
      if (dto.email !== undefined) customer.email = dto.email?.trim() || null;
      if (dto.defaultProvinceCode !== undefined) {
        customer.defaultProvinceCode = dto.defaultProvinceCode || null;
        customer.defaultProvinceName = matchedProv?.name || null;
      }
      if (dto.defaultDistrictCode !== undefined) {
        customer.defaultDistrictCode = dto.defaultDistrictCode || null;
        customer.defaultDistrictName = matchedDist?.name || null;
      }
      if (dto.defaultWardCode !== undefined) {
        customer.defaultWardCode = dto.defaultWardCode || null;
        customer.defaultWardName = matchedWard?.name || null;
      }
      if (dto.defaultAddressLine !== undefined) {
        customer.defaultAddressLine = dto.defaultAddressLine?.trim() || null;
      }
      if (dto.tier !== undefined) customer.tier = dto.tier;
      if (dto.industryCategory !== undefined) {
        customer.industryCategory = dto.industryCategory || crmConfig.businessCategory;
      }
      if (dto.heightCm !== undefined) customer.heightCm = dto.heightCm;
      if (dto.weightKg !== undefined) customer.weightKg = dto.weightKg;
      if (dto.preferredSize !== undefined) customer.preferredSize = dto.preferredSize || null;
      if (sanitizedCustomAttrs !== undefined) {
        customer.customAttributesJson = sanitizedCustomAttrs;
      }
      if (dto.notes !== undefined) customer.notes = dto.notes || null;
      if (dto.activeTagIdsJson !== undefined) customer.activeTagIdsJson = dto.activeTagIdsJson;
    }

    const evalRes = this.trustScoreService.evaluateCustomerTrustScore({
      successfulDeliveriesCount: customer.successfulDeliveriesCount,
      returnedOrdersCount: customer.returnedOrdersCount,
      networkDeliveredCount: customer.networkDeliveredCount,
      networkReturnedCount: customer.networkReturnedCount,
      reportedCount: customer.reportedCount,
      reportedReasons: customer.reportedReasonsJson,
      isBlacklisted: customer.isBlacklisted,
      shopRequireDepositOnHighRisk: crmConfig.requireDepositOnHighRisk,
      highRiskReturnRateThresholdPercent: crmConfig.highRiskReturnRateThresholdPercent,
      highRiskReportedCountThreshold: crmConfig.highRiskReportedCountThreshold,
      lookupSource: customer.trustLookupSource,
      enabledCarriers: crmConfig.enabledCarriers,
    });
    customer.deliveryTrustScore = evalRes.score;

    const saved = await this.customerRepo.save(customer);

    if (dto.conversationId) {
      await this.conversationRepo.update(dto.conversationId, {
        customerId: saved.id,
        hasPhoneCollected: Boolean(saved.phoneMasked),
      });
    }

    return this.enrichCustomerWithTrustEvaluation(
      saved,
      crmConfig.requireDepositOnHighRisk,
      crmConfig,
    );
  }

  /**
   * Bật / Tắt trạng thái Danh sách đen (Bom hàng — `BLACKLIST`) và ghi log kiểm toán
   */
  public async toggleCustomerBlacklist(params: {
    shopId: string;
    customerId: string;
    actorUserId: string;
    dto: ToggleCustomerBlacklistDto;
  }): Promise<CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult }> {
    const customer = await this.customerRepo.findOne({
      where: { id: params.customerId, shopId: params.shopId },
    });
    if (!customer) {
      throw new NotFoundException('CUSTOMER_PROFILE_NOT_FOUND');
    }

    const crmConfig = await this.getShopCrmTrustAndIndustryConfig(params.shopId);
    const beforeState = {
      isBlacklisted: customer.isBlacklisted,
      blacklistReason: customer.blacklistReason,
      deliveryTrustScore: customer.deliveryTrustScore,
    };

    customer.isBlacklisted = params.dto.isBlacklisted;
    customer.blacklistReason = params.dto.isBlacklisted
      ? params.dto.blacklistReason?.trim() || 'Khách bom hàng / từ chối nhận hàng nhiều lần'
      : null;
    if (params.dto.isBlacklisted) {
      customer.tier = CustomerTierEnum.BLACKLIST;
    }

    const evalRes = this.trustScoreService.evaluateCustomerTrustScore({
      successfulDeliveriesCount: customer.successfulDeliveriesCount,
      returnedOrdersCount: customer.returnedOrdersCount,
      networkDeliveredCount: customer.networkDeliveredCount,
      networkReturnedCount: customer.networkReturnedCount,
      reportedCount: customer.reportedCount,
      reportedReasons: customer.reportedReasonsJson,
      isBlacklisted: customer.isBlacklisted,
      shopRequireDepositOnHighRisk: crmConfig.requireDepositOnHighRisk,
      highRiskReturnRateThresholdPercent: crmConfig.highRiskReturnRateThresholdPercent,
      highRiskReportedCountThreshold: crmConfig.highRiskReportedCountThreshold,
      lookupSource: customer.trustLookupSource,
      enabledCarriers: crmConfig.enabledCarriers,
    });
    customer.deliveryTrustScore = evalRes.score;

    const saved = await this.customerRepo.save(customer);

    await this.piiVaultService.recordSecurityAuditLog({
      shopId: params.shopId,
      actorUserId: params.actorUserId,
      actionCode: SecurityAuditActionCodeEnum.BLACKLIST_TOGGLE,
      targetResourceType: 'CUSTOMER_PROFILE',
      targetResourceId: customer.id,
      beforeSnapshotJson: beforeState,
      afterSnapshotJson: {
        isBlacklisted: saved.isBlacklisted,
        blacklistReason: saved.blacklistReason,
        deliveryTrustScore: saved.deliveryTrustScore,
      },
    });

    return this.enrichCustomerWithTrustEvaluation(
      saved,
      crmConfig.requireDepositOnHighRisk,
      crmConfig,
    );
  }

  /**
   * Ghi đè Điểm uy tín nhận hàng (`CRM_TRUST_SCORE_OVERRIDE`) có ghi log kiểm toán
   */
  public async overrideDeliveryTrustScore(params: {
    shopId: string;
    customerId: string;
    actorUserId: string;
    dto: OverrideDeliveryTrustScoreDto;
  }): Promise<CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult }> {
    const customer = await this.customerRepo.findOne({
      where: { id: params.customerId, shopId: params.shopId },
    });
    if (!customer) {
      throw new NotFoundException('CUSTOMER_PROFILE_NOT_FOUND');
    }

    const crmConfig = await this.getShopCrmTrustAndIndustryConfig(params.shopId);
    const beforeSnapshot = {
      deliveryTrustScore: customer.deliveryTrustScore,
      successfulDeliveriesCount: customer.successfulDeliveriesCount,
      returnedOrdersCount: customer.returnedOrdersCount,
      networkDeliveredCount: customer.networkDeliveredCount,
      networkReturnedCount: customer.networkReturnedCount,
      reportedCount: customer.reportedCount,
    };

    customer.deliveryTrustScore = params.dto.deliveryTrustScore;
    if (params.dto.successfulDeliveriesCount !== undefined) {
      customer.successfulDeliveriesCount = params.dto.successfulDeliveriesCount;
    }
    if (params.dto.returnedOrdersCount !== undefined) {
      customer.returnedOrdersCount = params.dto.returnedOrdersCount;
    }
    if (params.dto.networkDeliveredCount !== undefined) {
      customer.networkDeliveredCount = params.dto.networkDeliveredCount;
    }
    if (params.dto.networkReturnedCount !== undefined) {
      customer.networkReturnedCount = params.dto.networkReturnedCount;
    }
    if (params.dto.reportedCount !== undefined) {
      customer.reportedCount = params.dto.reportedCount;
    }

    const saved = await this.customerRepo.save(customer);

    await this.piiVaultService.recordSecurityAuditLog({
      shopId: params.shopId,
      actorUserId: params.actorUserId,
      actionCode: SecurityAuditActionCodeEnum.TRUST_SCORE_OVERRIDE,
      targetResourceType: 'CUSTOMER_PROFILE',
      targetResourceId: customer.id,
      beforeSnapshotJson: beforeSnapshot,
      afterSnapshotJson: {
        deliveryTrustScore: saved.deliveryTrustScore,
        successfulDeliveriesCount: saved.successfulDeliveriesCount,
        returnedOrdersCount: saved.returnedOrdersCount,
        networkDeliveredCount: saved.networkDeliveredCount,
        networkReturnedCount: saved.networkReturnedCount,
        reportedCount: saved.reportedCount,
        reason: params.dto.reason,
      },
    });

    const enriched = this.enrichCustomerWithTrustEvaluation(
      saved,
      crmConfig.requireDepositOnHighRisk,
      crmConfig,
    );
    enriched.trustEvaluation.score = saved.deliveryTrustScore;
    return enriched;
  }

  /**
   * F04.2 & F04.5: Gộp 2 Hồ sơ Khách hàng Trùng (`CRM_CUSTOMER_MERGE_DUPLICATE`)
   * Hợp nhất toàn bộ lịch sử đơn hàng, hội thoại đa kênh, tài khoản mạng xã hội, điểm tích lũy và số dư ví về hồ sơ chính.
   */
  public async mergeDuplicateCustomerProfiles(params: {
    shopId: string;
    actorUserId: string;
    dto: MergeCustomerProfilesDto;
  }): Promise<CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult }> {
    const { shopId, actorUserId, dto } = params;
    if (dto.primaryCustomerId === dto.duplicateCustomerId) {
      throw new BadRequestException('CANNOT_MERGE_SAME_CUSTOMER_PROFILE');
    }

    const [primary, duplicate, crmConfig] = await Promise.all([
      this.customerRepo.findOne({ where: { id: dto.primaryCustomerId, shopId } }),
      this.customerRepo.findOne({ where: { id: dto.duplicateCustomerId, shopId } }),
      this.getShopCrmTrustAndIndustryConfig(shopId),
    ]);

    if (!primary || !duplicate) {
      throw new NotFoundException('CUSTOMER_PROFILE_NOT_FOUND');
    }

    // 1. Hợp nhất chỉ số đơn hàng, LTV, Điểm thưởng & Số dư ví
    primary.totalOrdersCount =
      Number(primary.totalOrdersCount || 0) + Number(duplicate.totalOrdersCount || 0);
    primary.successfulDeliveriesCount =
      Number(primary.successfulDeliveriesCount || 0) +
      Number(duplicate.successfulDeliveriesCount || 0);
    primary.returnedOrdersCount =
      Number(primary.returnedOrdersCount || 0) + Number(duplicate.returnedOrdersCount || 0);
    primary.networkDeliveredCount = Math.max(
      Number(primary.networkDeliveredCount || 0),
      Number(duplicate.networkDeliveredCount || 0),
    );
    primary.networkReturnedCount = Math.max(
      Number(primary.networkReturnedCount || 0),
      Number(duplicate.networkReturnedCount || 0),
    );
    primary.reportedCount =
      Number(primary.reportedCount || 0) + Number(duplicate.reportedCount || 0);
    primary.reportedReasonsJson = [
      ...(primary.reportedReasonsJson || []),
      ...(duplicate.reportedReasonsJson || []),
    ];
    primary.lifetimeValueAmount =
      Number(primary.lifetimeValueAmount || 0) + Number(duplicate.lifetimeValueAmount || 0);
    primary.loyaltyPointsBalance =
      Number(primary.loyaltyPointsBalance || 0) + Number(duplicate.loyaltyPointsBalance || 0);
    primary.walletCreditBalance =
      Number(primary.walletCreditBalance || 0) + Number(duplicate.walletCreditBalance || 0);

    // 2. Hợp nhất danh sách tài khoản mạng xã hội liên kết (`linkedExternalIdentitiesJson`)
    const mergedIdentities = [
      ...(primary.linkedExternalIdentitiesJson || []),
      ...(duplicate.linkedExternalIdentitiesJson || []),
    ];
    primary.linkedExternalIdentitiesJson = mergedIdentities;

    // 3. Hợp nhất lịch sử đơn hàng gần nhất và nhãn Tag
    const mergedOrders = [
      ...(primary.recentOrdersSnapshotJson || []),
      ...(duplicate.recentOrdersSnapshotJson || []),
    ].slice(0, 15);
    primary.recentOrdersSnapshotJson = mergedOrders;

    const mergedTags = Array.from(
      new Set([...(primary.activeTagIdsJson || []), ...(duplicate.activeTagIdsJson || [])]),
    );
    primary.activeTagIdsJson = mergedTags;

    if (!primary.phoneEncrypted && duplicate.phoneEncrypted) {
      primary.phoneEncrypted = duplicate.phoneEncrypted;
      primary.phoneMasked = duplicate.phoneMasked;
      primary.phoneSearchHash = duplicate.phoneSearchHash;
    }
    if (!primary.defaultProvinceCode && duplicate.defaultProvinceCode) {
      primary.defaultProvinceCode = duplicate.defaultProvinceCode;
      primary.defaultProvinceName = duplicate.defaultProvinceName;
      primary.defaultDistrictCode = duplicate.defaultDistrictCode;
      primary.defaultDistrictName = duplicate.defaultDistrictName;
      primary.defaultWardCode = duplicate.defaultWardCode;
      primary.defaultWardName = duplicate.defaultWardName;
      primary.defaultAddressLine = duplicate.defaultAddressLine;
    }

    const rfmEval = this.rfmService.evaluateCustomerRfmScore({
      lastOrderAt: primary.lastOrderAt || duplicate.lastOrderAt,
      successfulDeliveriesCount: primary.successfulDeliveriesCount,
      lifetimeValueAmount: primary.lifetimeValueAmount,
    });
    primary.rfmScoreR = rfmEval.scoreR;
    primary.rfmScoreF = rfmEval.scoreF;
    primary.rfmScoreM = rfmEval.scoreM;
    primary.rfmSegmentCode = rfmEval.segmentCode;
    if (!primary.isBlacklisted) {
      primary.tier = rfmEval.tier;
    }

    const trustEval = this.trustScoreService.evaluateCustomerTrustScore({
      successfulDeliveriesCount: primary.successfulDeliveriesCount,
      returnedOrdersCount: primary.returnedOrdersCount,
      networkDeliveredCount: primary.networkDeliveredCount,
      networkReturnedCount: primary.networkReturnedCount,
      reportedCount: primary.reportedCount,
      reportedReasons: primary.reportedReasonsJson,
      isBlacklisted: primary.isBlacklisted,
      shopRequireDepositOnHighRisk: crmConfig.requireDepositOnHighRisk,
      highRiskReturnRateThresholdPercent: crmConfig.highRiskReturnRateThresholdPercent,
      highRiskReportedCountThreshold: crmConfig.highRiskReportedCountThreshold,
      lookupSource: primary.trustLookupSource,
      enabledCarriers: crmConfig.enabledCarriers,
    });
    primary.deliveryTrustScore = trustEval.score;

    const savedPrimary = await this.customerRepo.save(primary);

    // 4. Chuyển toàn bộ Hội thoại và Sổ cái Ví từ hồ sơ phụ sang hồ sơ chính
    await Promise.all([
      this.conversationRepo.update(
        { shopId, customerId: duplicate.id },
        { customerId: savedPrimary.id },
      ),
      this.walletLedgerRepo.update(
        { shopId, customerId: duplicate.id },
        { customerId: savedPrimary.id },
      ),
      this.customerRepo.softRemove(duplicate),
    ]);

    await this.piiVaultService.recordSecurityAuditLog({
      shopId,
      actorUserId,
      actionCode: SecurityAuditActionCodeEnum.MERGE_CUSTOMER,
      targetResourceType: 'CUSTOMER_PROFILE',
      targetResourceId: savedPrimary.id,
      beforeSnapshotJson: {
        duplicateCustomerId: duplicate.id,
        duplicateCode: duplicate.code,
        duplicateName: duplicate.fullName,
      },
      afterSnapshotJson: {
        primaryCustomerId: savedPrimary.id,
        primaryCode: savedPrimary.code,
        mergedTotalOrders: savedPrimary.totalOrdersCount,
        mergedLifetimeValue: savedPrimary.lifetimeValueAmount,
        mergeReason: dto.mergeReason || 'Gộp hồ sơ khách hàng trùng đa kênh',
      },
    });

    return this.enrichCustomerWithTrustEvaluation(
      savedPrimary,
      crmConfig.requireDepositOnHighRisk,
      crmConfig,
    );
  }
}
