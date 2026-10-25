import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { InjectRedis } from '@nestjs-modules/ioredis';
import { Request } from 'express';
import Redis from 'ioredis';
import { HTTP_RESPONSE } from 'src/constants/http-response';

export interface AuthRateLimitOptions {
  keyPrefix: string;
  limit: number;
  windowSeconds: number;
  trackByEmail?: boolean;
}

export const AUTH_RATE_LIMIT_KEY = 'auth_rate_limit_options';

export const AuthRateLimit = (options: AuthRateLimitOptions) =>
  SetMetadata(AUTH_RATE_LIMIT_KEY, options);

/**
 * AuthRateLimitGuard:
 * Bảo vệ các endpoint nhạy cảm (Đăng nhập, Đăng ký, Quên mật khẩu, Xác thực OTP, Refresh Token)
 * chống tấn công Brute-force, Credential Stuffing và Spam Email bằng Redis Sliding/Fixed Window.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(AuthRateLimitGuard.name, { timestamp: true });

  constructor(
    private readonly reflector: Reflector,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<AuthRateLimitOptions | undefined>(
      AUTH_RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!options) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const ip = this.extractClientIp(req);
    const emailRaw =
      options.trackByEmail && req.body && typeof req.body.email === 'string'
        ? req.body.email.trim().toLowerCase()
        : '';

    const identifier = emailRaw ? `${ip}:${emailRaw}` : ip;
    const redisKey = `auth:ratelimit:${options.keyPrefix}:${identifier}`;

    try {
      const currentCount = await this.redis.incr(redisKey);
      if (currentCount === 1) {
        await this.redis.expire(redisKey, options.windowSeconds);
      }

      if (currentCount > options.limit) {
        const ttl = await this.redis.ttl(redisKey);
        throw new HttpException(
          {
            status: HttpStatus.TOO_MANY_REQUESTS,
            message: HTTP_RESPONSE.AUTH.RATE_LIMIT_EXCEEDED.message,
            code: HTTP_RESPONSE.AUTH.RATE_LIMIT_EXCEEDED.code,
            retryAfterSeconds: ttl > 0 ? ttl : options.windowSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      // Fail-open nếu Redis gặp sự cố tạm thời để không làm tê liệt toàn bộ dịch vụ
      this.logger.warn(`Rate limit check skipped due to Redis error: ${error}`);
    }

    return true;
  }

  private extractClientIp(req: Request): string {
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
      return xForwardedFor.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }
}
