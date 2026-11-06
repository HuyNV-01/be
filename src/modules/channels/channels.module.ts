import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WebSocketModule } from 'src/common/websocket/socket-state.module';
import { ChannelIntegrationEntity } from 'src/entity/channel-integration.entity';
import { ChannelWebhookLogEntity } from 'src/entity/channel-webhook-log.entity';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { MessageEntity } from 'src/entity/message.entity';
import { NotificationEntity } from 'src/entity/notification.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { UserEntity } from 'src/entity/user.entity';
import { ChatModule } from 'src/modules/chat/chat.module';
import { IamModule } from 'src/modules/iam/iam.module';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';

import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { ConversationSlaProcessor } from './queues/conversation-sla.processor';
import { ConversationRoutingEngine } from './routing/conversation-routing.engine';
import { ChannelTokenDoctorService } from './services/channel-token-doctor.service';
import { MarketplaceBridgeService } from './services/marketplace-bridge.service';
import { OmnibusWebhookController } from './webhooks/omnibus-webhook.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ChannelIntegrationEntity,
      ChannelWebhookLogEntity,
      ConversationEntity,
      ConversationParticipantEntity,
      MessageEntity,
      ShopMemberEntity,
      ShopWorkspaceEntity,
      NotificationEntity,
      UserEntity,
    ]),
    BullModule.registerQueue({
      name: 'conversation_sla_queue',
    }),
    WebSocketModule,
    IamModule,
    ChatModule,
    NotificationsModule,
  ],
  controllers: [ChannelsController, OmnibusWebhookController],
  providers: [
    ChannelsService,
    ConversationRoutingEngine,
    ConversationSlaProcessor,
    ChannelTokenDoctorService,
    MarketplaceBridgeService,
  ],
  exports: [
    ChannelsService,
    ConversationRoutingEngine,
    ChannelTokenDoctorService,
    MarketplaceBridgeService,
  ],
})
export class ChannelsModule {}
