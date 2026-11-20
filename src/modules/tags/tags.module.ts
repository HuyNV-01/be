import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WebSocketModule } from 'src/common/websocket/socket-state.module';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { CustomTagEntity } from 'src/entity/custom-tag.entity';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { CustomerWalletLedgerEntity } from 'src/entity/customer-wallet-ledger.entity';
import { MessageTagAssignmentEntity } from 'src/entity/message-tag-assignment.entity';
import { MessageEntity } from 'src/entity/message.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { TagEventDefinitionEntity } from 'src/entity/tag-event-definition.entity';
import { ChatModule } from 'src/modules/chat/chat.module';
import { IamModule } from 'src/modules/iam/iam.module';

import { AutoTagRuleEngine } from './services/auto-tag-rule.engine';
import { ConversationTaggingService } from './services/conversation-tagging.service';
import { CustomTagService } from './services/custom-tag.service';
import { MessageBookmarkTagService } from './services/message-bookmark-tag.service';
import { TagActionWorkflowExecutor } from './services/tag-action-workflow.executor';
import { TagEventOrchestratorService } from './services/tag-event-orchestrator.service';
import { TagsController } from './tags.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CustomTagEntity,
      MessageTagAssignmentEntity,
      ConversationEntity,
      MessageEntity,
      CustomerProfileEntity,
      CustomerWalletLedgerEntity,
      ShopMemberEntity,
      TagEventDefinitionEntity,
    ]),
    WebSocketModule,
    IamModule,
    ChatModule,
  ],
  controllers: [TagsController],
  providers: [
    CustomTagService,
    TagActionWorkflowExecutor,
    ConversationTaggingService,
    MessageBookmarkTagService,
    AutoTagRuleEngine,
    TagEventOrchestratorService,
  ],
  exports: [
    CustomTagService,
    TagActionWorkflowExecutor,
    ConversationTaggingService,
    MessageBookmarkTagService,
    AutoTagRuleEngine,
  ],
})
export class TagsModule {}
