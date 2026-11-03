import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WebSocketModule } from 'src/common/websocket/socket-state.module';
import { ContactEntity } from 'src/entity/contact.entity';
import { ConversationParticipantEntity } from 'src/entity/conversation-participant.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { MessageEntity } from 'src/entity/message.entity';
import { UserEntity } from 'src/entity/user.entity';

import { MediaModule } from '../media/media.module';
import { UserController } from './user.controller';
import { UserService } from './user.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      ContactEntity,
      ConversationEntity,
      ConversationParticipantEntity,
      MessageEntity,
    ]),
    MediaModule,
    WebSocketModule,
  ],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
