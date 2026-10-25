/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';

import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { StatusEnum } from 'src/common/enum';
import googleOauthConfig from 'src/config/oauth/google-oauth.config';
import { IGoogleUser } from 'src/interface/auth.interface';

import { AuthService } from '../auth.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    @Inject(googleOauthConfig.KEY)
    googleConfiguration: ConfigType<typeof googleOauthConfig> | undefined,
    private authService: AuthService,
  ) {
    if (!googleConfiguration) {
      throw new Error('Google configuration is not defined');
    }
    super({
      clientID: googleConfiguration.clientID,
      clientSecret: googleConfiguration.clientSecret,
      callbackURL: googleConfiguration.callbackURL,
      scope: ['email', 'profile'],
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ): Promise<any> {
    const rawEmail = profile?.emails?.[0]?.value;
    if (!rawEmail) {
      done(new UnauthorizedException('Google account does not provide a valid email'), false);
      return null;
    }

    const givenName = profile?.name?.givenName?.trim() || '';
    const familyName = profile?.name?.familyName?.trim() || '';
    const fullName =
      [givenName, familyName].filter(Boolean).join(' ') ||
      profile?.displayName?.trim() ||
      rawEmail.split('@')[0];

    const googleUser: IGoogleUser = {
      email: rawEmail.trim().toLowerCase(),
      name: fullName,
      password: '',
      status: StatusEnum.ACTIVE,
      provider: profile?.provider || 'google',
      uid: String(profile?.id || ''),
      accessToken,
    };

    const user = await this.authService.validateGoogleUser({ googleUser });
    done(null, user);
    return user;
  }
}
