import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WebSocketModule } from 'src/common/websocket/socket-state.module';
import { AdsConversionEventLogEntity } from 'src/entity/ads-conversion-event-log.entity';
import { ChannelIntegrationEntity } from 'src/entity/channel-integration.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { CustomerWalletLedgerEntity } from 'src/entity/customer-wallet-ledger.entity';
import { MessageEntity } from 'src/entity/message.entity';
import { PhoneTrustAbuseReportEntity } from 'src/entity/phone-trust-abuse-report.entity';
import { PhoneTrustDeliveryEventEntity } from 'src/entity/phone-trust-delivery-event.entity';
import { PhoneTrustGlobalAggregateEntity } from 'src/entity/phone-trust-global-aggregate.entity';
import { SecurityAuditLogEntity } from 'src/entity/security-audit-log.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { UserEntity } from 'src/entity/user.entity';
import { WarehouseEntity } from 'src/entity/warehouse.entity';

import { ChatModule } from '../chat/chat.module';
import { IamModule } from '../iam/iam.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CarrierTrustWebhookController } from './controllers/carrier-trust-webhook.controller.tscarrier-trust-webhook.controller';
import { CrmController } from './crm.controller';
import { AdsConversionSyncService } from './services/ads-conversion-sync.service';
import { Customer360Service } from './services/customer-360.service';
import { CustomerRfmAndLoyaltyService } from './services/customer-rfm-and-loyalty.service';
import { DeliveryTrustScoreService } from './services/delivery-trust-score.service';
import { PhoneTrustLedgerService } from './services/phone-trust-ledger.service';
import { PhoneTrustProviderAdaptersService } from './services/phone-trust-provider-adapters.service';
import { PiiVaultAndAuditService } from './services/pii-vault-and-audit.service';
import { VietnameseCommerceNerService } from './services/vietnamese-commerce-ner.service';
import { VnAdministrativeAddressCarrierService } from './services/vn-administrative-address-carrier.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CustomerProfileEntity,
      CustomerWalletLedgerEntity,
      AdsConversionEventLogEntity,
      SecurityAuditLogEntity,
      ConversationEntity,
      MessageEntity,
      ChannelIntegrationEntity,
      ShopWorkspaceEntity,
      ShopMemberEntity,
      UserEntity,
      WarehouseEntity,
      PhoneTrustDeliveryEventEntity,
      PhoneTrustAbuseReportEntity,
      PhoneTrustGlobalAggregateEntity,
    ]),
    WebSocketModule,
    IamModule,
    NotificationsModule,
    forwardRef(() => ChatModule),
  ],
  controllers: [CrmController, CarrierTrustWebhookController],
  providers: [
    VietnameseCommerceNerService,
    VnAdministrativeAddressCarrierService,
    PiiVaultAndAuditService,
    PhoneTrustProviderAdaptersService,
    PhoneTrustLedgerService,
    DeliveryTrustScoreService,
    AdsConversionSyncService,
    CustomerRfmAndLoyaltyService,
    Customer360Service,
  ],
  exports: [
    VietnameseCommerceNerService,
    VnAdministrativeAddressCarrierService,
    PiiVaultAndAuditService,
    PhoneTrustProviderAdaptersService,
    PhoneTrustLedgerService,
    DeliveryTrustScoreService,
    AdsConversionSyncService,
    CustomerRfmAndLoyaltyService,
    Customer360Service,
  ],
})
export class CrmModule {}
