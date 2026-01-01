/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';

import { Strategy } from 'passport-local';
import { HTTP_RESPONSE } from 'src/constants/http-response';

import { AuthService } from '../auth.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    super({ usernameField: 'email' });
  }

  async validate(email: string, password: string): Promise<any> {
    const user = await this.authService.validateUser({
      data: { email, password },
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
