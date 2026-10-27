// Sửa file: src/modules/chat/chat.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WebSocketModule } from 'src/common/websocket/socket-state.module';
import { CallSessionEntity } from 'src/entity/call-session.entity';
import { ContactEntity } from 'src/entity/contact.entity';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { FileEntity } from 'src/entity/file.entity';
import { MessageEntity } from 'src/entity/message.entity';

import { MediaModule } from '../media/media.module';
import { UserModule } from '../user/user.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { CallSignalingService } from './services/call-signaling.service';
import { MessageCryptoService } from './services/message-crypto.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ConversationParticipantEntity,
      ConversationEntity,
      MessageEntity,
      FileEntity,
      CallSessionEntity,
      ContactEntity,
    ]),
    UserModule,
    MediaModule,
    WebSocketModule,
  ],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, MessageCryptoService, CallSignalingService],
  exports: [ChatService, MessageCryptoService, CallSignalingService],
})
export class ChatModule {}
