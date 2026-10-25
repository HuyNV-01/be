/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';

import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { envs } from 'src/config/envs';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { IJwtTokenPayload } from 'src/interface/auth.interface';

const cookieOrBearerExtractor = (req: Request): string | null => {
  if (req && req.cookies && req.cookies['refresh_token']) {
    return req.cookies['refresh_token'] as string;
  }
  return ExtractJwt.fromAuthHeaderAsBearerToken()(req);
};

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor() {
    super({
      jwtFromRequest: cookieOrBearerExtractor,
      ignoreExpiration: false,
      secretOrKey: envs.jwtRefreshSecret,
      passReqToCallback: true,
    });
  }

  validate(req: Request, payload: IJwtTokenPayload) {
    if (payload.type && payload.type !== 'refresh') {
      throw new UnauthorizedException({
        status: HttpStatus.UNAUTHORIZED,
        message: HTTP_RESPONSE.AUTH.UNAUTHORIZED.message,
        code: HTTP_RESPONSE.AUTH.UNAUTHORIZED.code,
      });
    }

    const refreshToken = cookieOrBearerExtractor(req) ?? '';

    if (!refreshToken) {
      throw new UnauthorizedException({
        status: HttpStatus.UNAUTHORIZED,
        message: HTTP_RESPONSE.AUTH.UNAUTHORIZED.message,
        code: HTTP_RESPONSE.AUTH.UNAUTHORIZED.code,
      });
    }

    return {
      ...payload,
      refreshToken,
    };
  }
}
