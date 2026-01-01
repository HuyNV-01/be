/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { SocketStateService } from 'src/common/websocket/socket-state.service';
import { envs } from 'src/config/envs';
import googleOauthConfig from 'src/config/oauth/google-oauth.config';
import { parseExpiresIn } from 'src/utils';

import { MailModule } from '../mail/mail.module';
import { UserModule } from '../user/user.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleStrategy } from './strategies/google.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    MailModule,
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: envs.jwtSecret,
        signOptions: { expiresIn: parseExpiresIn(envs.jwtExpiresIn) as any },
      }),
    }),
    ConfigModule.forFeature(googleOauthConfig),
    UserModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    LocalStrategy,
    JwtStrategy,
    JwtRefreshStrategy,
    GoogleStrategy,
    SocketStateService,
  ],
  exports: [JwtStrategy, PassportModule, JwtModule, AuthService, SocketStateService],
})
export class AuthModule {}
