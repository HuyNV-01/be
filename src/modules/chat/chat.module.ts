import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { MessageEntity } from 'src/entity/message.entity';
import { UserModule } from '../user/user.module';
import { ChatGateway } from './chat.gateway';
import { WebSocketModule } from 'src/common/websocket/socket-state.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ConversationParticipantEntity,
      ConversationEntity,
      MessageEntity,
    ]),
    UserModule,
    WebSocketModule,
  ],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway],
})
export class ChatModule {}
