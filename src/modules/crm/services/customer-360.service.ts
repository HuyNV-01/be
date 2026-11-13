import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  AdsConversionEventNameEnum,
  AdsConversionPlatformEnum,
  ChannelTypeEnum,
  CustomerTierEnum,
  RfmSegmentCodeEnum,
  SecurityAuditActionCodeEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  CustomerListQueryDto,
  MergeCustomerProfilesDto,
  OverrideDeliveryTrustScoreDto,
  ToggleCustomerBlacklistDto,
  UpsertCustomerProfileDto,
} from 'src/dto/crm/crm.dto';
import { ConversationEntity } from 'src/entity/conversation.entity';
import {
  CustomerProfileEntity,
  LinkedExternalIdentityItem,
} from 'src/entity/customer-profile.entity';
import { CustomerWalletLedgerEntity } from 'src/entity/customer-wallet-ledger.entity';
import { ExtractedCommerceEntitiesPayload } from 'src/entity/message.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { Repository } from 'typeorm';

import { AdsConversionSyncService } from './ads-conversion-sync.service';
import { CustomerRfmAndLoyaltyService } from './customer-rfm-and-loyalty.service';
import {
  DeliveryTrustEvaluationResult,
  DeliveryTrustScoreService,
} from './delivery-trust-score.service';
import { PiiVaultAndAuditService } from './pii-vault-and-audit.service';
import { VietnameseCommerceNerService } from './vietnamese-commerce-ner.service';

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
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    private readonly nerService: VietnameseCommerceNerService,
    private readonly trustScoreService: DeliveryTrustScoreService,
    private readonly piiVaultService: PiiVaultAndAuditService,
    private readonly rfmService: CustomerRfmAndLoyaltyService,
    private readonly adsConversionSyncService: AdsConversionSyncService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private generateCustomerCode(): string {
    const suffix = String(Date.now()).slice(-6);
    const rand = Math.floor(100 + Math.random() * 900);
    return `KH-${suffix}-${rand}`;
  }

  /**
   * Làm giàu đối tượng `CustomerProfileEntity` với kết quả đánh giá Điểm uy tín nhận hàng (`trustEvaluation`)
   * và đảm bảo ẩn vĩnh viễn `phoneEncrypted` / `phoneSearchHash`.
   */
  public enrichCustomerWithTrustEvaluation(
    customer: CustomerProfileEntity,
    shopRequireDepositOnHighRisk = true,
  ): CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult } {
    const trustEvaluation = this.trustScoreService.evaluateCustomerTrustScore({
      successfulDeliveriesCount: customer.successfulDeliveriesCount,
      returnedOrdersCount: customer.returnedOrdersCount,
      isBlacklisted: customer.isBlacklisted,
      shopRequireDepositOnHighRisk,
    });

    const clone = { ...customer } as CustomerProfileEntity & {
      trustEvaluation: DeliveryTrustEvaluationResult;
    };
    delete (clone as any).phoneEncrypted;
    delete (clone as any).phoneSearchHash;
    clone.trustEvaluation = trustEvaluation;
    return clone;
  }

  /**
   * F04.1, F04.2, F04.5 & F11.1:
   * Tự động nhận diện và hợp nhất Hồ sơ Khách hàng Đa kênh ngay khi khách hàng nhắn tin / bình luận:
   * 1. Nếu bóc tách được SĐT hợp lệ từ tin nhắn (`extractedNer.phones[0]`):
   *    - Tính `phoneSearchHash = HMAC-SHA256(normalizedPhone, SHOP_PII_SALT)`.
   *    - Tìm hồ sơ khách hàng đã tồn tại theo `(shopId, phoneSearchHash)` trên mọi kênh (FB, IG, Zalo, TikTok, Shopee).
   * 2. Nếu chưa có SĐT hoặc chưa khớp: tìm theo `conversation.customerId` hoặc `externalUserId` trong `linkedExternalIdentitiesJson`.
   * 3. Tự động điền Địa chỉ 3 cấp Tỉnh/Huyện/Xã, Chiều cao, Cân nặng, Size nếu bóc tách được từ NER.
   * 4. Nếu cuộc hội thoại đến từ Quảng cáo (`sourceAdId` / `ctwaClickId`) và vừa thu thập được SĐT mới:
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

    const firstExtractedPhone = extractedNer.phones?.[0] || null;
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

    const nowIso = new Date().toISOString();
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
        defaultAddressLine: extractedNer.addressLine || null,
        tier: CustomerTierEnum.NEW,
        rfmScoreR: 3,
        rfmScoreF: 1,
        rfmScoreM: 1,
        rfmSegmentCode: RfmSegmentCodeEnum.NEW_CUSTOMERS,
        totalOrdersCount: 0,
        successfulDeliveriesCount: 0,
        returnedOrdersCount: 0,
        deliveryTrustScore: 80,
        isBlacklisted: false,
        lifetimeValueAmount: 0,
        loyaltyPointsBalance: 0,
        walletCreditBalance: 0,
        heightCm: extractedNer.heightCm || null,
        weightKg: extractedNer.weightKg || null,
        preferredSize: extractedNer.sizes?.[0] || null,
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
      if (extractedNer.addressLine) {
        customer.defaultAddressLine = extractedNer.addressLine;
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

    const enriched = this.enrichCustomerWithTrustEvaluation(savedCustomer);

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      conversation.id,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.CRM_PROFILE_UPDATED,
      {
        conversationId: conversation.id,
        customer: enriched,
      },
    );

    return {
      customer: savedCustomer,
      isNewlyCollectedPhone,
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
        deliveryTrustScore: 98,
        isBlacklisted: false,
        lifetimeValueAmount: 18500000,
        loyaltyPointsBalance: 1850,
        walletCreditBalance: 250000,
        heightCm: 162,
        weightKg: 51,
        preferredSize: 'M',
        notes: 'Khách VIP ưu tiên giao giờ hành chính, thích màu kem và pastel.',
        linkedExternalIdentitiesJson: [
          {
            channelType: ChannelTypeEnum.FACEBOOK_PAGE,
            channelIntegrationId: null,
            pageShortCode: 'FB-MAIN',
            pageName: 'Fanpage Thời Trang Chính',
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
        deliveryTrustScore: 90,
        isBlacklisted: false,
        lifetimeValueAmount: 6200000,
        loyaltyPointsBalance: 620,
        walletCreditBalance: 120000,
        heightCm: 158,
        weightKg: 48,
        preferredSize: 'S',
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
        deliveryTrustScore: 14,
        isBlacklisted: true,
        blacklistReason: 'Đặt 3 đơn COD liên tiếp nhưng tắt máy không nhận hàng (Bom hàng).',
        lifetimeValueAmount: 0,
        loyaltyPointsBalance: 0,
        walletCreditBalance: 0,
        preferredSize: 'L',
        notes: 'Bắt buộc yêu cầu chuyển khoản đặt cọc VietQR 100% trước khi gửi hàng.',
        linkedExternalIdentitiesJson: [
          {
            channelType: ChannelTypeEnum.FACEBOOK_PAGE,
            channelIntegrationId: null,
            pageShortCode: 'FB-MAIN',
            pageName: 'Fanpage Thời Trang Chính',
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
    const shop = await this.shopRepo.findOne({
      where: { id: shopId },
      select: ['id', 'requireDepositOnHighRisk'],
    });
    const requireDeposit = shop?.requireDepositOnHighRisk ?? true;

    const qb = this.customerRepo.createQueryBuilder('c').where('c.shop_id = :shopId', { shopId });

    if (query.tier) {
      qb.andWhere('c.tier = :tier', { tier: query.tier });
    }
    if (query.rfmSegment) {
      qb.andWhere('c.rfm_segment_code = :rfmSegment', { rfmSegment: query.rfmSegment });
    }
    if (query.highRiskOnly) {
      qb.andWhere(
        '(c.delivery_trust_score < 50 OR c.is_blacklisted = true OR c.returned_orders_count >= 2)',
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
    const items = rawItems.map((c) => this.enrichCustomerWithTrustEvaluation(c, requireDeposit));

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
  }> {
    const [customer, shop] = await Promise.all([
      this.customerRepo.findOne({ where: { id: customerId, shopId } }),
      this.shopRepo.findOne({
        where: { id: shopId },
        select: ['id', 'requireDepositOnHighRisk'],
      }),
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
        shop?.requireDepositOnHighRisk ?? true,
      ),
      walletLedgers,
      linkedConversations,
    };
  }

  /**
   * Lấy Hồ sơ Khách hàng CRM 360° gắn với một cuộc hội thoại (`conversationId`) để hiển thị ngay trên `Customer360Panel` bên phải khung Chat
   */
  public async getCustomer360ByConversationId(
    shopId: string,
    conversationId: string,
  ): Promise<{
    customer: (CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult }) | null;
    walletLedgers: CustomerWalletLedgerEntity[];
    linkedConversations: ConversationEntity[];
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
        return this.getCustomer360ById(effectiveShopId, existing.id);
      }
    }

    // Tự động khởi tạo hồ sơ CRM 360° từ thông tin cuộc hội thoại nếu chưa có
    const extractedNer = this.nerService.extractCommerceEntities(conv.lastMessage || '');
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
   * Tạo mới hoặc cập nhật Hồ sơ Khách hàng CRM 360°
   */
  public async upsertCustomerProfile(
    shopId: string,
    customerId: string | null,
    dto: UpsertCustomerProfileDto,
  ): Promise<CustomerProfileEntity & { trustEvaluation: DeliveryTrustEvaluationResult }> {
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
        heightCm: dto.heightCm ?? null,
        weightKg: dto.weightKg ?? null,
        preferredSize: dto.preferredSize?.trim() || null,
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
      if (dto.email !== undefined) customer.email = dto.email?.trim() || null;
      if (dto.defaultProvinceCode !== undefined) {
        customer.defaultProvinceCode = dto.defaultProvinceCode || null;
        customer.defaultProvinceName = matchedProv?.name || customer.defaultProvinceName;
      }
      if (dto.defaultDistrictCode !== undefined) {
        customer.defaultDistrictCode = dto.defaultDistrictCode || null;
        customer.defaultDistrictName = matchedDist?.name || customer.defaultDistrictName;
      }
      if (dto.defaultWardCode !== undefined) {
        customer.defaultWardCode = dto.defaultWardCode || null;
        customer.defaultWardName = matchedWard?.name || customer.defaultWardName;
      }
      if (dto.defaultAddressLine !== undefined) {
        customer.defaultAddressLine = dto.defaultAddressLine?.trim() || null;
      }
      if (dto.tier !== undefined) customer.tier = dto.tier;
      if (dto.heightCm !== undefined) customer.heightCm = dto.heightCm;
      if (dto.weightKg !== undefined) customer.weightKg = dto.weightKg;
      if (dto.preferredSize !== undefined) customer.preferredSize = dto.preferredSize || null;
      if (dto.notes !== undefined) customer.notes = dto.notes || null;
      if (dto.activeTagIdsJson !== undefined) customer.activeTagIdsJson = dto.activeTagIdsJson;
    }

    const saved = await this.customerRepo.save(customer);

    if (dto.conversationId) {
      await this.conversationRepo.update(dto.conversationId, {
        customerId: saved.id,
        hasPhoneCollected: Boolean(saved.phoneMasked),
      });
    }

    return this.enrichCustomerWithTrustEvaluation(saved);
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
      isBlacklisted: customer.isBlacklisted,
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

    return this.enrichCustomerWithTrustEvaluation(saved);
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

    const beforeSnapshot = {
      deliveryTrustScore: customer.deliveryTrustScore,
      successfulDeliveriesCount: customer.successfulDeliveriesCount,
      returnedOrdersCount: customer.returnedOrdersCount,
    };

    customer.deliveryTrustScore = params.dto.deliveryTrustScore;
    if (params.dto.successfulDeliveriesCount !== undefined) {
      customer.successfulDeliveriesCount = params.dto.successfulDeliveriesCount;
    }
    if (params.dto.returnedOrdersCount !== undefined) {
      customer.returnedOrdersCount = params.dto.returnedOrdersCount;
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
        reason: params.dto.reason,
      },
    });

    return this.enrichCustomerWithTrustEvaluation(saved);
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

    const [primary, duplicate] = await Promise.all([
      this.customerRepo.findOne({ where: { id: dto.primaryCustomerId, shopId } }),
      this.customerRepo.findOne({ where: { id: dto.duplicateCustomerId, shopId } }),
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
      isBlacklisted: primary.isBlacklisted,
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

    return this.enrichCustomerWithTrustEvaluation(savedPrimary);
  }
}
