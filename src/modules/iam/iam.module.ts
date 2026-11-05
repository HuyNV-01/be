import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WebSocketModule } from 'src/common/websocket/socket-state.module';
import { CustomTagEntity } from 'src/entity/custom-tag.entity';
import { NotificationEntity } from 'src/entity/notification.entity';
import { ShopInvitationEntity } from 'src/entity/shop-invitation.entity';
import { ShopMemberEntity } from 'src/entity/shop-member.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { UserEntity } from 'src/entity/user.entity';
import { WarehouseEntity } from 'src/entity/warehouse.entity';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';

import { ShopPermissionGuard } from './guards/shop-permission.guard';
import { GranularIamService } from './iam.service';
import { FieldLevelSecurityInterceptor } from './interceptors/field-level-security.interceptor';
import { WorkspaceOnboardingService } from './services/workspace-onboarding.service';
import { WorkspaceOnboardingController } from './workspace-onboarding.controller';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ShopWorkspaceEntity,
      ShopMemberEntity,
      ShopInvitationEntity,
      WarehouseEntity,
      CustomTagEntity,
      UserEntity,
      NotificationEntity,
    ]),
    WebSocketModule,
    NotificationsModule,
  ],
  controllers: [WorkspaceOnboardingController],
  providers: [
    GranularIamService,
    WorkspaceOnboardingService,
    ShopPermissionGuard,
    FieldLevelSecurityInterceptor,
  ],
  exports: [
    GranularIamService,
    WorkspaceOnboardingService,
    ShopPermissionGuard,
    FieldLevelSecurityInterceptor,
  ],
})
export class IamModule {}
