import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WebSocketModule } from 'src/common/websocket/socket-state.module';
import { NotificationEntity } from 'src/entity/notification.entity';

import { UserModule } from '../user/user.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([NotificationEntity]), UserModule, WebSocketModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsListener],
  exports: [NotificationsService],
})
export class NotificationsModule {}
