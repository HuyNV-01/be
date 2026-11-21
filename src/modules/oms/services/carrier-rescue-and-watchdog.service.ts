import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  NotificationResourceTypeEnum,
  NotificationTypeEnum,
  OmsCarrierRescueActionEnum,
  OmsCarrierSlaBreachTypeEnum,
  PosOrderStatusEnum,
} from 'src/common/enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { CarrierRescueActionDto, CarrierWebhookPayloadDto } from 'src/dto/oms/oms-fulfillment.dto';
import { OrderCarrierEventEntity } from 'src/entity/order-carrier-event.entity';
import { PosOrderEntity } from 'src/entity/pos-order.entity';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import { In, LessThan, Repository } from 'typeorm';

import { OmsStateMachineService } from './oms-state-machine.service';

const CARRIER_RAW_STATUS_TO_OMS: Record<string, PosOrderStatusEnum> = {
  ready_to_pick: PosOrderStatusEnum.WAITING_PACKING,
  picking: PosOrderStatusEnum.PACKED_READY_TO_SHIP,
  picked: PosOrderStatusEnum.HANDED_TO_CARRIER,
  storing: PosOrderStatusEnum.IN_TRANSIT,
  transporting: PosOrderStatusEnum.IN_TRANSIT,
  sorting: PosOrderStatusEnum.IN_TRANSIT,
  delivering: PosOrderStatusEnum.IN_TRANSIT,
  money_collect_delivering: PosOrderStatusEnum.IN_TRANSIT,
  delivery_fail: PosOrderStatusEnum.DELIVERY_FAILED_RESCUE,
  delay_delivery: PosOrderStatusEnum.DELIVERY_FAILED_RESCUE,
  customer_unreachable: PosOrderStatusEnum.DELIVERY_FAILED_RESCUE,
  delivered: PosOrderStatusEnum.DELIVERED,
  waiting_to_return: PosOrderStatusEnum.DELIVERY_FAILED_RESCUE,
  return: PosOrderStatusEnum.RETURNING,
  return_transporting: PosOrderStatusEnum.RETURNING,
  return_sorting: PosOrderStatusEnum.RETURNING,
  returning: PosOrderStatusEnum.RETURNING,
  returned: PosOrderStatusEnum.RETURNING,
  cancel: PosOrderStatusEnum.CANCELLED,
};

const TERMINAL_ORDER_STATUSES = new Set<PosOrderStatusEnum>([
  PosOrderStatusEnum.DELIVERED_RECONCILED,
  PosOrderStatusEnum.RETURNED_RESTOCKED,
  PosOrderStatusEnum.CANCELLED,
]);

@Injectable()
export class CarrierRescueAndWatchdogService {
  private readonly logger = new Logger(CarrierRescueAndWatchdogService.name);

  constructor(
    @InjectRepository(PosOrderEntity)
    private readonly orderRepo: Repository<PosOrderEntity>,
    @InjectRepository(OrderCarrierEventEntity)
    private readonly carrierEventRepo: Repository<OrderCarrierEventEntity>,
    @InjectRedis()
    private readonly redis: Redis,
    private readonly eventEmitter: EventEmitter2,
    private readonly stateMachineService: OmsStateMachineService,
    private readonly notificationsService: NotificationsService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  public async processCarrierWebhook(carrierCode: string, dto: CarrierWebhookPayloadDto) {
    const normalizedCarrier = carrierCode.toUpperCase();
    const idempotencyKey = `oms:carrier_wh:${normalizedCarrier}:${dto.trackingNumber}:${dto.rawStatus}:${dto.eventId || dto.occurredAt || 'latest'}`;

    const acquired = await this.redis.set(idempotencyKey, '1', 'EX', 3600, 'NX');
    if (!acquired) {
      return { deduplicated: true, trackingNumber: dto.trackingNumber };
    }

    const order = await this.orderRepo.findOne({
      where: [
        { trackingNumber: dto.trackingNumber },
        ...(dto.clientOrderCode ? [{ orderCode: dto.clientOrderCode }] : []),
      ],
    });
    if (!order) {
      this.logger.warn(
        `[CarrierWebhook] Bỏ qua vận đơn lạ ${dto.trackingNumber} từ ${normalizedCarrier}`,
      );
      return { ignored: true, trackingNumber: dto.trackingNumber };
    }

    const mappedStatus = CARRIER_RAW_STATUS_TO_OMS[dto.rawStatus.trim().toLowerCase()] || null;
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();

    order.lastCarrierEventAt = occurredAt;
    if (dto.shipperName) order.shipperName = dto.shipperName;
    if (dto.shipperPhone) order.shipperPhone = dto.shipperPhone;
    if (dto.carrierChargedWeightGrams) {
      order.carrierChargedWeightGrams = Math.round(dto.carrierChargedWeightGrams);
    }
    if (dto.shippingFeeCarrierActual !== undefined) {
      order.shippingFeeCarrierActual = Number(dto.shippingFeeCarrierActual);
    }

    if (mappedStatus === PosOrderStatusEnum.DELIVERY_FAILED_RESCUE) {
      order.deliveryFailCount = Number(order.deliveryFailCount || 0) + 1;
      order.lastDeliveryFailReason = dto.reasonDescription || 'Khách không nghe máy / Hẹn giao lại';
      order.rescueDeadlineAt = new Date(Date.now() + 48 * 3600 * 1000);
      order.slaBreachType = OmsCarrierSlaBreachTypeEnum.NONE;
    }

    await this.orderRepo.save(order);

    await this.carrierEventRepo.save(
      this.carrierEventRepo.create({
        shopId: order.shopId,
        orderId: order.id,
        orderCode: order.orderCode,
        carrierCode: normalizedCarrier,
        trackingNumber: dto.trackingNumber,
        carrierRawStatus: dto.rawStatus,
        mappedOmsStatus: mappedStatus,
        description: dto.reasonDescription || `Cập nhật từ ${normalizedCarrier}: ${dto.rawStatus}`,
        locationHubName: dto.locationHubName || null,
        shipperName: dto.shipperName || null,
        shipperPhone: dto.shipperPhone || null,
        eventSource: 'WEBHOOK',
        eventOccurredAt: occurredAt,
        rawPayloadJson: dto as unknown as Record<string, unknown>,
      }),
    );

    if (mappedStatus && mappedStatus !== order.status) {
      try {
        await this.stateMachineService.transitionOrderStatus({
          shopId: order.shopId,
          orderId: order.id,
          actorUserId: 'SYSTEM_CARRIER_WEBHOOK',
          actorName: `${normalizedCarrier} Webhook`,
          dto: {
            targetStatus: mappedStatus,
            reasonNote: dto.reasonDescription || `Đồng bộ trạng thái ${dto.rawStatus}`,
          },
        });
      } catch (err) {
        this.logger.warn(
          `[CarrierWebhook] Không chuyển tự động ${order.orderCode} -> ${mappedStatus}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (mappedStatus === PosOrderStatusEnum.DELIVERY_FAILED_RESCUE) {
      await this.dispatchFailedDeliveryRescueAlerts(order);
    }

    return {
      processed: true,
      orderId: order.id,
      orderCode: order.orderCode,
      mappedStatus,
    };
  }

  public async listFailedRescueAndSlaOrders(shopId: string) {
    const failedRescueOrders = await this.orderRepo.find({
      where: { shopId, status: PosOrderStatusEnum.DELIVERY_FAILED_RESCUE },
      order: { rescueDeadlineAt: 'ASC', updatedAt: 'DESC' },
    });

    const slaBreachedOrders = await this.orderRepo.find({
      where: {
        shopId,
        slaBreachType: In([
          OmsCarrierSlaBreachTypeEnum.PICKUP_DELAYED,
          OmsCarrierSlaBreachTypeEnum.TRANSIT_STUCK,
          OmsCarrierSlaBreachTypeEnum.RESCUE_OVERDUE,
        ]),
      },
      order: { lastCarrierEventAt: 'ASC' },
    });

    return {
      failedRescueOrders,
      slaBreachedOrders,
      summary: {
        failedCount: failedRescueOrders.length,
        slaBreachedCount: slaBreachedOrders.length,
        totalCodAtRisk: failedRescueOrders.reduce(
          (sum, o) => sum + Number(o.codCollectAmount || 0),
          0,
        ),
      },
    };
  }

  public async executeCarrierRescueAction(params: {
    shopId: string;
    orderId: string;
    actorUserId: string;
    actorName: string;
    dto: CarrierRescueActionDto;
  }) {
    const order = await this.orderRepo.findOne({
      where: { id: params.orderId, shopId: params.shopId },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    if (TERMINAL_ORDER_STATUSES.has(order.status)) {
      throw new BadRequestException(
        `Đơn ${order.orderCode} đã ở trạng thái kết thúc (${order.status}), không thể gửi lệnh cứu đơn.`,
      );
    }

    const beforeSnapshot = this.stateMachineService.buildRevisionSnapshot(order);
    const ticketCode = `TKT-${order.carrierCode}-${Date.now().toString().slice(-6)}`;
    let actionDescription = '';

    if (params.dto.action === OmsCarrierRescueActionEnum.REDELIVER) {
      actionDescription = `Gửi lệnh GIỤC PHÁT LẠI tới ${order.carrierCode}. Ca giao mới: ${params.dto.preferredDeliverySlot || 'Sớm nhất trong ngày'}. ${params.dto.noteToCarrier || ''}`;
      order.status = PosOrderStatusEnum.IN_TRANSIT;
      order.slaBreachType = OmsCarrierSlaBreachTypeEnum.NONE;
      order.carrierTicketCode = ticketCode;
    } else if (params.dto.action === OmsCarrierRescueActionEnum.UPDATE_RECEIVER) {
      if (params.dto.updatedReceiverName) order.customerName = params.dto.updatedReceiverName;
      if (params.dto.updatedReceiverAddress) {
        order.receiverAddressLine = params.dto.updatedReceiverAddress;
        order.fullThreeTierAddress = params.dto.updatedReceiverAddress;
      }
      if (params.dto.updatedCodAmount !== undefined) {
        order.codCollectAmount = Number(params.dto.updatedCodAmount);
      }
      order.carrierTicketCode = ticketCode;
      actionDescription = `Cập nhật thông tin người nhận tại bưu cục ${order.carrierCode} (${params.dto.noteToCarrier || 'Đổi địa chỉ/SĐT/COD'})`;
    } else if (params.dto.action === OmsCarrierRescueActionEnum.APPROVE_RETURN) {
      order.status = PosOrderStatusEnum.RETURNING;
      order.slaBreachType = OmsCarrierSlaBreachTypeEnum.NONE;
      order.carrierTicketCode = ticketCode;
      actionDescription = `Xác nhận DUYỆT HOÀN SỚM về kho từ ${order.carrierCode}. Lý do: ${params.dto.noteToCarrier || 'Khách hủy nhận'}`;
    } else {
      order.carrierTicketCode = ticketCode;
      actionDescription = `Tạo phiếu khiếu nại / giục xử lý SLA (${ticketCode}) gửi ${order.carrierCode}: ${params.dto.noteToCarrier || 'Đơn ngâm quá hạn SLA'}`;
    }

    order.lastCarrierEventAt = new Date();
    const saved = await this.orderRepo.save(order);

    if (params.dto.action === OmsCarrierRescueActionEnum.APPROVE_RETURN) {
      this.eventEmitter.emit('oms.order.status_changed', {
        shopId: params.shopId,
        orderId: saved.id,
        status: saved.status,
        reasonNote: actionDescription,
      });
    }

    await this.carrierEventRepo.save(
      this.carrierEventRepo.create({
        shopId: params.shopId,
        orderId: saved.id,
        orderCode: saved.orderCode,
        carrierCode: saved.carrierCode,
        trackingNumber: saved.trackingNumber || saved.orderCode,
        carrierRawStatus: `manual_${params.dto.action.toLowerCase()}`,
        mappedOmsStatus: saved.status,
        description: actionDescription,
        eventSource: 'MANUAL_RESCUE',
        eventOccurredAt: new Date(),
      }),
    );

    await this.stateMachineService.appendOrderRevision({
      shopId: params.shopId,
      order: saved,
      actorUserId: params.actorUserId,
      actorName: params.actorName,
      actionType: `CARRIER_RESCUE_${params.dto.action}`,
      reasonNote: actionDescription,
      beforeSnapshot,
      afterSnapshot: this.stateMachineService.buildRevisionSnapshot(saved),
    });

    const rescueMessageTemplate = `Dạ bưu tá ${saved.carrierCode} vừa liên hệ giao đơn hàng #${saved.orderCode} nhưng chưa gặp được ạ. Shop đã cập nhật yêu cầu (${params.dto.preferredDeliverySlot || 'giao lại sớm nhất'}), anh/chị để ý điện thoại giúp shop nhé!`;

    return {
      order: saved,
      carrierTicketCode: ticketCode,
      actionDescription,
      suggestedCustomerRescueMessage: params.dto.notifyCustomerViaOmnichannel
        ? rescueMessageTemplate
        : null,
    };
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  public async scanCarrierSlaBreaches(): Promise<{
    pickupDelayedCount: number;
    transitStuckCount: number;
    rescueOverdueCount: number;
  }> {
    const now = Date.now();
    const pickupCutoff = new Date(now - 24 * 3600 * 1000);
    const transitCutoff = new Date(now - 36 * 3600 * 1000);
    const nowDate = new Date(now);

    const pickupDelayedOrders = await this.orderRepo.find({
      where: {
        status: PosOrderStatusEnum.PACKED_READY_TO_SHIP,
        packedAt: LessThan(pickupCutoff),
        slaBreachType: OmsCarrierSlaBreachTypeEnum.NONE,
      },
      take: 200,
    });

    for (const order of pickupDelayedOrders) {
      order.slaBreachType = OmsCarrierSlaBreachTypeEnum.PICKUP_DELAYED;
      await this.orderRepo.save(order);
      this.realtimeEmitter.emitToRoom(
        SOCKET_CONFIG.namespaces.CHAT,
        `shop:${order.shopId}`,
        'oms:sla_breach_alert',
        {
          shopId: order.shopId,
          orderId: order.id,
          orderCode: order.orderCode,
          slaBreachType: OmsCarrierSlaBreachTypeEnum.PICKUP_DELAYED,
        },
      );
    }

    const transitStuckOrders = await this.orderRepo.find({
      where: {
        status: In([PosOrderStatusEnum.HANDED_TO_CARRIER, PosOrderStatusEnum.IN_TRANSIT]),
        lastCarrierEventAt: LessThan(transitCutoff),
        slaBreachType: OmsCarrierSlaBreachTypeEnum.NONE,
      },
      take: 200,
    });

    for (const order of transitStuckOrders) {
      order.slaBreachType = OmsCarrierSlaBreachTypeEnum.TRANSIT_STUCK;
      await this.orderRepo.save(order);
      this.realtimeEmitter.emitToRoom(
        SOCKET_CONFIG.namespaces.CHAT,
        `shop:${order.shopId}`,
        'oms:sla_breach_alert',
        {
          shopId: order.shopId,
          orderId: order.id,
          orderCode: order.orderCode,
          slaBreachType: OmsCarrierSlaBreachTypeEnum.TRANSIT_STUCK,
        },
      );
    }

    const rescueOverdueOrders = await this.orderRepo.find({
      where: {
        status: PosOrderStatusEnum.DELIVERY_FAILED_RESCUE,
        rescueDeadlineAt: LessThan(nowDate),
        slaBreachType: OmsCarrierSlaBreachTypeEnum.NONE,
      },
      take: 200,
    });

    for (const order of rescueOverdueOrders) {
      order.slaBreachType = OmsCarrierSlaBreachTypeEnum.RESCUE_OVERDUE;
      await this.orderRepo.save(order);
      this.realtimeEmitter.emitToRoom(
        SOCKET_CONFIG.namespaces.CHAT,
        `shop:${order.shopId}`,
        'oms:sla_breach_alert',
        {
          shopId: order.shopId,
          orderId: order.id,
          orderCode: order.orderCode,
          slaBreachType: OmsCarrierSlaBreachTypeEnum.RESCUE_OVERDUE,
        },
      );
    }

    return {
      pickupDelayedCount: pickupDelayedOrders.length,
      transitStuckCount: transitStuckOrders.length,
      rescueOverdueCount: rescueOverdueOrders.length,
    };
  }

  private async dispatchFailedDeliveryRescueAlerts(order: PosOrderEntity): Promise<void> {
    // Kích hoạt AutoTagRuleEngine tự động gắn Tag đỏ "Cần cứu đơn gấp" lên cuộc hội thoại khách hàng
    if (order.conversationId) {
      this.eventEmitter.emit('carrier.delivery.failed', {
        shopId: order.shopId,
        conversationId: order.conversationId,
        messageContent: `Đơn ${order.orderCode} giao thất bại lần ${order.deliveryFailCount}: ${order.lastDeliveryFailReason || ''}`,
        actorUserId: 'SYSTEM_CARRIER_WEBHOOK',
      });
    }

    this.realtimeEmitter.emitToRoom(
      SOCKET_CONFIG.namespaces.CHAT,
      `shop:${order.shopId}`,
      'oms:failed_delivery_rescue_alert',
      {
        shopId: order.shopId,
        orderId: order.id,
        orderCode: order.orderCode,
        trackingNumber: order.trackingNumber,
        customerName: order.customerName,
        codCollectAmount: Number(order.codCollectAmount || 0),
        deliveryFailCount: order.deliveryFailCount,
        lastDeliveryFailReason: order.lastDeliveryFailReason,
        shipperName: order.shipperName,
        shipperPhone: order.shipperPhone,
        rescueDeadlineAt: order.rescueDeadlineAt?.toISOString() || null,
      },
    );

    if (order.createdByUserId) {
      await this.notificationsService.createAndDispatch({
        recipientIds: [order.createdByUserId],
        type: NotificationTypeEnum.SYSTEM,
        title: `🚨 Cần cứu đơn gấp #${order.orderCode}`,
        content: `Giao thất bại lần ${order.deliveryFailCount}: ${order.lastDeliveryFailReason || 'Khách không nghe máy'}`,
        resourceType: NotificationResourceTypeEnum.POS_ORDER,
        resourceId: order.id,
        dedupeKey: `oms_rescue_${order.id}_${order.deliveryFailCount}`,
        metadata: {
          shopId: order.shopId,
          orderId: order.id,
          orderCode: order.orderCode,
          actionUrl: '/orders/failed-rescue',
          extra: {
            trackingNumber: order.trackingNumber,
            carrierCode: order.carrierCode,
            deliveryFailCount: order.deliveryFailCount,
          },
        },
      });
    }
  }
}
