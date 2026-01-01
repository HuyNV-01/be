/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule } from '@nestjs/jwt';

import { RedisModule } from '@nestjs-modules/ioredis';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './config/databases/database.module';
import { DatabaseConfigModule } from './config/databases/module-db/db.module';
import { envs } from './config/envs';
import googleOauthConfig from './config/oauth/google-oauth.config';
import { redisConfig, redisOption } from './config/redis/redis.config';
import { AuthModule } from './modules/auth/auth.module';
import { ChatModule } from './modules/chat/chat.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { MailModule } from './modules/mail/mail.module';
import { UserModule } from './modules/user/user.module';
import { parseExpiresIn } from './utils';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      load: [googleOauthConfig],
    }),
    RedisModule.forRoot(redisOption),
    BullModule.forRoot({
      redis: {
        host: redisConfig.host,
        port: Number(redisConfig.port),
      },
    }),
    JwtModule.register({
      global: true,
      secret: envs.jwtSecret,
      signOptions: { expiresIn: parseExpiresIn(envs.jwtExpiresIn) as any },
    }),
    EventEmitterModule.forRoot({
      global: true,
      wildcard: true,
      delimiter: '.',
    }),
    DatabaseConfigModule,
    DatabaseModule,
    AuthModule,
    UserModule,
    MailModule,
    ChatModule,
    ContactsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
