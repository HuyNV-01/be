import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Request } from 'express';
import { ProductIndustryTypeEnum } from 'src/common/enum';
import { PermissionCodeEnum } from 'src/common/enum/permission.enum';
import { DBaseRes } from 'src/dto/base-res.dto';
import {
  AdjustWarehouseStocktakeDto,
  CreateBundleBomVariantDto,
  CreateInChatPosOrderDto,
  CreateProductWithMatrixDto,
  CreateWarehouseTransferDto,
  GenerateOrderVietQrDto,
  MergeDuplicatePosOrdersDto,
  PosOrderListQueryDto,
  ReceiveWarehouseTransferDto,
  RecommendSizeAdvisorDto,
  RegisterProductSerialItemsDto,
  ReleaseStockAtomicDto,
  ReserveStockAtomicDto,
  ResolveDiscountApprovalDto,
  ScanBindSerialToOrderDto,
  SerialLookupQueryDto,
  UpsertWarehouseDto,
  VietQrPaymentWebhookDto,
} from 'src/dto/catalog-pos/catalog-pos.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import {
  RequireShopPermissions,
  ShopPermissionGuard,
} from 'src/modules/iam/guards/shop-permission.guard';
import { FieldLevelSecurityInterceptor } from 'src/modules/iam/interceptors/field-level-security.interceptor';

import { AtomicInventoryAndTransferService } from './services/atomic-inventory-and-transfer.service';
import { CatalogAndBomService } from './services/catalog-and-bom.service';
import { InChatPosAndOrderRouterService } from './services/in-chat-pos-and-order-router.service';
import { VietQrEmvcoAndCounterPosService } from './services/vietqr-emvco-and-counter-pos.service';

@ApiTags(
  'Sprint 4 — Multi-Industry Catalog, Multi-Warehouse, Redis Lua Atomic Stock (T07), Bundle BOM, Serial/IMEI, In-Chat POS & Dynamic VietQR EMVCo (T08)',
)
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ShopPermissionGuard)
@UseInterceptors(FieldLevelSecurityInterceptor)
@Controller('catalog-pos')
export class CatalogPosController {
  constructor(
    private readonly catalogService: CatalogAndBomService,
    private readonly inventoryService: AtomicInventoryAndTransferService,
    private readonly posOrderService: InChatPosAndOrderRouterService,
    private readonly vietQrService: VietQrEmvcoAndCounterPosService,
  ) {}

  @Get(':shopId/warehouses')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary: 'F05.6: Danh sách các Kho vật lý của Cửa hàng (Tự động khởi tạo Kho HN & Kho TP.HCM)',
  })
  async listWarehouses(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.inventoryService.ensureDefaultWarehousesForShop(shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched shop warehouses successfully',
      data,
    };
  }

  @Post(':shopId/warehouses')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.WAREHOUSE_MANAGE)
  @ApiOperation({
    summary: 'F05.6: Tạo mới hoặc cập nhật thông tin Kho hàng vật lý',
  })
  async upsertWarehouse(
    @Param('shopId') shopId: string,
    @Body() dto: UpsertWarehouseDto,
  ): Promise<DBaseRes> {
    const data = await this.inventoryService.upsertWarehouse(shopId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Upserted warehouse successfully',
      data,
    };
  }

  @Get(':shopId/variants')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F05.1, F05.2, F05.3 & F05.7: Danh sách Biến thể SKU Đa ngành hàng & Combo BOM kèm Tồn kho 4 trạng thái theo từng Kho (Giá vốn được bảo vệ bởi FLS)',
  })
  async listVariantsWithStock(
    @Param('shopId') shopId: string,
    @Query('search') search?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('bundleOnly') bundleOnly?: boolean,
    @Query('industryType') industryType?: ProductIndustryTypeEnum,
  ): Promise<DBaseRes> {
    const data = await this.catalogService.listCatalogVariantsWithMultiWarehouseStock({
      shopId,
      search,
      warehouseId,
      bundleOnly: String(bundleOnly) === 'true',
      industryType,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched catalog variants and multi-warehouse 4-state stock successfully',
      data,
    };
  }

  @Post(':shopId/products/matrix')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CATALOG_PRODUCT_CREATE_EDIT)
  @ApiOperation({
    summary:
      'F05.1 & F05.2: Tạo Sản phẩm Đa Ngành Hàng & Tự động sinh Ma trận Biến thể SKU (2 trục thuộc tính động) kèm mã vạch Barcode, Lô/Hạn sử dụng FEFO hoặc Serial/IMEI',
  })
  async createProductWithMatrix(
    @Param('shopId') shopId: string,
    @Body() dto: CreateProductWithMatrixDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.catalogService.createProductWithVariantMatrix({
      shopId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Created product and generated SKU variant matrix successfully',
      data,
    };
  }

  @Post(':shopId/bundles')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CATALOG_BUNDLE_BOM_MANAGE)
  @ApiOperation({
    summary:
      'F05.7: Tạo Sản phẩm Combo (Bundle BOM) tự động tính tồn khả dụng từ các SKU thành phần',
  })
  async createBundleBom(
    @Param('shopId') shopId: string,
    @Body() dto: CreateBundleBomVariantDto,
  ): Promise<DBaseRes> {
    const data = await this.catalogService.createBundleBomVariant(shopId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Created Bundle BOM variant successfully',
      data,
    };
  }

  @Post(':shopId/size-advisor')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F05.1: Tư vấn Size & Thông số Đa ngành hàng tự động (Thời trang: Cao/Nặng, Mẹ & Bé: Cân nặng/Tháng tuổi, Mỹ phẩm: Loại da, Điện tử/F&B: Nhu cầu)',
  })
  async recommendSize(
    @Param('shopId') shopId: string,
    @Body() dto: RecommendSizeAdvisorDto,
  ): Promise<DBaseRes> {
    const data = await this.catalogService.recommendApparelSize(shopId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Recommended product specification/size successfully',
      data,
    };
  }

  @Post(':shopId/inventory/reserve-atomic')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F05.4 & Công cụ T07: Giữ chỗ tồn kho nguyên tử bằng Redis Lua Script (< 1ms) chống bán âm kho khi Livestream',
  })
  async reserveStockAtomic(
    @Param('shopId') shopId: string,
    @Body() dto: ReserveStockAtomicDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.inventoryService.reserveStockAtomicWithRedisLua({
      shopId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Reserved stock atomically via Redis Lua script successfully',
      data,
    };
  }

  @Post(':shopId/inventory/release-atomic')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary: 'F05.4 & Công cụ T07: Giải phóng giữ chỗ tồn kho nguyên tử trên Redis & MySQL',
  })
  async releaseStockAtomic(
    @Param('shopId') shopId: string,
    @Body() dto: ReleaseStockAtomicDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.inventoryService.releaseStockReservationAtomic({
      shopId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Released stock reservation atomically successfully',
      data,
    };
  }

  @Post(':shopId/inventory/adjust')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.WAREHOUSE_STOCKTAKE_ADJUST)
  @ApiOperation({
    summary:
      'F05.3 & F05.5: Điều chỉnh kiểm kho / Nhập PO / Chuyển hàng lỗi kèm lưu Sổ cái Thẻ kho phân vùng & Kiểm toán bảo mật',
  })
  async adjustStocktake(
    @Param('shopId') shopId: string,
    @Body() dto: AdjustWarehouseStocktakeDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.inventoryService.adjustWarehouseStocktake({
      shopId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Adjusted warehouse stocktake and recorded ledger successfully',
      data,
    };
  }

  @Get(':shopId/inventory/ledgers')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F05.5: Truy vấn Sổ cái Thẻ kho Bất biến phân vùng theo tháng (inventory_movement_ledgers)',
  })
  async listInventoryLedgers(
    @Param('shopId') shopId: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('variantId') variantId?: string,
  ): Promise<DBaseRes> {
    const data = await this.inventoryService.listInventoryLedgers(shopId, warehouseId, variantId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched partitioned inventory movement ledgers successfully',
      data,
    };
  }

  @Get(':shopId/transfers')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary: 'F05.6: Danh sách Phiếu chuyển kho nội bộ 2 bước',
  })
  async listTransfers(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.inventoryService.listWarehouseTransfers(shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched warehouse transfer orders successfully',
      data,
    };
  }

  @Post(':shopId/transfers')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.WAREHOUSE_TRANSFER_CREATE)
  @ApiOperation({
    summary:
      'F05.6 (Bước 1 — TRANSFER_OUT): Tạo phiếu điều chuyển kho nội bộ, trừ onHandQty kho xuất và cộng inTransitQty kho nhận',
  })
  async createTransfer(
    @Param('shopId') shopId: string,
    @Body() dto: CreateWarehouseTransferDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.inventoryService.createTwoStepWarehouseTransfer({
      shopId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Created 2-step warehouse transfer order successfully',
      data,
    };
  }

  @Post(':shopId/transfers/:transferId/receive')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.WAREHOUSE_TRANSFER_RECEIVE)
  @ApiOperation({
    summary:
      'F05.6 (Bước 2 — TRANSFER_IN): Kho nhận xác nhận kiểm đếm hàng chuyển đến, trừ inTransitQty và cộng onHandQty',
  })
  async receiveTransfer(
    @Param('shopId') shopId: string,
    @Param('transferId') transferId: string,
    @Body() dto: ReceiveWarehouseTransferDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.inventoryService.receiveWarehouseTransferStepTwo({
      shopId,
      transferId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Received warehouse transfer order (Step 2) successfully',
      data,
    };
  }

  @Get(':shopId/serials')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary: 'F05.8: Tra cứu danh sách mã Serial / IMEI và hạn bảo hành điện tử',
  })
  async listSerials(
    @Param('shopId') shopId: string,
    @Query() query: SerialLookupQueryDto,
  ): Promise<DBaseRes> {
    const data = await this.inventoryService.listProductSerialItems(shopId, query);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched product serial/IMEI items successfully',
      data,
    };
  }

  @Post(':shopId/serials/register')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CATALOG_SERIAL_IMEI_SCAN)
  @ApiOperation({
    summary: 'F05.8: Nhập danh sách mã Serial / IMEI mới vào kho',
  })
  async registerSerials(
    @Param('shopId') shopId: string,
    @Body() dto: RegisterProductSerialItemsDto,
  ): Promise<DBaseRes> {
    const data = await this.inventoryService.registerProductSerialItems(shopId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Registered product serial/IMEI items successfully',
      data,
    };
  }

  @Post(':shopId/serials/scan-bind')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.CATALOG_SERIAL_IMEI_SCAN)
  @ApiOperation({
    summary: 'F05.8: Quét mã Serial / IMEI gắn vào đơn hàng và kích hoạt bảo hành điện tử',
  })
  async scanBindSerial(
    @Param('shopId') shopId: string,
    @Body() dto: ScanBindSerialToOrderDto,
  ): Promise<DBaseRes> {
    const data = await this.inventoryService.scanAndBindSerialToOrder(shopId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Bound serial/IMEI to order and activated warranty successfully',
      data,
    };
  }

  @Get(':shopId/pos/orders')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary: 'F06.1: Danh sách đơn hàng POS (In-Chat POS & Counter POS)',
  })
  async listPosOrders(
    @Param('shopId') shopId: string,
    @Query() query: PosOrderListQueryDto,
  ): Promise<DBaseRes> {
    const data = await this.posOrderService.listPosOrders(shopId, query);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched POS orders successfully',
      data,
    };
  }

  @Get(':shopId/pos/orders/duplicate-check')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F06.5: Kiểm tra khách hàng trong cuộc hội thoại có đơn hàng chưa xuất kho để gợi ý Gộp đơn 1 chạm',
  })
  async checkDuplicateOrders(
    @Param('shopId') shopId: string,
    @Query('customerId') customerId?: string,
    @Query('conversationId') conversationId?: string,
  ): Promise<DBaseRes> {
    const data = await this.posOrderService.detectMergeableDuplicateOrders({
      shopId,
      customerId,
      conversationId,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Checked mergeable duplicate orders successfully',
      data,
    };
  }

  @Post(':shopId/pos/orders/routing-preview')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F06.6 & Công cụ T07: Xem trước định tuyến kho thông minh & gợi ý tách đơn đa kho theo giỏ hàng hiện tại',
  })
  async previewOrderWarehouseRouting(
    @Param('shopId') shopId: string,
    @Body()
    body: {
      receiverProvinceCode?: string | null;
      preferredWarehouseId?: string | null;
      items: Array<{ variantId: string; quantity: number }>;
    },
  ): Promise<DBaseRes> {
    const data = await this.posOrderService.previewWarehouseAllocationAndSplit({
      shopId,
      receiverProvinceCode: body.receiverProvinceCode,
      preferredWarehouseId: body.preferredWarehouseId,
      items: body.items || [],
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Previewed multi-warehouse allocation and split routing successfully',
      data,
    };
  }

  @Post(':shopId/pos/orders')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F06.1 – F06.7: Tạo đơn hàng In-Chat POS / Counter POS kèm giữ chỗ nguyên tử, tự động tách đơn đa kho, kiểm soát trần giảm giá & sinh mã VietQR động EMVCo',
  })
  async createPosOrder(
    @Param('shopId') shopId: string,
    @Body() dto: CreateInChatPosOrderDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.posOrderService.createPosOrderWithSmartRouting({
      shopId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Created POS order with smart routing and dynamic VietQR successfully',
      data,
    };
  }

  @Post(':shopId/pos/orders/merge')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F06.5: Gộp 1 chạm giỏ hàng mới hoặc đơn trùng vào đơn hàng chưa xuất kho của cùng khách hàng',
  })
  async mergeDuplicateOrders(
    @Param('shopId') shopId: string,
    @Body() dto: MergeDuplicatePosOrdersDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.posOrderService.mergeDuplicateOrdersOneClick({
      shopId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Merged duplicate POS orders successfully',
      data,
    };
  }

  @Post(':shopId/pos/orders/:orderId/discount-approval')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.POS_DISCOUNT_APPROVE_OVERRIDE)
  @ApiOperation({
    summary:
      'F06.3: Quản lý phê duyệt hoặc từ chối 1 chạm đối với đơn hàng giảm giá vượt trần (PENDING_PRICE_APPROVAL)',
  })
  async resolveDiscountApproval(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Body() dto: ResolveDiscountApprovalDto,
    @Req() req: Request & { user?: { id: string } },
  ): Promise<DBaseRes> {
    const data = await this.posOrderService.resolveDiscountApprovalOneClick({
      shopId,
      orderId,
      actorUserId: req.user?.id || 'system',
      dto,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Resolved POS order discount approval successfully',
      data,
    };
  }

  @Post(':shopId/pos/orders/:orderId/vietqr')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F06.4 & Công cụ T08: Sinh lại mã VietQR Động chuẩn NAPAS EMVCo (CRC-16/CCITT-FALSE) khóa cứng số tiền & nội dung SEVQR',
  })
  async generateOrderVietQr(
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Body() dto: GenerateOrderVietQrDto,
  ): Promise<DBaseRes> {
    const data = await this.vietQrService.regenerateVietQrForOrder(shopId, orderId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Generated dynamic EMVCo VietQR payload successfully',
      data,
    };
  }

  @Post(':shopId/pos/webhooks/vietqr')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @ApiOperation({
    summary:
      'F06.4 & Công cụ T08: Webhook biến động số dư VietQR tự động gạch nợ đơn hàng, cộng tiền dư vào Ví khách & bắn Purchase Meta CAPI',
  })
  async handleVietQrWebhook(
    @Param('shopId') shopId: string,
    @Body() dto: VietQrPaymentWebhookDto,
  ): Promise<DBaseRes> {
    const data = await this.vietQrService.handleVietQrPaymentWebhook(shopId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Processed VietQR payment webhook and reconciled order successfully',
      data,
    };
  }
}

/**
 * Cổng Webhook công khai (`POST /webhooks/payment/vietqr`) nhận thông báo biến động số dư ngân hàng
 * từ Casso / SePay / NAPAS 247 theo đúng đặc tả Sprint 4 Mục 4 (`F06.4` & Công cụ `T08`).
 */
@ApiTags('Sprint 4 — Public Bank Transfer VietQR Webhook (Casso / SePay / NAPAS 247)')
@Controller('webhooks/payment')
export class VietQrPublicWebhookController {
  constructor(private readonly vietQrService: VietQrEmvcoAndCounterPosService) {}

  @Post('vietqr')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F06.4 & T08: Cổng Webhook công khai nhận biến động số dư ngân hàng (SEVQR ORD...) tự động gạch nợ đơn hàng POS',
  })
  async receivePublicVietQrWebhook(
    @Body() dto: VietQrPaymentWebhookDto,
    @Query('shopId') queryShopId?: string,
    @Headers('x-shop-id') headerShopId?: string,
  ): Promise<DBaseRes> {
    const resolvedShopId = dto.shopId || queryShopId || headerShopId || 'default_shop';
    const data = await this.vietQrService.handleVietQrPaymentWebhook(resolvedShopId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Reconciled public VietQR bank webhook successfully',
      data,
    };
  }
}
