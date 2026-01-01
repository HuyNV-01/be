/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import googleOauthConfig from 'src/config/oauth/google-oauth.config';
import { AuthService } from '../auth.service';
import { StatusEnum } from 'src/common/enum';
import { IGoogleUser } from 'src/interface/auth.interface';

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
    const googleUser: IGoogleUser = {
      email: profile.emails[0].value,
      name: profile.name.givenName + profile.name.familyName,
      password: '',
      status: StatusEnum.ACTIVE,
      provider: profile.provider,
      uid: profile.id,
      accessToken,
    };
    const user = await this.authService.validateGoogleUser({ googleUser });
    done(null, user);
    return user;
  }
}
