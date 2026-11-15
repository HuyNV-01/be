import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  AdsConversionEventNameEnum,
  AdsConversionPlatformEnum,
  CustomerWalletLedgerTypeEnum,
  CustomerWalletTransactionTypeEnum,
  NotificationResourceTypeEnum,
  NotificationTypeEnum,
  PosOrderPaymentStatusEnum,
  PosOrderStatusEnum,
  ShopRoleEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  GenerateOrderVietQrDto,
  VietQrPaymentWebhookDto,
} from 'src/dto/catalog-pos/catalog-pos.dto';
import { PosOrderEntity, VietQrEmvcoPayloadInfo } from 'src/entity/pos-order.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { AdsConversionSyncService } from 'src/modules/crm/services/ads-conversion-sync.service';
import { CustomerRfmAndLoyaltyService } from 'src/modules/crm/services/customer-rfm-and-loyalty.service';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import { Repository } from 'typeorm';

@Injectable()
export class VietQrEmvcoAndCounterPosService {
  private readonly logger = new Logger(VietQrEmvcoAndCounterPosService.name);

  constructor(
    @InjectRepository(PosOrderEntity)
    private readonly orderRepo: Repository<PosOrderEntity>,
    @InjectRepository(ShopMemberEntity)
    private readonly memberRepo: Repository<ShopMemberEntity>,
    private readonly rfmAndLoyaltyService: CustomerRfmAndLoyaltyService,
    private readonly adsConversionSyncService: AdsConversionSyncService,
    private readonly notificationsService: NotificationsService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private formatTlv(id: string, value: string): string {
    const len = String(value.length).padStart(2, '0');
    return `${id}${len}${value}`;
  }

  /**
   * Tính mã kiểm tra `CRC-16/CCITT-FALSE` (đa thức `0x1021`, khởi tạo `0xFFFF`)
   * theo đúng tiêu chuẩn kỹ thuật [NAPAS VietQR EMVCo](https://napas.com.vn/dich-vu-chuyen-tien-nhanh-napas-247).
   */
  public computeEmvcoCrc16CcittFalse(payloadWithoutCrcValue: string): string {
    let crc = 0xffff;
    for (let i = 0; i < payloadWithoutCrcValue.length; i++) {
      crc ^= payloadWithoutCrcValue.charCodeAt(i) << 8;
      for (let bit = 0; bit < 8; bit++) {
        if ((crc & 0x8000) !== 0) {
          crc = ((crc << 1) ^ 0x1021) & 0xffff;
        } else {
          crc = (crc << 1) & 0xffff;
        }
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  /**
   * Công cụ `T08` (`F06.4`):
   * Sinh chuỗi Payload EMVCo VietQR Động chuẩn NAPAS 247 khóa cứng Số tiền và Nội dung chuyển khoản `SEVQR ORD{orderCode}`
   */
  public buildDynamicVietQrPayload(params: {
    orderCode: string;
    amountVnd: number;
    bankBin?: string;
    bankShortName?: string;
    accountNumber?: string;
    accountName?: string;
  }): VietQrEmvcoPayloadInfo {
    const bankBin = (params.bankBin || '970422').trim();
    const bankShortName = (params.bankShortName || 'MBBank').trim();
    const accountNumber = (params.accountNumber || '0988123456888').trim();
    const accountName = (params.accountName || 'CONG TY TNHH PANCAKE SELLER OS').trim();
    const amountVnd = Math.max(1000, Math.round(Number(params.amountVnd || 0)));
    const cleanOrderCode = params.orderCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const transferReferenceCode = `SEVQR ORD${cleanOrderCode}`;

    // Tag 38: Merchant Account Information cho NAPAS 247 (GUID A000000727)
    const beneficiaryAcquirer = this.formatTlv('00', bankBin) + this.formatTlv('01', accountNumber);
    const merchantAccountInfo =
      this.formatTlv('00', 'A000000727') +
      this.formatTlv('01', beneficiaryAcquirer) +
      this.formatTlv('02', 'QRIBFTTA');

    // Tag 62: Additional Data Field Template (Sub-tag 08: Purpose of Transaction)
    const additionalDataField = this.formatTlv('08', transferReferenceCode);

    const payloadWithoutCrc =
      this.formatTlv('00', '01') + // Payload Format Indicator
      this.formatTlv('01', '12') + // Point of Initiation Method: 12 = Dynamic QR
      this.formatTlv('38', merchantAccountInfo) +
      this.formatTlv('53', '704') + // Transaction Currency: 704 = VND
      this.formatTlv('54', String(amountVnd)) +
      this.formatTlv('58', 'VN') +
      this.formatTlv('62', additionalDataField) +
      '6304';

    const crcHex = this.computeEmvcoCrc16CcittFalse(payloadWithoutCrc);
    const emvcoRawPayload = `${payloadWithoutCrc}${crcHex}`;

    const qrImageUrl = `https://img.vietqr.io/image/${encodeURIComponent(
      bankBin,
    )}-${encodeURIComponent(accountNumber)}-compact2.png?amount=${amountVnd}&addInfo=${encodeURIComponent(
      transferReferenceCode,
    )}&accountName=${encodeURIComponent(accountName)}`;

    return {
      bankBin,
      bankShortName,
      accountNumber,
      accountName,
      amountVnd,
      transferReferenceCode,
      emvcoRawPayload,
      qrImageUrl,
      generatedAt: new Date().toISOString(),
      paidAt: null,
      bankTransactionId: null,
    };
  }

  public async regenerateVietQrForOrder(
    shopId: string,
    orderId: string,
    dto: GenerateOrderVietQrDto,
  ): Promise<PosOrderEntity> {
    const order = await this.orderRepo.findOne({ where: { id: orderId, shopId } });
    if (!order) {
      throw new NotFoundException('POS_ORDER_NOT_FOUND');
    }

    const amountVnd =
      dto.amountVnd ??
      (Number(order.depositRequiredAmount || 0) > 0
        ? Number(order.depositRequiredAmount)
        : Number(order.totalPayableAmount));

    order.vietqrPayloadJson = this.buildDynamicVietQrPayload({
      orderCode: order.orderCode,
      amountVnd,
      bankBin: dto.bankBin,
      bankShortName: dto.bankShortName,
      accountNumber: dto.accountNumber,
      accountName: dto.accountName,
    });

    return this.orderRepo.save(order);
  }

  /**
   * F06.4 & Công cụ `T08`:
   * Xử lý Webhook biến động số dư ngân hàng (Casso / SePay / NAPAS VietQR) hoặc xác nhận gạch nợ chuyển khoản:
   * - Tự động cập nhật `paidTransferAmount`, giảm `codCollectAmount` tương ứng.
   * - Nếu khách chuyển khoản dư (`overpaymentAmount > 0`), tự động cộng phần tiền thừa vào Ví khách hàng (`walletCreditBalance` — `F11.4`).
   * - Tự động kích hoạt sự kiện chuyển đổi `Purchase` lên `Meta CAPI` (`F11.1`) và phát sự kiện WebSocket `pos:vietqr_payment_confirmed`.
   */
  public async handleVietQrPaymentWebhook(
    shopId: string,
    dto: VietQrPaymentWebhookDto,
  ): Promise<{
    order: PosOrderEntity;
    overpaymentCreditedToWallet: number;
  }> {
    const refClean = dto.orderIdOrReference.trim();
    let order = await this.orderRepo.findOne({
      where: { id: refClean, shopId },
    });

    if (!order) {
      order = await this.orderRepo.findOne({
        where: { orderCode: refClean, shopId },
      });
    }

    if (!order) {
      // Bóc tách mã đơn từ nội dung chuyển khoản `SEVQR ORD...`
      const extractedMatch = (dto.transferContent || refClean).match(/ORD([A-Z0-9-]+)/i);
      if (extractedMatch) {
        const candidateCode = extractedMatch[1];
        const allRecent = await this.orderRepo.find({
          where: { shopId },
          order: { createdAt: 'DESC' },
          take: 50,
        });
        order =
          allRecent.find(
            (o) =>
              o.orderCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase() ===
              candidateCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
          ) || null;
      }
    }

    if (!order) {
      throw new NotFoundException('POS_ORDER_NOT_FOUND_FOR_VIETQR_WEBHOOK');
    }

    const paidAmount = Math.max(0, Number(dto.paidAmountVnd || 0));
    const totalPayable = Number(order.totalPayableAmount || 0);
    const nextPaidTransfer = Number(order.paidTransferAmount || 0) + paidAmount;

    order.paidTransferAmount = nextPaidTransfer;
    order.codCollectAmount = Math.max(0, totalPayable - nextPaidTransfer);

    if (nextPaidTransfer >= totalPayable) {
      order.paymentStatus = PosOrderPaymentStatusEnum.PAID_IN_FULL;
    } else if (nextPaidTransfer > 0) {
      order.paymentStatus = PosOrderPaymentStatusEnum.PARTIAL_DEPOSIT_PAID;
    }

    if (order.status === PosOrderStatusEnum.WAITING_DEPOSIT) {
      order.status = PosOrderStatusEnum.WAITING_PACKING;
    }

    const nowIso = new Date().toISOString();
    const txId = dto.bankTransactionId || `FT_${Date.now()}`;
    if (order.vietqrPayloadJson) {
      order.vietqrPayloadJson = {
        ...order.vietqrPayloadJson,
        paidAt: nowIso,
        bankTransactionId: txId,
      };
    }

    const savedOrder = await this.orderRepo.save(order);

    // Nếu khách chuyển khoản dư so với tổng tiền phải thu, tự động cộng tiền dư vào Ví khách hàng (F11.4)
    const overpaymentCreditedToWallet = Math.max(0, nextPaidTransfer - totalPayable);
    if (overpaymentCreditedToWallet > 0 && savedOrder.customerId) {
      await this.rfmAndLoyaltyService
        .adjustCustomerWalletOrPoints({
          shopId,
          customerId: savedOrder.customerId,
          actorUserId: 'vietqr_webhook',
          dto: {
            ledgerType: CustomerWalletLedgerTypeEnum.WALLET_CREDIT,
            transactionType: CustomerWalletTransactionTypeEnum.OVERPAYMENT_CREDIT,
            deltaAmount: overpaymentCreditedToWallet,
            referenceOrderId: savedOrder.orderCode,
            note: `Cộng tiền chuyển khoản VietQR dư (+${overpaymentCreditedToWallet.toLocaleString('vi-VN')}đ) từ đơn ${savedOrder.orderCode}`,
          },
        })
        .catch(() => null);
    }

    // Tự động bắn sự kiện Purchase lên Meta CAPI nếu đơn hàng thuộc hội thoại quảng cáo (F11.1)
    if (savedOrder.conversationId) {
      await this.adsConversionSyncService
        .dispatchConversionEvent(shopId, {
          platform: AdsConversionPlatformEnum.META_CAPI,
          eventName: AdsConversionEventNameEnum.PURCHASE,
          conversationId: savedOrder.conversationId,
          customerId: savedOrder.customerId || undefined,
          orderId: savedOrder.orderCode,
          valueAmount: totalPayable,
          currency: 'VND',
        })
        .catch(() => null);

      this.realtimeEmitter.emitToConversation(
        SOCKET_CONFIG.namespaces.CHAT,
        savedOrder.conversationId,
        SOCKET_CONFIG.events.POS_OMS.VIETQR_PAYMENT_CONFIRMED,
        {
          shopId,
          conversationId: savedOrder.conversationId,
          orderId: savedOrder.id,
          orderCode: savedOrder.orderCode,
          paidAmountVnd: paidAmount,
          totalPaidTransferAmount: savedOrder.paidTransferAmount,
          remainingCodAmount: savedOrder.codCollectAmount,
          paymentStatus: savedOrder.paymentStatus,
          bankTransactionId: txId,
          confirmedAt: nowIso,
        },
      );
    }

    return {
      order: savedOrder,
      overpaymentCreditedToWallet,
    };
  }
}
