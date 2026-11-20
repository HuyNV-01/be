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
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import {
  CompletePackingAndPrintDto,
  ReprintShippingLabelDto,
  ScanPackingBarcodeDto,
} from 'src/dto/oms/oms-fulfillment.dto';
import { PosOrderEntity } from 'src/entity/pos-order.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { AtomicInventoryAndTransferService } from 'src/modules/catalog-pos/services/atomic-inventory-and-transfer.service';
import { EffectiveMemberContext } from 'src/modules/iam/iam.service';
import { Brackets, In, Repository } from 'typeorm';

import { OmsStateMachineService } from './oms-state-machine.service';

export interface ThermalPrintTemplateOptions {
  hideProductNames?: boolean;
  hideItemPrices?: boolean;
  showCodAmount?: boolean;
  showOrderNote?: boolean;
  showWarehouseInfo?: boolean;
  showBarcodeSvg?: boolean;
  copies?: number;
}

export interface ThermalFormatPaperSpec {
  code: ThermalLabelFormatEnum;
  label: string;
  widthMm: number;
  heightMm: number;
  marginMm: number;
  baseFontPx: number;
  barcodeHeightPx: number;
  isCompact: boolean;
}

export const THERMAL_PAPER_SPECS: Record<ThermalLabelFormatEnum, ThermalFormatPaperSpec> = {
  [ThermalLabelFormatEnum.A7_74X105]: {
    code: ThermalLabelFormatEnum.A7_74X105,
    label: 'Khổ nhiệt A7 (74 × 105mm)',
    widthMm: 74,
    heightMm: 105,
    marginMm: 2,
    baseFontPx: 9.5,
    barcodeHeightPx: 34,
    isCompact: true,
  },
  [ThermalLabelFormatEnum.A6_100X150]: {
    code: ThermalLabelFormatEnum.A6_100X150,
    label: 'Khổ nhiệt A6 chuẩn sàn (100 × 150mm)',
    widthMm: 100,
    heightMm: 150,
    marginMm: 3,
    baseFontPx: 11,
    barcodeHeightPx: 46,
    isCompact: false,
  },
  [ThermalLabelFormatEnum.K80_80X80]: {
    code: ThermalLabelFormatEnum.K80_80X80,
    label: 'Khổ nhiệt K80 vuông (80 × 80mm)',
    widthMm: 80,
    heightMm: 80,
    marginMm: 2,
    baseFontPx: 9.5,
    barcodeHeightPx: 30,
    isCompact: true,
  },
  [ThermalLabelFormatEnum.K80_80X100]: {
    code: ThermalLabelFormatEnum.K80_80X100,
    label: 'Khổ nhiệt K80 dài (80 × 100mm)',
    widthMm: 80,
    heightMm: 100,
    marginMm: 2.5,
    baseFontPx: 10,
    barcodeHeightPx: 36,
    isCompact: true,
  },
  [ThermalLabelFormatEnum.K58_58X80]: {
    code: ThermalLabelFormatEnum.K58_58X80,
    label: 'Khổ nhiệt mini K58 (58 × 80mm)',
    widthMm: 58,
    heightMm: 80,
    marginMm: 1.5,
    baseFontPx: 8.5,
    barcodeHeightPx: 26,
    isCompact: true,
  },
  [ThermalLabelFormatEnum.LABEL_75X100]: {
    code: ThermalLabelFormatEnum.LABEL_75X100,
    label: 'Tem nhiệt 75 × 100mm (J&T / VTP)',
    widthMm: 75,
    heightMm: 100,
    marginMm: 2,
    baseFontPx: 9.5,
    barcodeHeightPx: 34,
    isCompact: true,
  },
  [ThermalLabelFormatEnum.A5_148X210]: {
    code: ThermalLabelFormatEnum.A5_148X210,
    label: 'Khổ A5 tiêu chuẩn (148 × 210mm)',
    widthMm: 148,
    heightMm: 210,
    marginMm: 5,
    baseFontPx: 12.5,
    barcodeHeightPx: 54,
    isCompact: false,
  },
  [ThermalLabelFormatEnum.A4_210X297]: {
    code: ThermalLabelFormatEnum.A4_210X297,
    label: 'Khổ A4 hóa đơn giao nhận (210 × 297mm)',
    widthMm: 210,
    heightMm: 297,
    marginMm: 8,
    baseFontPx: 13.5,
    barcodeHeightPx: 60,
    isCompact: false,
  },
};

export interface ThermalShippingLabelPayload {
  orderId: string;
  orderCode: string;
  trackingNumber: string;
  carrierCode: string;
  labelFormat: ThermalLabelFormatEnum;
  paperSpec: ThermalFormatPaperSpec;
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

/**
 * Bảng mã hóa Code-128B chuẩn ISO/IEC 15417 giúp sinh vạch SVG quét được trực tiếp bằng súng mã vạch USB/Bluetooth
 * mà không cần phụ thuộc thư viện native hay CDN ngoài.
 */
const CODE128_PATTERNS = [
  '212222',
  '222122',
  '222221',
  '121223',
  '121322',
  '131222',
  '122213',
  '122312',
  '132212',
  '221213',
  '221312',
  '231212',
  '112232',
  '122132',
  '122231',
  '113222',
  '123122',
  '123221',
  '223211',
  '221132',
  '221231',
  '213212',
  '223112',
  '312131',
  '311222',
  '321122',
  '321221',
  '312212',
  '322112',
  '322211',
  '212123',
  '212321',
  '232121',
  '111323',
  '131123',
  '131321',
  '112313',
  '132113',
  '132311',
  '211313',
  '231113',
  '231311',
  '112133',
  '112331',
  '132131',
  '113123',
  '113321',
  '133121',
  '313121',
  '211331',
  '231131',
  '213113',
  '213311',
  '213131',
  '311123',
  '311321',
  '331121',
  '312113',
  '312311',
  '332111',
  '314111',
  '221411',
  '431111',
  '111224',
  '111422',
  '121124',
  '121421',
  '141122',
  '141221',
  '112214',
  '112412',
  '122114',
  '122411',
  '142112',
  '142211',
  '241211',
  '221114',
  '413111',
  '241112',
  '134111',
  '111242',
  '121142',
  '121241',
  '114212',
  '124112',
  '124211',
  '411212',
  '421112',
  '421211',
  '212141',
  '214121',
  '412121',
  '111143',
  '111341',
  '131141',
  '114113',
  '114311',
  '411113',
  '411311',
  '113141',
  '114131',
  '311141',
  '411131',
  '211412',
  '211214',
  '211232',
  '2331112',
];

function escapeHtml(raw: string | number | null | undefined): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateCode128Svg(value: string, barHeightPx = 42): string {
  const sanitized =
    String(value || 'ORD')
      .replace(/[^\x20-\x7E]/g, '')
      .slice(0, 48) || 'ORD';

  const codes: number[] = [104]; // Start Code B
  let checksum = 104;
  for (let i = 0; i < sanitized.length; i++) {
    const codeVal = sanitized.charCodeAt(i) - 32;
    if (codeVal >= 0 && codeVal <= 94) {
      codes.push(codeVal);
      checksum += codeVal * (i + 1);
    }
  }
  codes.push(checksum % 103);
  codes.push(106); // Stop

  const bars: string[] = [];
  let cursorX = 8; // Quiet zone
  for (const c of codes) {
    const pattern = CODE128_PATTERNS[c] || CODE128_PATTERNS[0];
    for (let idx = 0; idx < pattern.length; idx++) {
      const w = Number(pattern[idx]);
      if (idx % 2 === 0) {
        bars.push(`<rect x="${cursorX}" y="0" width="${w}" height="${barHeightPx}" fill="#000"/>`);
      }
      cursorX += w;
    }
  }
  const totalWidth = cursorX + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${barHeightPx}" style="width:100%;max-width:100%;height:${barHeightPx}px;display:block;">${bars.join('')}</svg>`;
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

  public listSupportedThermalFormats(): ThermalFormatPaperSpec[] {
    return Object.values(THERMAL_PAPER_SPECS);
  }

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

    if (
      order.status !== PosOrderStatusEnum.CONFIRMED &&
      order.status !== PosOrderStatusEnum.WAITING_PACKING &&
      order.status !== PosOrderStatusEnum.PACKED_READY_TO_SHIP
    ) {
      throw new BadRequestException(
        `Không thể quét mã vạch khi đơn ${order.orderCode} đang ở trạng thái ${order.status}.`,
      );
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
    return {
      matched: true,
      errorCode: null,
      matchedSkuCode: targetItem.skuCode,
      message: `Đã xác nhận ${targetItem.skuCode} (${targetItem.packedScannedQty}/${targetItem.quantity})`,
      order: saved,
      progress: this.computePackingProgress(saved),
    };
  }

  public async resetPackingScanProgress(shopId: string, orderId: string) {
    const order = await this.orderRepo.findOne({ where: { id: orderId, shopId } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (
      order.status !== PosOrderStatusEnum.WAITING_PACKING &&
      order.status !== PosOrderStatusEnum.PACKED_READY_TO_SHIP
    ) {
      throw new BadRequestException('Chỉ có thể đặt lại phiên quét cho đơn chưa bàn giao bưu tá.');
    }

    order.itemsJson = (order.itemsJson || []).map((item) => ({
      ...item,
      packedScannedQty: 0,
    }));
    order.status = PosOrderStatusEnum.WAITING_PACKING;
    const saved = await this.orderRepo.save(order);
    return { order: saved, progress: this.computePackingProgress(saved) };
  }

  public async completePackingAndGenerateLabel(params: {
    shopId: string;
    orderId: string;
    actorUserId: string;
    actorName: string;
    memberContext?: EffectiveMemberContext;
    dto: CompletePackingAndPrintDto & { templateOptions?: ThermalPrintTemplateOptions };
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
      reasonNote: `Hoàn tất đóng gói (${saved.actualPackedWeightGrams}g) & in phiếu khổ ${params.dto.labelFormat || ThermalLabelFormatEnum.A6_100X150} lần ${saved.printedCount}`,
      beforeSnapshot,
      afterSnapshot: this.stateMachineService.buildRevisionSnapshot(saved),
    });

    const shop = await this.shopRepo.findOne({ where: { id: params.shopId } });
    const labelPayload = this.buildThermalLabelPayload(
      saved,
      shop?.name || 'Pancake Seller OS',
      params.dto.labelFormat || ThermalLabelFormatEnum.A6_100X150,
      params.dto.templateOptions,
    );

    this.realtimeEmitter.emitToRoom(
      SOCKET_CONFIG.namespaces.CHAT,
      `shop:${params.shopId}`,
      'oms:order_packed_printed',
      {
        shopId: params.shopId,
        orderId: saved.id,
        orderCode: saved.orderCode,
        printedCount: saved.printedCount,
        labelFormat: labelPayload.labelFormat,
        actualPackedWeightGrams: saved.actualPackedWeightGrams,
      },
    );

    return { order: saved, labelPayload };
  }

  public async reprintShippingLabel(params: {
    shopId: string;
    orderId: string;
    actorUserId: string;
    actorName: string;
    dto: ReprintShippingLabelDto & { templateOptions?: ThermalPrintTemplateOptions };
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
      reasonNote: `In lại lần ${saved.printedCount} (${params.dto.labelFormat}): ${params.dto.reprintReason}`,
      beforeSnapshot,
      afterSnapshot: this.stateMachineService.buildRevisionSnapshot(saved),
    });

    const shop = await this.shopRepo.findOne({ where: { id: params.shopId } });
    const labelPayload = this.buildThermalLabelPayload(
      saved,
      shop?.name || 'Pancake Seller OS',
      params.dto.labelFormat,
      params.dto.templateOptions,
    );

    return { order: saved, labelPayload };
  }

  /**
   * In hàng loạt nhiều vận đơn trong 1 tài liệu HTML duy nhất với `@page` + `page-break-after: always`.
   */
  public async batchGenerateShippingLabels(params: {
    shopId: string;
    orderIds: string[];
    labelFormat: ThermalLabelFormatEnum;
    templateOptions?: ThermalPrintTemplateOptions;
    actorUserId: string;
    actorName: string;
  }): Promise<{
    count: number;
    labelFormat: ThermalLabelFormatEnum;
    combinedHtmlTemplate: string;
  }> {
    const orders = await this.orderRepo.find({
      where: { shopId: params.shopId, id: In(params.orderIds) },
    });
    if (orders.length === 0) {
      throw new NotFoundException('Không tìm thấy đơn hàng nào để in hàng loạt');
    }

    const shop = await this.shopRepo.findOne({ where: { id: params.shopId } });
    const spec =
      THERMAL_PAPER_SPECS[params.labelFormat] ||
      THERMAL_PAPER_SPECS[ThermalLabelFormatEnum.A6_100X150];
    const shopName = shop?.name || 'Pancake Seller OS';

    const pageFragments: string[] = [];
    for (const order of orders) {
      order.printedCount = Number(order.printedCount || 0) + 1;
      order.lastPrintedAt = new Date();
      await this.orderRepo.save(order);
      pageFragments.push(
        this.renderSingleLabelSectionHtml(order, shopName, spec, params.templateOptions),
      );
    }

    const combinedHtmlTemplate = this.wrapThermalDocumentHtml(
      `In hàng loạt ${orders.length} vận đơn (${spec.label})`,
      spec,
      pageFragments.join('\n'),
    );

    return {
      count: orders.length,
      labelFormat: spec.code,
      combinedHtmlTemplate,
    };
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

  private renderSingleLabelSectionHtml(
    order: PosOrderEntity,
    shopName: string,
    spec: ThermalFormatPaperSpec,
    options?: ThermalPrintTemplateOptions,
  ): string {
    const isReprint = order.printedCount >= 2;
    const reprintWatermarkText = isReprint ? `BẢN IN LẠI LẦN ${order.printedCount}` : null;
    const tracking = order.trackingNumber || order.orderCode;
    const fullAddress =
      order.fullThreeTierAddress ||
      order.fullFourTierAddress ||
      order.receiverAddressLine ||
      'Nhận tại cửa hàng';

    const showBarcodeSvg = options?.showBarcodeSvg !== false;
    const showCodAmount = options?.showCodAmount !== false;
    const showOrderNote = options?.showOrderNote !== false;
    const showWarehouseInfo = options?.showWarehouseInfo !== false;
    const hideProductNames = Boolean(options?.hideProductNames);
    const hideItemPrices = Boolean(options?.hideItemPrices);
    const copies = Math.max(1, Math.min(5, Number(options?.copies || 1)));

    const barcodeSvgHtml = showBarcodeSvg
      ? `<div class="svg-barcode">${generateCode128Svg(tracking, spec.barcodeHeightPx)}</div>`
      : '';

    const itemsRowsHtml = (order.itemsJson || [])
      .map((i, idx) => {
        const displayName = hideProductNames
          ? `Sản phẩm mã ${escapeHtml(i.skuCode)}`
          : `${escapeHtml(i.variantName)} (${escapeHtml(i.skuCode)})`;
        const priceCell =
          !spec.isCompact && !hideItemPrices
            ? `<td style="padding:2px 4px;text-align:right;border-bottom:1px dashed #999;">${Number(i.finalUnitPrice || 0).toLocaleString('vi-VN')}đ</td>`
            : '';
        return `<tr><td style="padding:2px 3px;border-bottom:1px dashed #999;">${idx + 1}. ${displayName}</td>${priceCell}<td style="padding:2px 3px;text-align:right;font-weight:700;border-bottom:1px dashed #999;white-space:nowrap;">x${i.quantity}</td></tr>`;
      })
      .join('');

    const watermarkHtml = reprintWatermarkText
      ? `<div class="watermark">${escapeHtml(reprintWatermarkText)}</div>`
      : '';

    const singleCopy = `<section class="label-page">
  ${watermarkHtml}
  <div class="box">
    <div class="header">
      <div><strong>${escapeHtml(shopName)}</strong>${showWarehouseInfo ? `<br/><span>Kho: ${escapeHtml(order.warehouseName)}</span>` : ''}</div>
      <div style="text-align:right;"><strong>${escapeHtml(order.carrierCode)}</strong><br/><span>${order.isTwoWayExchange ? '[ĐỔI HÀNG 2 CHIỀU]' : escapeHtml(order.carrierServiceName)}</span></div>
    </div>
    <div class="barcode-block">
      ${barcodeSvgHtml}
      <div class="tracking-text">${escapeHtml(tracking)}</div>
      <div class="meta-line">Đơn: ${escapeHtml(order.orderCode)} | Cân: ${order.actualPackedWeightGrams || order.totalWeightGrams}g | Khổ: ${spec.widthMm}x${spec.heightMm}mm</div>
    </div>
    <div class="receiver-block">
      <div><strong>Người nhận:</strong> ${escapeHtml(order.customerName)} (${escapeHtml(order.customerPhoneMasked)})</div>
      <div><strong>Địa chỉ:</strong> ${escapeHtml(fullAddress)}</div>
    </div>
    <table class="items-table">${itemsRowsHtml}</table>
    ${
      showCodAmount
        ? `<div class="cod">THU HỘ COD: ${Number(order.codCollectAmount || 0).toLocaleString('vi-VN')} đ</div>`
        : `<div class="cod">ĐƠN ĐÃ THANH TOÁN (COD: 0 đ)</div>`
    }
    ${showOrderNote && order.note ? `<div class="note"><em>Ghi chú: ${escapeHtml(order.note)}</em></div>` : ''}
  </div>
</section>`;

    return Array.from({ length: copies }, () => singleCopy).join('\n');
  }

  private wrapThermalDocumentHtml(
    title: string,
    spec: ThermalFormatPaperSpec,
    bodyHtml: string,
  ): string {
    return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: ${spec.widthMm}mm ${spec.heightMm}mm; margin: ${spec.marginMm}mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: ${spec.baseFontPx}px; color: #000; margin: 0; padding: 0; line-height: 1.3; }
  .label-page { position: relative; width: 100%; page-break-after: always; break-after: page; padding: 1mm; }
  .label-page:last-child { page-break-after: auto; break-after: auto; }
  .box { border: 1.5px solid #000; padding: ${spec.isCompact ? '4px' : '6px'}; position: relative; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1.5px solid #000; padding-bottom: 3px; margin-bottom: 4px; gap: 4px; }
  .barcode-block { text-align: center; padding: 4px 0; border-bottom: 1px dashed #000; }
  .svg-barcode { margin: 0 auto 2px; max-width: 96%; }
  .tracking-text { font-family: 'Courier New', monospace; font-size: ${spec.baseFontPx + 2}px; font-weight: 800; letter-spacing: 1px; }
  .meta-line { font-size: ${Math.max(7.5, spec.baseFontPx - 1.5)}px; color: #111; margin-top: 2px; }
  .receiver-block { padding: 4px 0; border-bottom: 1px solid #000; word-break: break-word; }
  .items-table { width: 100%; border-collapse: collapse; margin-top: 3px; font-size: ${Math.max(8, spec.baseFontPx - 0.5)}px; }
  .cod { font-size: ${spec.baseFontPx + 3.5}px; font-weight: 900; text-align: center; padding: ${spec.isCompact ? '4px' : '6px'}; border: 1.5px solid #000; margin-top: 5px; }
  .note { margin-top: 3px; font-size: ${Math.max(7.5, spec.baseFontPx - 1)}px; }
  .watermark { position: absolute; top: 40%; left: 6%; right: 6%; text-align: center; font-size: ${spec.baseFontPx + 6}px; font-weight: 900; color: rgba(220,38,38,0.26); transform: rotate(-22deg); pointer-events: none; border: 2px solid rgba(220,38,38,0.26); padding: 3px; z-index: 10; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
  }

  private buildThermalLabelPayload(
    order: PosOrderEntity,
    shopName: string,
    labelFormat: ThermalLabelFormatEnum,
    templateOptions?: ThermalPrintTemplateOptions,
  ): ThermalShippingLabelPayload {
    const spec =
      THERMAL_PAPER_SPECS[labelFormat] || THERMAL_PAPER_SPECS[ThermalLabelFormatEnum.A6_100X150];
    const isReprint = order.printedCount >= 2;
    const reprintWatermarkText = isReprint ? `BẢN IN LẠI LẦN ${order.printedCount}` : null;
    const tracking = order.trackingNumber || order.orderCode;
    const fullAddress =
      order.fullThreeTierAddress ||
      order.fullFourTierAddress ||
      order.receiverAddressLine ||
      'Nhận tại cửa hàng';

    const sectionHtml = this.renderSingleLabelSectionHtml(order, shopName, spec, templateOptions);
    const htmlTemplate = this.wrapThermalDocumentHtml(
      `Phiếu giao hàng ${order.orderCode} (${spec.label})`,
      spec,
      sectionHtml,
    );

    return {
      orderId: order.id,
      orderCode: order.orderCode,
      trackingNumber: tracking,
      carrierCode: order.carrierCode,
      labelFormat: spec.code,
      paperSpec: spec,
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
