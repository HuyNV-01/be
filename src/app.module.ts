/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { DatabaseConfigModule } from './config/databases/module-db/db.module';
import { DatabaseModule } from './config/databases/database.module';
import { RedisModule } from '@nestjs-modules/ioredis';
import { redisConfig, redisOption } from './config/redis/redis.config';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { MailModule } from './modules/mail/mail.module';
import { BullModule } from '@nestjs/bull';
import { ChatModule } from './modules/chat/chat.module';
import googleOauthConfig from './config/oauth/google-oauth.config';
import { JwtModule } from '@nestjs/jwt';
import { envs } from './config/envs';
import { parseExpiresIn } from './utils';
import { ContactsModule } from './modules/contacts/contacts.module';
import { EventEmitterModule } from '@nestjs/event-emitter';

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
