import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WebSocketModule } from 'src/common/websocket/socket-state.module';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { InventoryMovementLedgerEntity } from 'src/entity/inventory-movement-ledger.entity';
import { PosOrderEntity } from 'src/entity/pos-order.entity';
import { ProductSerialItemEntity } from 'src/entity/product-serial-item.entity';
import { ProductVariantEntity } from 'src/entity/product-variant.entity';
import { ProductEntity } from 'src/entity/product.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { WarehouseStockItemEntity } from 'src/entity/warehouse-stock-item.entity';
import { WarehouseTransferOrderEntity } from 'src/entity/warehouse-transfer-order.entity';
import { WarehouseEntity } from 'src/entity/warehouse.entity';

import { CrmModule } from '../crm/crm.module';
import { IamModule } from '../iam/iam.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CatalogPosController, VietQrPublicWebhookController } from './catalog-pos.controller';
import { AtomicInventoryAndTransferService } from './services/atomic-inventory-and-transfer.service';
import { CatalogAndBomService } from './services/catalog-and-bom.service';
import { InChatPosAndOrderRouterService } from './services/in-chat-pos-and-order-router.service';
import { VietQrEmvcoAndCounterPosService } from './services/vietqr-emvco-and-counter-pos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WarehouseEntity,
      ProductEntity,
      ProductVariantEntity,
      WarehouseStockItemEntity,
      InventoryMovementLedgerEntity,
      WarehouseTransferOrderEntity,
      ProductSerialItemEntity,
      PosOrderEntity,
      CustomerProfileEntity,
      ShopMemberEntity,
      ShopWorkspaceEntity,
    ]),
    WebSocketModule,
    IamModule,
    CrmModule,
    NotificationsModule,
  ],
  controllers: [CatalogPosController, VietQrPublicWebhookController],
  providers: [
    AtomicInventoryAndTransferService,
    CatalogAndBomService,
    VietQrEmvcoAndCounterPosService,
    InChatPosAndOrderRouterService,
  ],
  exports: [
    AtomicInventoryAndTransferService,
    CatalogAndBomService,
    VietQrEmvcoAndCounterPosService,
    InChatPosAndOrderRouterService,
  ],
})
export class CatalogPosModule {}
