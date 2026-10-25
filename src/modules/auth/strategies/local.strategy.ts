/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';

import { Request } from 'express';
import { Strategy } from 'passport-local';
import { HTTP_RESPONSE } from 'src/constants/http-response';

import { AuthService } from '../auth.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    super({
      usernameField: 'email',
      passReqToCallback: true,
    });
  }

  async validate(req: Request, email: string, password: string): Promise<any> {
    const xForwardedFor = req.headers['x-forwarded-for'];
    const ipAddress =
      typeof xForwardedFor === 'string'
        ? xForwardedFor.split(',')[0].trim()
        : req.ip || req.socket?.remoteAddress;

    const user = await this.authService.validateUser({
      data: {
        email: email?.trim().toLowerCase(),
        password,
        ipAddress,
        userAgent: req.headers['user-agent'],
      },
    });
    if (!user) {
      throw new UnauthorizedException({
        status: HttpStatus.UNAUTHORIZED,
        message: HTTP_RESPONSE.AUTH.INVALID_CREDENTIALS.message,
        code: HTTP_RESPONSE.AUTH.INVALID_CREDENTIALS.code,
      });
    }
    return user;
  }
}
