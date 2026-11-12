/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';

import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { envs } from 'src/config/envs';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { IJwtTokenPayload } from 'src/interface/auth.interface';

const collectCandidateRefreshTokens = (req: Request): string[] => {
  if (!req) return [];
  const candidates: string[] = [];

  const bearerToken = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
  if (bearerToken && bearerToken.trim()) {
    candidates.push(bearerToken.trim());
  }

  const headerRefreshToken = req.headers?.['x-refresh-token'];
  if (typeof headerRefreshToken === 'string' && headerRefreshToken.trim()) {
    candidates.push(headerRefreshToken.replace(/^Bearer\s+/i, '').trim());
  }

  const bodyRefreshToken = (req.body as Record<string, unknown> | undefined)?.refreshToken;
  if (typeof bodyRefreshToken === 'string' && bodyRefreshToken.trim()) {
    candidates.push(bodyRefreshToken.replace(/^Bearer\s+/i, '').trim());
  }

  const cookieToken = req.cookies?.['refresh_token'];
  if (typeof cookieToken === 'string' && cookieToken.trim()) {
    candidates.push(cookieToken.trim());
  }

  return Array.from(new Set(candidates));
};

const multiChannelRefreshExtractor = (req: Request): string | null => {
  const candidates = collectCandidateRefreshTokens(req);
  return candidates[0] ?? null;
};

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor() {
    super({
      jwtFromRequest: multiChannelRefreshExtractor,
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

    const candidates = collectCandidateRefreshTokens(req);
    const refreshToken = candidates[0] ?? '';

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
      candidateRefreshTokens: candidates,
    };
  }
}
