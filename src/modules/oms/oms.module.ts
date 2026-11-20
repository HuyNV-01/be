import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WebSocketModule } from 'src/common/websocket/socket-state.module';
import { CodReconciliationBatchEntity } from 'src/entity/cod-reconciliation-batch.entity';
import { CodReconciliationItemEntity } from 'src/entity/cod-reconciliation-item.entity';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { CustomerWalletLedgerEntity } from 'src/entity/customer-wallet-ledger.entity';
import { OrderCarrierEventEntity } from 'src/entity/order-carrier-event.entity';
import { OrderRevisionHistoryEntity } from 'src/entity/order-revision-history.entity';
import { OrderRmaExchangeEntity } from 'src/entity/order-rma-exchange.entity';
import { PosOrderEntity } from 'src/entity/pos-order.entity';
import { ProductSerialItemEntity } from 'src/entity/product-serial-item.entity';
import { ProductVariantEntity } from 'src/entity/product-variant.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { WarehouseStockItemEntity } from 'src/entity/warehouse-stock-item.entity';

import { CatalogPosModule } from '../catalog-pos/catalog-pos.module';
import { CrmModule } from '../crm/crm.module';
import { IamModule } from '../iam/iam.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CarrierPublicWebhookController, OmsFulfillmentController } from './oms.controller';
import { BarcodePackingAndPrintService } from './services/barcode-packing-and-print.service';
import { CarrierRescueAndWatchdogService } from './services/carrier-rescue-and-watchdog.service';
import { CodReconciliationService } from './services/cod-reconciliation.service';
import { OmsStateMachineService } from './services/oms-state-machine.service';
import { ReturnAndRmaExchangeService } from './services/return-and-rma-exchange.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PosOrderEntity,
      OrderRevisionHistoryEntity,
      OrderCarrierEventEntity,
      OrderRmaExchangeEntity,
      CodReconciliationBatchEntity,
      CodReconciliationItemEntity,
      ShopWorkspaceEntity,
      ProductVariantEntity,
      WarehouseStockItemEntity,
      ProductSerialItemEntity,
      CustomerProfileEntity,
      CustomerWalletLedgerEntity,
    ]),
    WebSocketModule,
    IamModule,
    CrmModule,
    CatalogPosModule,
    NotificationsModule,
  ],
  controllers: [OmsFulfillmentController, CarrierPublicWebhookController],
  providers: [
    OmsStateMachineService,
    BarcodePackingAndPrintService,
    CarrierRescueAndWatchdogService,
    ReturnAndRmaExchangeService,
    CodReconciliationService,
  ],
  exports: [
    OmsStateMachineService,
    BarcodePackingAndPrintService,
    CarrierRescueAndWatchdogService,
    ReturnAndRmaExchangeService,
    CodReconciliationService,
  ],
})
export class OmsModule {}
