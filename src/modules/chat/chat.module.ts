import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WebSocketModule } from 'src/common/websocket/socket-state.module';
import { CallParticipantEntity } from 'src/entity/call-participant.entity';
import { CallSessionEntity } from 'src/entity/call-session.entity';
import { ChannelIntegrationEntity } from 'src/entity/channel-integration.entity';
import { ContactEntity } from 'src/entity/contact.entity';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { FileEntity } from 'src/entity/file.entity';
import { MessageEntity } from 'src/entity/message.entity';
import { QuickReplyTemplateEntity } from 'src/entity/quick-reply-template.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { UserEntity } from 'src/entity/user.entity';

import { CrmModule } from '../crm/crm.module';
import { IamModule } from '../iam/iam.module';
import { MediaModule } from '../media/media.module';
import { UserModule } from '../user/user.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { AccountabilityTimelineService } from './services/accountability-timeline.service';
import { AgentCollisionLockService } from './services/agent-collision-lock.service';
import { CallSignalingService } from './services/call-signaling.service';
import { ConversationSnoozeService } from './services/conversation-snooze.service';
import { GhostedConversationWatchdogService } from './services/ghosted-conversation-watchdog.service';
import { LinkPreviewService } from './services/link-preview.service';
import { MaskedVoipCallService } from './services/masked-voip-call.service';
import { MessageCryptoService } from './services/message-crypto.service';
import { OmnichannelInboxQueryService } from './services/omnichannel-inbox-query.service';
import { QuickReplyService } from './services/quick-reply.service';
import { RealtimeChatTranslationService } from './services/realtime-chat-translation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ConversationParticipantEntity,
      ConversationEntity,
      CustomerProfileEntity,
      MessageEntity,
      FileEntity,
      CallSessionEntity,
      CallParticipantEntity,
      ContactEntity,
      ShopMemberEntity,
      ShopWorkspaceEntity,
      ChannelIntegrationEntity,
      QuickReplyTemplateEntity,
      UserEntity,
    ]),
    UserModule,
    MediaModule,
    WebSocketModule,
    IamModule,
    forwardRef(() => CrmModule),
  ],
  controllers: [ChatController],
  providers: [
    ChatService,
    ChatGateway,
    MessageCryptoService,
    CallSignalingService,
    LinkPreviewService,
    OmnichannelInboxQueryService,
    AgentCollisionLockService,
    GhostedConversationWatchdogService,
    ConversationSnoozeService,
    QuickReplyService,
    AccountabilityTimelineService,
    MaskedVoipCallService,
    RealtimeChatTranslationService,
  ],
  exports: [
    ChatService,
    MessageCryptoService,
    CallSignalingService,
    LinkPreviewService,
    OmnichannelInboxQueryService,
    AgentCollisionLockService,
    GhostedConversationWatchdogService,
    ConversationSnoozeService,
    QuickReplyService,
    AccountabilityTimelineService,
    MaskedVoipCallService,
    RealtimeChatTranslationService,
  ],
})
export class ChatModule {}
