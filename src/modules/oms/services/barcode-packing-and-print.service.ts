import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { PosOrderStatusEnum, ThermalLabelFormatEnum } from 'src/common/enum';
import { PermissionCodeEnum } from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import {
  CompletePackingAndPrintDto,
  ReprintShippingLabelDto,
  ScanPackingBarcodeDto,
} from 'src/dto/oms/oms-fulfillment.dto';
import { PosOrderEntity } from 'src/entity/pos-order.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { AtomicInventoryAndTransferService } from 'src/modules/catalog-pos/services/atomic-inventory-and-transfer.service';
import { EffectiveMemberContext } from 'src/modules/iam/iam.service';
import { Brackets, Repository } from 'typeorm';

import { OmsStateMachineService } from './oms-state-machine.service';

export interface ThermalShippingLabelPayload {
  orderId: string;
  orderCode: string;
  trackingNumber: string;
  carrierCode: string;
  labelFormat: ThermalLabelFormatEnum;
  printedCount: number;
  isReprint: boolean;
  reprintWatermarkText: string | null;
  shopName: string;
  warehouseName: string;
  customerName: string;
  customerPhoneMasked: string;
  fullAddress: string;
  codCollectAmount: number;
  actualPackedWeightGrams: number;
  items: Array<{ skuCode: string; variantName: string; quantity: number }>;
  printedAtIso: string;
  htmlTemplate: string;
}

@Injectable()
export class BarcodePackingAndPrintService {
  constructor(
    @InjectRepository(PosOrderEntity)
    private readonly orderRepo: Repository<PosOrderEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    private readonly stateMachineService: OmsStateMachineService,
    private readonly inventoryService: AtomicInventoryAndTransferService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  public async lookupOrderForPacking(shopId: string, code: string) {
    const trimmed = code.trim();
    if (!trimmed) {
      throw new BadRequestException('Vui lòng quét mã đơn hàng hoặc mã vận đơn');
    }

    const order = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.shopId = :shopId', { shopId })
      .andWhere(
        new Brackets((b) => {
          b.where('o.orderCode = :code', { code: trimmed }).orWhere('o.trackingNumber = :code', {
            code: trimmed,
          });
        }),
      )
      .getOne();

    if (!order) {
      throw new NotFoundException(`Không tìm thấy đơn hàng với mã "${trimmed}"`);
    }

    if (
      order.status !== PosOrderStatusEnum.CONFIRMED &&
      order.status !== PosOrderStatusEnum.WAITING_PACKING &&
      order.status !== PosOrderStatusEnum.PACKED_READY_TO_SHIP
    ) {
      throw new BadRequestException(
        `Đơn ${order.orderCode} đang ở trạng thái ${order.status}, không thể đóng gói.`,
      );
    }

    if (order.status === PosOrderStatusEnum.CONFIRMED) {
      order.status = PosOrderStatusEnum.WAITING_PACKING;
      await this.orderRepo.save(order);
    }

    return {
      order,
      progress: this.computePackingProgress(order),
    };
  }

  public async scanItemBarcode(params: {
    shopId: string;
    orderId: string;
    actorUserId: string;
    dto: ScanPackingBarcodeDto;
  }) {
    const order = await this.orderRepo.findOne({
      where: { id: params.orderId, shopId: params.shopId },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    const scanned = params.dto.scannedCode.trim().toUpperCase();
    const qtyDelta = Math.max(1, params.dto.quantityDelta || 1);
    const items = [...(order.itemsJson || [])];

    const matchedIndex = items.findIndex(
      (i) =>
        (i.barcode && i.barcode.toUpperCase() === scanned) || i.skuCode.toUpperCase() === scanned,
    );

    if (matchedIndex < 0) {
      return {
        matched: false,
        errorCode: 'WRONG_SKU' as const,
        message: `CẢNH BÁO NHẶT SAI HÀNG: Mã "${scanned}" không có trong đơn ${order.orderCode}!`,
        order,
        progress: this.computePackingProgress(order),
      };
    }

    const targetItem = { ...items[matchedIndex] };
    const currentScanned = Number(targetItem.packedScannedQty || 0);
    if (currentScanned + qtyDelta > targetItem.quantity) {
      return {
        matched: false,
        errorCode: 'OVER_QUANTITY' as const,
        message: `CẢNH BÁO DƯ SỐ LƯỢNG: SKU ${targetItem.skuCode} đã quét đủ ${currentScanned}/${targetItem.quantity}!`,
        order,
        progress: this.computePackingProgress(order),
      };
    }

    if (targetItem.requiresSerialImei && !params.dto.serialNumber?.trim()) {
      return {
        matched: false,
        errorCode: 'SERIAL_REQUIRED' as const,
        message: `Sản phẩm ${targetItem.skuCode} yêu cầu quét kèm mã Serial / IMEI trước khi xác nhận!`,
        order,
        progress: this.computePackingProgress(order),
      };
    }

    if (params.dto.serialNumber?.trim()) {
      await this.inventoryService.scanAndBindSerialToOrder(params.shopId, {
        serialNumber: params.dto.serialNumber.trim(),
        orderId: order.id,
        customerId: order.customerId || undefined,
      });
      const existingSerials = new Set(targetItem.assignedSerialNumbers || []);
      existingSerials.add(params.dto.serialNumber.trim().toUpperCase());
      targetItem.assignedSerialNumbers = Array.from(existingSerials);
    }

    targetItem.packedScannedQty = currentScanned + qtyDelta;
    items[matchedIndex] = targetItem;
    order.itemsJson = items;

    const saved = await this.orderRepo.save(order);
    const progress = this.computePackingProgress(saved);

    return {
      matched: true,
      errorCode: null,
      matchedSkuCode: targetItem.skuCode,
      message: `Đã xác nhận ${targetItem.skuCode} (${targetItem.packedScannedQty}/${targetItem.quantity})`,
      order: saved,
      progress,
    };
  }

  public async completePackingAndGenerateLabel(params: {
    shopId: string;
    orderId: string;
    actorUserId: string;
    actorName: string;
    memberContext?: EffectiveMemberContext;
    dto: CompletePackingAndPrintDto;
  }): Promise<{ order: PosOrderEntity; labelPayload: ThermalShippingLabelPayload }> {
    const order = await this.orderRepo.findOne({
      where: { id: params.orderId, shopId: params.shopId },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    const progress = this.computePackingProgress(order);
    if (!progress.isComplete) {
      throw new BadRequestException(
        `Chưa quét đủ sản phẩm (${progress.scannedUnits}/${progress.requiredUnits}). Vui lòng kiểm đếm đủ 100% trước khi in phiếu!`,
      );
    }

    if (order.printedCount >= 1) {
      const canReprint = Boolean(
        params.memberContext?.permissions.includes(PermissionCodeEnum.OMS_SHIPPING_LABEL_REPRINT),
      );
      if (!canReprint) {
        throw new ForbiddenException(
          `Đơn ${order.orderCode} đã được in ${order.printedCount} lần. Cần quyền OMS_SHIPPING_LABEL_REPRINT để in lại.`,
        );
      }
    }

    const beforeSnapshot = this.stateMachineService.buildRevisionSnapshot(order);
    order.actualPackedWeightGrams = params.dto.actualPackedWeightGrams;
    if (params.dto.lengthCm && params.dto.widthCm && params.dto.heightCm) {
      order.packingBoxDimensionsJson = {
        lengthCm: params.dto.lengthCm,
        widthCm: params.dto.widthCm,
        heightCm: params.dto.heightCm,
      };
    }
    if (params.dto.packingVideoUrl?.trim()) {
      order.packingVideoUrl = params.dto.packingVideoUrl.trim();
    }

    order.packedByUserId = params.actorUserId;
    order.packedAt = new Date();
    order.printedCount = Number(order.printedCount || 0) + 1;
    order.lastPrintedAt = new Date();
    order.status = PosOrderStatusEnum.PACKED_READY_TO_SHIP;

    const saved = await this.orderRepo.save(order);

    await this.stateMachineService.appendOrderRevision({
      shopId: params.shopId,
      order: saved,
      actorUserId: params.actorUserId,
      actorName: params.actorName,
      actionType: 'BARCODE_PACK_AND_PRINT',
      reasonNote: `Hoàn tất đóng gói (${saved.actualPackedWeightGrams}g) & in phiếu lần ${saved.printedCount}`,
      beforeSnapshot,
      afterSnapshot: this.stateMachineService.buildRevisionSnapshot(saved),
    });

    const shop = await this.shopRepo.findOne({ where: { id: params.shopId } });
    const labelPayload = this.buildThermalLabelPayload(
      saved,
      shop?.name || 'Pancake Seller OS',
      params.dto.labelFormat || ThermalLabelFormatEnum.A6_100X150,
    );

    this.realtimeEmitter.emitToRoom('chat', `shop:${params.shopId}`, 'oms:order_packed_printed', {
      shopId: params.shopId,
      orderId: saved.id,
      orderCode: saved.orderCode,
      printedCount: saved.printedCount,
      actualPackedWeightGrams: saved.actualPackedWeightGrams,
    });

    return { order: saved, labelPayload };
  }

  public async reprintShippingLabel(params: {
    shopId: string;
    orderId: string;
    actorUserId: string;
    actorName: string;
    dto: ReprintShippingLabelDto;
  }): Promise<{ order: PosOrderEntity; labelPayload: ThermalShippingLabelPayload }> {
    const order = await this.orderRepo.findOne({
      where: { id: params.orderId, shopId: params.shopId },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    const beforeSnapshot = this.stateMachineService.buildRevisionSnapshot(order);
    order.printedCount = Number(order.printedCount || 0) + 1;
    order.lastPrintedAt = new Date();
    const saved = await this.orderRepo.save(order);

    await this.stateMachineService.appendOrderRevision({
      shopId: params.shopId,
      order: saved,
      actorUserId: params.actorUserId,
      actorName: params.actorName,
      actionType: 'REPRINT_SHIPPING_LABEL',
      reasonNote: `In lại lần ${saved.printedCount}: ${params.dto.reprintReason}`,
      beforeSnapshot,
      afterSnapshot: this.stateMachineService.buildRevisionSnapshot(saved),
    });

    const shop = await this.shopRepo.findOne({ where: { id: params.shopId } });
    const labelPayload = this.buildThermalLabelPayload(
      saved,
      shop?.name || 'Pancake Seller OS',
      params.dto.labelFormat,
    );

    return { order: saved, labelPayload };
  }

  public computePackingProgress(order: PosOrderEntity) {
    const items = order.itemsJson || [];
    const requiredUnits = items.reduce((sum, i) => sum + Number(i.quantity || 0), 0);
    const scannedUnits = items.reduce((sum, i) => sum + Number(i.packedScannedQty || 0), 0);
    const percent = requiredUnits > 0 ? Math.round((scannedUnits / requiredUnits) * 100) : 100;
    const isComplete = requiredUnits > 0 && scannedUnits >= requiredUnits;

    return {
      requiredUnits,
      scannedUnits,
      percent,
      isComplete,
    };
  }

  private buildThermalLabelPayload(
    order: PosOrderEntity,
    shopName: string,
    labelFormat: ThermalLabelFormatEnum,
  ): ThermalShippingLabelPayload {
    const isReprint = order.printedCount >= 2;
    const reprintWatermarkText = isReprint ? `BẢN IN LẠI LẦN ${order.printedCount}` : null;
    const tracking = order.trackingNumber || order.orderCode;
    const fullAddress =
      order.fullThreeTierAddress ||
      order.fullFourTierAddress ||
      order.receiverAddressLine ||
      'Nhận tại cửa hàng';

    const pageDimensions =
      labelFormat === ThermalLabelFormatEnum.K80_80X80
        ? '80mm 80mm'
        : labelFormat === ThermalLabelFormatEnum.A5_148X210
          ? '148mm 210mm'
          : '100mm 150mm';

    const itemsRowsHtml = (order.itemsJson || [])
      .map(
        (i, idx) =>
          `<tr><td style="padding:2px 4px;border-bottom:1px dashed #999;">${idx + 1}. ${i.variantName} (${i.skuCode})</td><td style="padding:2px 4px;text-align:right;font-weight:700;border-bottom:1px dashed #999;">x${i.quantity}</td></tr>`,
      )
      .join('');

    const watermarkHtml = reprintWatermarkText
      ? `<div style="position:fixed;top:42%;left:8%;right:8%;text-align:center;font-size:20px;font-weight:900;color:rgba(220,38,38,0.28);transform:rotate(-24deg);pointer-events:none;border:2px solid rgba(220,38,38,0.28);padding:4px;">${reprintWatermarkText}</div>`
      : '';

    const htmlTemplate = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<title>Phiếu giao hàng ${order.orderCode}</title>
<style>
  @page { size: ${pageDimensions}; margin: 3mm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #000; margin: 0; padding: 4px; }
  .box { border: 1.5px solid #000; padding: 6px; position: relative; }
  .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1.5px solid #000; padding-bottom: 4px; margin-bottom: 6px; }
  .barcode { font-family: 'Courier New', monospace; font-size: 15px; font-weight: 800; letter-spacing: 2px; text-align: center; padding: 6px 0; border-bottom: 1px dashed #000; }
  .cod { font-size: 16px; font-weight: 900; text-align: center; padding: 6px; border: 1.5px solid #000; margin-top: 6px; }
</style>
</head>
<body>
  ${watermarkHtml}
  <div class="box">
    <div class="header">
      <div><strong>${shopName}</strong><br/>Kho: ${order.warehouseName}</div>
      <div style="text-align:right;"><strong>${order.carrierCode}</strong><br/>${order.isTwoWayExchange ? '[ĐỔI HÀNG 2 CHIỀU]' : order.carrierServiceName}</div>
    </div>
    <div class="barcode">*${tracking}*<br/><span style="font-size:10px;letter-spacing:0;">Mã đơn: ${order.orderCode} | Cân: ${order.actualPackedWeightGrams || order.totalWeightGrams}g</span></div>
    <div style="padding:5px 0;border-bottom:1px solid #000;">
      <strong>Người nhận:</strong> ${order.customerName} (${order.customerPhoneMasked})<br/>
      <strong>Địa chỉ:</strong> ${fullAddress}
    </div>
    <table style="width:100%;border-collapse:collapse;margin-top:4px;">${itemsRowsHtml}</table>
    <div class="cod">THU HỘ COD: ${Number(order.codCollectAmount || 0).toLocaleString('vi-VN')} đ</div>
    ${order.note ? `<div style="margin-top:4px;font-size:10px;"><em>Ghi chú: ${order.note}</em></div>` : ''}
  </div>
</body>
</html>`;

    return {
      orderId: order.id,
      orderCode: order.orderCode,
      trackingNumber: tracking,
      carrierCode: order.carrierCode,
      labelFormat,
      printedCount: order.printedCount,
      isReprint,
      reprintWatermarkText,
      shopName,
      warehouseName: order.warehouseName,
      customerName: order.customerName,
      customerPhoneMasked: order.customerPhoneMasked,
      fullAddress,
      codCollectAmount: Number(order.codCollectAmount || 0),
      actualPackedWeightGrams: Number(order.actualPackedWeightGrams || order.totalWeightGrams || 0),
      items: (order.itemsJson || []).map((i) => ({
        skuCode: i.skuCode,
        variantName: i.variantName,
        quantity: i.quantity,
      })),
      printedAtIso: new Date().toISOString(),
      htmlTemplate,
    };
  }
}
