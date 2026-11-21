import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Request } from 'express';
import { ThermalLabelFormatEnum } from 'src/common/enum';
import { PermissionCodeEnum } from 'src/common/enum/permission.enum';
import { DBaseRes } from 'src/dto/base-res.dto';
import {
  CarrierRescueActionDto,
  CarrierWebhookPayloadDto,
  CompletePackingAndPrintDto,
  ConfirmCodReconciliationBatchDto,
  CreateCodReconciliationBatchDto,
  CreateRmaExchangeDto,
  DispatchCarrierBatchDto,
  ListCodReconciliationItemsQueryDto,
  ModifyConfirmedOrderDto,
  OmsOrderListQueryDto,
  ReprintShippingLabelDto,
  ScanPackingBarcodeDto,
  TransitionOrderStatusDto,
  VerifyReturnedOrderDto,
} from 'src/dto/oms/oms-fulfillment.dto';
import {
  BatchPrintThermalLabelsDto,
  CreateHandoverManifestDto,
  GenerateWavePicklistDto,
  ScanOrderIntoHandoverDto,
  ScheduleOrderCallLaterDto,
  SealHandoverManifestDto,
  SettlePartialDeliveryDto,
  UpdateOrderTagsAndSubStatusDto,
} from 'src/dto/oms/pos-fulfillment-ops.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import {
  RequireShopPermissions,
  ShopPermissionGuard,
} from 'src/modules/iam/guards/shop-permission.guard';
import { EffectiveMemberContext } from 'src/modules/iam/iam.service';
import { FieldLevelSecurityInterceptor } from 'src/modules/iam/interceptors/field-level-security.interceptor';

import { BarcodePackingAndPrintService } from './services/barcode-packing-and-print.service';
import { CarrierRescueAndWatchdogService } from './services/carrier-rescue-and-watchdog.service';
import { CodReconciliationService } from './services/cod-reconciliation.service';
import { OmsStateMachineService } from './services/oms-state-machine.service';
import { PosFulfillmentOpsService } from './services/pos-fulfillment-ops.service';
import { ReturnAndRmaExchangeService } from './services/return-and-rma-exchange.service';

type AuthedReq = Request & {
  user?: { id: string; name?: string; fullName?: string; email?: string };
  shopMemberContext?: EffectiveMemberContext;
};

@ApiTags(
  'Sprint 5 — OMS 14-Step State Machine, Barcode Packing (T09), Failed Delivery Rescue, Return Verification, 2-Way RMA & COD Reconciliation (T10)',
)
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ShopPermissionGuard)
@UseInterceptors(FieldLevelSecurityInterceptor)
@Controller('oms')
export class OmsFulfillmentController {
  constructor(
    private readonly stateMachineService: OmsStateMachineService,
    private readonly packingService: BarcodePackingAndPrintService,
    private readonly rescueService: CarrierRescueAndWatchdogService,
    private readonly rmaService: ReturnAndRmaExchangeService,
    private readonly reconciliationService: CodReconciliationService,
    private readonly posOpsService: PosFulfillmentOpsService,
  ) {}

  @Get(':shopId/orders')
  @RequireShopPermissions(PermissionCodeEnum.OMS_ORDER_LIST_VIEW)
  @ApiOperation({ summary: 'F07.1: Danh sách đơn hàng OMS kèm bộ đếm 14 trạng thái realtime' })
  async listOrders(
    @Param('shopId') shopId: string,
    @Query() query: OmsOrderListQueryDto,
  ): Promise<DBaseRes> {
    const data = await this.stateMachineService.listOmsOrders(shopId, query);
    return { status: HttpStatus.OK, code: HttpStatus.OK, message: 'OK', data };
  }

  @Get(':shopId/orders/:orderId')
  @RequireShopPermissions(PermissionCodeEnum.OMS_ORDER_LIST_VIEW)
  @ApiOperation({
    summary: 'F07.1 & F07.2: Chi tiết đơn hàng, lịch sử Before <-> After và hành trình 3PL',
  })
  async getOrderDetail(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
  ): Promise<DBaseRes> {
    const data = await this.stateMachineService.getOmsOrderDetail(shopId, orderId);
    return { status: HttpStatus.OK, code: HttpStatus.OK, message: 'OK', data };
  }

  @Patch(':shopId/orders/:orderId/status')
  @RequireShopPermissions(PermissionCodeEnum.OMS_ORDER_LIST_VIEW)
  @ApiOperation({ summary: 'F07.1: Chuyển trạng thái đơn hàng theo máy trạng thái OMS 14 bước' })
  async transitionStatus(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Body() dto: TransitionOrderStatusDto,
    @Req() req: AuthedReq,
  ): Promise<DBaseRes> {
    const data = await this.stateMachineService.transitionOrderStatus({
      shopId,
      orderId,
      actorUserId: req.user?.id || 'SYSTEM',
      actorName: req.user?.name || req.user?.fullName || req.user?.email || 'Nhân viên',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Cập nhật trạng thái thành công',
      data,
    };
  }

  @Patch(':shopId/orders/:orderId/modify')
  @RequireShopPermissions(PermissionCodeEnum.OMS_CONFIRMED_ORDER_MODIFY)
  @ApiOperation({
    summary: 'F07.2: Sửa đơn hàng đã chốt/đã in kèm lưu Before <-> After Diff & HMAC Audit',
  })
  async modifyConfirmedOrder(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Body() dto: ModifyConfirmedOrderDto,
    @Req() req: AuthedReq,
  ): Promise<DBaseRes> {
    const data = await this.stateMachineService.modifyConfirmedOrder({
      shopId,
      orderId,
      actorUserId: req.user?.id || 'SYSTEM',
      actorName: req.user?.name || req.user?.fullName || req.user?.email || 'Quản lý',
      memberContext: req.shopMemberContext,
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Đã lưu chỉnh sửa và lịch sử đối chiếu',
      data,
    };
  }

  @Post(':shopId/orders/dispatch-carrier-batch')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.OMS_CARRIER_DISPATCH_PUSH)
  @ApiOperation({ summary: 'Đẩy hàng loạt đơn đã chốt sang hãng vận chuyển 3PL' })
  async dispatchCarrierBatch(
    @Param('shopId') shopId: string,
    @Body() dto: DispatchCarrierBatchDto,
    @Req() req: AuthedReq,
  ): Promise<DBaseRes> {
    const data = await this.stateMachineService.dispatchOrdersToCarrierBatch({
      shopId,
      actorUserId: req.user?.id || 'SYSTEM',
      actorName: req.user?.name || req.user?.fullName || req.user?.email || 'Nhân viên',
      dto,
    });
    return { status: HttpStatus.OK, code: HttpStatus.OK, message: 'Đã đẩy vận đơn sang 3PL', data };
  }

  @Get(':shopId/packing-station/lookup')
  @RequireShopPermissions(PermissionCodeEnum.OMS_BARCODE_PACK_VERIFY)
  @ApiOperation({ summary: 'F07.3: Quét mã đơn hoặc mã vận đơn nạp lên Bàn đóng gói Barcode' })
  async lookupPackingOrder(
    @Param('shopId') shopId: string,
    @Query('code') code: string,
  ): Promise<DBaseRes> {
    const data = await this.packingService.lookupOrderForPacking(shopId, code);
    return { status: HttpStatus.OK, code: HttpStatus.OK, message: 'OK', data };
  }

  @Post(':shopId/packing-station/:orderId/scan')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.OMS_BARCODE_PACK_VERIFY)
  @ApiOperation({ summary: 'F07.3: Quét Barcode kiểm đếm từng sản phẩm & gắn Serial/IMEI' })
  async scanPackingItem(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Body() dto: ScanPackingBarcodeDto,
    @Req() req: AuthedReq,
  ): Promise<DBaseRes> {
    const data = await this.packingService.scanItemBarcode({
      shopId,
      orderId,
      actorUserId: req.user?.id || 'SYSTEM',
      dto,
    });
    return { status: HttpStatus.OK, code: HttpStatus.OK, message: data.message, data };
  }

  @Post(':shopId/packing-station/:orderId/complete-and-print')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(
    PermissionCodeEnum.OMS_BARCODE_PACK_VERIFY,
    PermissionCodeEnum.OMS_SHIPPING_LABEL_PRINT,
  )
  @ApiOperation({
    summary: 'F07.3: Chốt cân nặng thực tế, gắn video Cam Check & nhả lệnh in nhiệt A6/K80',
  })
  async completePackingAndPrint(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Body() dto: CompletePackingAndPrintDto,
    @Req() req: AuthedReq,
  ): Promise<DBaseRes> {
    const data = await this.packingService.completePackingAndGenerateLabel({
      shopId,
      orderId,
      actorUserId: req.user?.id || 'SYSTEM',
      actorName: req.user?.name || req.user?.fullName || req.user?.email || 'Nhân viên kho',
      memberContext: req.shopMemberContext,
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Đóng gói & sinh phiếu in thành công',
      data,
    };
  }

  @Post(':shopId/packing-station/:orderId/reprint')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.OMS_SHIPPING_LABEL_REPRINT)
  @ApiOperation({ summary: 'F07.3: In lại phiếu vận đơn kèm dấu chìm BẢN IN LẠI LẦN N' })
  async reprintShippingLabel(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Body() dto: ReprintShippingLabelDto,
    @Req() req: AuthedReq,
  ): Promise<DBaseRes> {
    const data = await this.packingService.reprintShippingLabel({
      shopId,
      orderId,
      actorUserId: req.user?.id || 'SYSTEM',
      actorName: req.user?.name || req.user?.fullName || req.user?.email || 'Quản lý kho',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Đã tạo bản in lại phiếu vận đơn',
      data,
    };
  }

  @Get(':shopId/failed-rescue')
  @RequireShopPermissions(PermissionCodeEnum.OMS_FAILED_DELIVERY_RESCUE)
  @ApiOperation({
    summary: 'F07.4 & F07.8: Danh sách đơn giao thất bại cần cứu gấp & đơn vi phạm SLA',
  })
  async listFailedRescueAndSla(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.rescueService.listFailedRescueAndSlaOrders(shopId);
    return { status: HttpStatus.OK, code: HttpStatus.OK, message: 'OK', data };
  }

  @Post(':shopId/orders/:orderId/carrier-rescue-action')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.OMS_FAILED_DELIVERY_RESCUE)
  @ApiOperation({ summary: 'F07.4: Thực thi lệnh cứu đơn trực tiếp sang 3PL' })
  async executeRescueAction(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Body() dto: CarrierRescueActionDto,
    @Req() req: AuthedReq,
  ): Promise<DBaseRes> {
    const data = await this.rescueService.executeCarrierRescueAction({
      shopId,
      orderId,
      actorUserId: req.user?.id || 'SYSTEM',
      actorName: req.user?.name || req.user?.fullName || req.user?.email || 'Nhân viên CSKH',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Đã gửi lệnh cứu đơn tới hãng vận chuyển',
      data,
    };
  }

  @Post(':shopId/sla-watchdog/scan')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.OMS_CARRIER_TICKET_ESCALATE)
  @ApiOperation({
    summary: 'F07.8: Quét thủ công đơn quá hạn lấy hàng (>24h) & ngâm trung chuyển (>36h)',
  })
  async triggerSlaWatchdogScan(): Promise<DBaseRes> {
    const data = await this.rescueService.scanCarrierSlaBreaches();
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Đã hoàn tất quét SLA vận chuyển',
      data,
    };
  }

  @Get(':shopId/returns/lookup')
  @RequireShopPermissions(PermissionCodeEnum.OMS_RETURN_BARCODE_RESTOCK)
  @ApiOperation({ summary: 'F07.5: Quét mã vận đơn hoàn để mở phiên đồng kiểm nhận hàng về kho' })
  async lookupReturningOrder(
    @Param('shopId') shopId: string,
    @Query('code') code: string,
  ): Promise<DBaseRes> {
    const data = await this.rmaService.lookupReturningOrderByBarcode(shopId, code);
    return { status: HttpStatus.OK, code: HttpStatus.OK, message: 'OK', data };
  }

  @Post(':shopId/returns/:orderId/verify-restock')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.OMS_RETURN_BARCODE_RESTOCK)
  @ApiOperation({ summary: 'F07.5: Xác nhận kết quả đồng kiểm hàng hoàn' })
  async verifyReturnedOrder(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Body() dto: VerifyReturnedOrderDto,
    @Req() req: AuthedReq,
  ): Promise<DBaseRes> {
    const data = await this.rmaService.verifyAndRestockReturnedOrder({
      shopId,
      orderId,
      actorUserId: req.user?.id || 'SYSTEM',
      actorName: req.user?.name || req.user?.fullName || req.user?.email || 'Nhân viên kho',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Đã hoàn tất đồng kiểm nhập hàng hoàn',
      data,
    };
  }

  @Get(':shopId/rma-exchanges')
  @RequireShopPermissions(PermissionCodeEnum.OMS_RMA_EXCHANGE_CREATE)
  @ApiOperation({ summary: 'F07.7: Danh sách phiếu Đổi hàng 2 chiều (RMA) & Trả hàng 1 phần' })
  async listRmaExchanges(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.rmaService.listRmaExchanges(shopId);
    return { status: HttpStatus.OK, code: HttpStatus.OK, message: 'OK', data };
  }

  @Post(':shopId/rma-exchanges')
  @HttpCode(HttpStatus.CREATED)
  @RequireShopPermissions(PermissionCodeEnum.OMS_RMA_EXCHANGE_CREATE)
  @ApiOperation({ summary: 'F07.7: Tạo đơn Đổi hàng 2 chiều (Giao mới - Thu cũ)' })
  async createRmaExchange(
    @Param('shopId') shopId: string,
    @Body() dto: CreateRmaExchangeDto,
    @Req() req: AuthedReq,
  ): Promise<DBaseRes> {
    const data = await this.rmaService.createTwoWayRmaExchange({
      shopId,
      actorUserId: req.user?.id || 'SYSTEM',
      actorName: req.user?.name || req.user?.fullName || req.user?.email || 'Nhân viên CSKH',
      dto,
    });
    return {
      status: HttpStatus.CREATED,
      code: HttpStatus.CREATED,
      message: 'Đã tạo đơn đổi hàng 2 chiều RMA',
      data,
    };
  }

  @Get(':shopId/reconciliation/batches')
  @RequireShopPermissions(PermissionCodeEnum.OMS_COD_RECONCILIATION_EXECUTE)
  @ApiOperation({ summary: 'F07.6: Danh sách các phiên đối soát COD' })
  async listCodBatches(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.reconciliationService.listBatches(shopId);
    return { status: HttpStatus.OK, code: HttpStatus.OK, message: 'OK', data };
  }

  @Post(':shopId/reconciliation/batches')
  @HttpCode(HttpStatus.CREATED)
  @RequireShopPermissions(PermissionCodeEnum.OMS_COD_RECONCILIATION_EXECUTE)
  @ApiOperation({
    summary:
      'F07.6 + T10: Nạp dữ liệu đối soát COD & tự động phát hiện lệch COD / đội cước cân nặng',
  })
  async createCodBatch(
    @Param('shopId') shopId: string,
    @Body() dto: CreateCodReconciliationBatchDto,
    @Req() req: AuthedReq,
  ): Promise<DBaseRes> {
    const data = await this.reconciliationService.createAndAnalyzeReconciliationBatch({
      shopId,
      actorUserId: req.user?.id || 'SYSTEM',
      dto,
    });
    return {
      status: HttpStatus.CREATED,
      code: HttpStatus.CREATED,
      message: 'Đã phân tích phiên đối soát COD',
      data,
    };
  }

  @Get(':shopId/reconciliation/batches/:batchId')
  @RequireShopPermissions(PermissionCodeEnum.OMS_COD_RECONCILIATION_EXECUTE)
  @ApiOperation({ summary: 'F07.6: Chi tiết từng dòng vận đơn trong phiên đối soát COD' })
  async getCodBatchDetail(
    @Param('shopId') shopId: string,
    @Param('batchId') batchId: string,
    @Query() query: ListCodReconciliationItemsQueryDto,
  ): Promise<DBaseRes> {
    const data = await this.reconciliationService.getBatchDetail(shopId, batchId, query);
    return { status: HttpStatus.OK, code: HttpStatus.OK, message: 'OK', data };
  }

  @Post(':shopId/reconciliation/batches/:batchId/confirm-matched')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.OMS_COD_RECONCILIATION_EXECUTE)
  @ApiOperation({ summary: 'F07.6: Xác nhận tất toán các đơn khớp -> DELIVERED_RECONCILED' })
  async confirmMatchedCodBatch(
    @Param('shopId') shopId: string,
    @Param('batchId') batchId: string,
    @Body() dto: ConfirmCodReconciliationBatchDto,
    @Req() req: AuthedReq,
  ): Promise<DBaseRes> {
    const data = await this.reconciliationService.confirmMatchedReconciliationItems({
      shopId,
      batchId,
      actorUserId: req.user?.id || 'SYSTEM',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Đã hoàn tất đối soát COD các đơn khớp',
      data,
    };
  }

  @Get(':shopId/reconciliation/batches/:batchId/export-disputes')
  @RequireShopPermissions(PermissionCodeEnum.OMS_COD_RECONCILIATION_EXECUTE)
  @ApiOperation({
    summary: 'F07.6: Xuất biên bản CSV khiếu nại các đơn lệch COD / đội cước cân nặng',
  })
  async exportCodDisputes(
    @Param('shopId') shopId: string,
    @Param('batchId') batchId: string,
  ): Promise<DBaseRes> {
    const data = await this.reconciliationService.exportDisputeCsv(shopId, batchId);
    return { status: HttpStatus.OK, code: HttpStatus.OK, message: 'OK', data };
  }

  @Post(':shopId/packing-station/batch-print')
  @RequireShopPermissions(PermissionCodeEnum.OMS_SHIPPING_LABEL_PRINT)
  @ApiOperation({
    summary: 'T09: In vận đơn nhiệt hàng loạt đa khổ giấy (A7/A6/K80/K58/A5/A4)',
  })
  async batchPrintShippingLabels(
    @Param('shopId') shopId: string,
    @Body() dto: BatchPrintThermalLabelsDto,
    @Req() req: any,
  ) {
    const data = await this.packingService.batchGenerateShippingLabels({
      shopId,
      orderIds: dto.orderIds,
      labelFormat: dto.labelFormat || ThermalLabelFormatEnum.A6_100X150,
      templateOptions: {
        hideProductNames: dto.hideProductNames,
        hideItemPrices: dto.hideItemPrices,
        showCodAmount: dto.showCodAmount,
        showOrderNote: dto.showOrderNote,
      },
      actorUserId: req.user?.userId || req.user?.id,
      actorName: req.user?.fullName || req.user?.name || 'Kho',
    });
    return { success: true, data };
  }

  @Post(':shopId/wave-picklist')
  @RequireShopPermissions(PermissionCodeEnum.OMS_BARCODE_PACK_VERIFY)
  @ApiOperation({
    summary: 'F07.9A: Xuất Phiếu Nhặt Hàng Tổng Hợp theo lô & vị trí kệ kho',
  })
  async generateWavePicklist(
    @Param('shopId') shopId: string,
    @Body() dto: GenerateWavePicklistDto,
  ) {
    const data = await this.posOpsService.generateConsolidatedWavePicklist({
      shopId,
      dto,
    });
    return { success: true, data };
  }

  @Get(':shopId/handover-manifests')
  @RequireShopPermissions(PermissionCodeEnum.OMS_CARRIER_DISPATCH_PUSH)
  @ApiOperation({
    summary: 'F07.9B: Danh sách biên bản bàn giao vận chuyển',
  })
  async listHandoverManifests(@Param('shopId') shopId: string) {
    const data = await this.posOpsService.listHandoverManifests(shopId);
    return { success: true, data };
  }

  @Post(':shopId/handover-manifests')
  @RequireShopPermissions(PermissionCodeEnum.OMS_CARRIER_DISPATCH_PUSH)
  @ApiOperation({
    summary: 'F07.9B: Tạo biên bản bàn giao vận chuyển mới',
  })
  async createHandoverManifest(
    @Param('shopId') shopId: string,
    @Body() dto: CreateHandoverManifestDto,
    @Req() req: any,
  ) {
    const data = await this.posOpsService.createHandoverManifest({
      shopId,
      actorUserId: req.user?.userId || req.user?.id,
      dto,
    });
    return { success: true, data };
  }

  @Get(':shopId/handover-manifests/:manifestId')
  @RequireShopPermissions(PermissionCodeEnum.OMS_CARRIER_DISPATCH_PUSH)
  @ApiOperation({
    summary: 'F07.9B: Chi tiết biên bản bàn giao vận chuyển & mẫu in 2 liên',
  })
  async getHandoverManifestDetail(
    @Param('shopId') shopId: string,
    @Param('manifestId') manifestId: string,
  ) {
    const data = await this.posOpsService.getHandoverManifestDetail(shopId, manifestId);
    return { success: true, data };
  }

  @Post(':shopId/handover-manifests/:manifestId/scan')
  @RequireShopPermissions(PermissionCodeEnum.OMS_CARRIER_DISPATCH_PUSH)
  @ApiOperation({
    summary: 'F07.9B: Quét Barcode kiện hàng đưa vào biên bản bàn giao',
  })
  async scanOrderIntoHandoverManifest(
    @Param('shopId') shopId: string,
    @Param('manifestId') manifestId: string,
    @Body() dto: ScanOrderIntoHandoverDto,
    @Req() req: any,
  ) {
    const data = await this.posOpsService.scanOrderIntoHandoverManifest({
      shopId,
      manifestId,
      actorUserId: req.user?.userId || req.user?.id,
      dto,
    });
    return { success: true, data };
  }

  @Post(':shopId/handover-manifests/:manifestId/seal')
  @RequireShopPermissions(PermissionCodeEnum.OMS_CARRIER_DISPATCH_PUSH)
  @ApiOperation({
    summary: 'F07.9B: Chốt biên bản bàn giao, chuyển hàng loạt sang HANDED_TO_CARRIER',
  })
  async sealHandoverManifest(
    @Param('shopId') shopId: string,
    @Param('manifestId') manifestId: string,
    @Body() dto: SealHandoverManifestDto,
    @Req() req: any,
  ) {
    const data = await this.posOpsService.sealAndCompleteHandoverManifest({
      shopId,
      manifestId,
      actorUserId: req.user?.userId || req.user?.id,
      actorName: req.user?.fullName || req.user?.name || 'Kho',
      dto,
    });
    return { success: true, data };
  }

  @Get(':shopId/call-later-queue')
  @RequireShopPermissions(PermissionCodeEnum.OMS_ORDER_LIST_VIEW)
  @ApiOperation({
    summary: 'F07.10: Hàng đợi Hẹn gọi lại xác nhận đơn chuẩn Pancake POS',
  })
  async listCallLaterQueue(@Param('shopId') shopId: string) {
    const data = await this.posOpsService.listConfirmationCallLaterQueue(shopId);
    return { success: true, data };
  }

  @Post(':shopId/orders/:orderId/call-later')
  @RequireShopPermissions(PermissionCodeEnum.OMS_ORDER_LIST_VIEW)
  @ApiOperation({
    summary: 'F07.10: Đặt lịch hẹn gọi lại xác nhận đơn & gắn thẻ đơn hàng',
  })
  async scheduleCallLater(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Body() dto: ScheduleOrderCallLaterDto,
    @Req() req: any,
  ) {
    const data = await this.posOpsService.scheduleOrderCallLater({
      shopId,
      orderId,
      actorUserId: req.user?.userId || req.user?.id,
      actorName: req.user?.fullName || req.user?.name || 'Sale',
      dto,
    });
    return { success: true, data };
  }

  @Patch(':shopId/orders/:orderId/order-tags')
  @RequireShopPermissions(PermissionCodeEnum.OMS_ORDER_LIST_VIEW)
  @ApiOperation({
    summary: 'F07.10: Cập nhật thẻ đơn hàng (Order Tags) & trạng thái phụ',
  })
  async updateOrderTagsAndSubStatus(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Body() dto: UpdateOrderTagsAndSubStatusDto,
    @Req() req: any,
  ) {
    const data = await this.posOpsService.updateOrderTagsAndSubStatus({
      shopId,
      orderId,
      actorUserId: req.user?.userId || req.user?.id,
      actorName: req.user?.fullName || req.user?.name || 'Sale',
      dto,
    });
    return { success: true, data };
  }

  @Post(':shopId/orders/:orderId/partial-delivery-settle')
  @RequireShopPermissions(PermissionCodeEnum.OMS_CONFIRMED_ORDER_MODIFY)
  @ApiOperation({
    summary: 'F07.11: Quyết toán giao hàng một phần & cập nhật COD/Tồn kho',
  })
  async settlePartialDelivery(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Body() dto: SettlePartialDeliveryDto,
    @Req() req: any,
  ) {
    const data = await this.posOpsService.settlePartialDelivery({
      shopId,
      orderId,
      actorUserId: req.user?.userId || req.user?.id,
      actorName: req.user?.fullName || req.user?.name || 'Vận hành',
      dto,
    });
    return { success: true, data };
  }
}

@ApiTags('Public 3PL Carrier Webhooks (GHN / GHTK / VTP / J&T)')
@Controller('webhooks/carriers')
export class CarrierPublicWebhookController {
  constructor(private readonly rescueService: CarrierRescueAndWatchdogService) {}

  @Post(':carrierCode')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Nhận Webhook trạng thái vận đơn 3PL (Idempotent qua Redis SETNX)' })
  async receiveCarrierWebhook(
    @Param('carrierCode') carrierCode: string,
    @Body() dto: CarrierWebhookPayloadDto,
  ): Promise<DBaseRes> {
    const data = await this.rescueService.processCarrierWebhook(carrierCode, dto);
    return { status: HttpStatus.OK, code: HttpStatus.OK, message: 'Webhook acknowledged', data };
  }
}
