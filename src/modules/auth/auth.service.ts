/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { InjectRedis } from '@nestjs-modules/ioredis';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { StatusEnum } from 'src/common/enum';
import { envs } from 'src/config/envs';
import {
  ACCOUNT_LOCK_DURATION_SECONDS,
  DUMMY_BCRYPT_HASH,
  LENGTH_PASSWORD_DEFAULT,
  MAX_LOGIN_FAILED_ATTEMPTS,
  MAX_OTP_VERIFY_ATTEMPTS,
  SYMBOLS,
  TTL_OTP_SECONDS,
  TTL_RESET_PASSWORD_TOKEN_SECONDS,
} from 'src/constants';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import {
  IForgotPassword,
  IGoogleUser,
  IJwtTokenPayload,
  ILogin,
  IRegister,
  IResetPassword,
  JwtTokenPurpose,
} from 'src/interface/auth.interface';
import { parseExpiresIn } from 'src/utils';
import { generateNumericOtp } from 'src/utils/otp.util';

import { MailService } from '../mail/mail.service';
import { UserService } from '../user/user.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  private readonly logger = new Logger(AuthService.name, { timestamp: true });

  /**
   * Băm token bằng SHA-256 trước khi đưa vào bcrypt để tránh lỗi giới hạn 72-byte của thuật toán bcrypt
   * (Giúp Refresh Token Rotation phân biệt chính xác mọi chữ ký JWT mới).
   */
  private preHashTokenForBcrypt(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * 1. Xác thực thông tin đăng nhập (Chống Timing Attack, Khoá tài khoản tạm thời khi sai mật khẩu nhiều lần)
   */
  async validateUser(payload: { data: ILogin }): Promise<any> {
    const email = payload.data.email.trim().toLowerCase();
    const { password } = payload.data;

    const user = await this.userService.findUserByEmail({
      email,
      skipError: true,
      includeSecrets: true,
      withDeleted: true,
    });

    // Chống Timing Attack (User Enumeration): Luôn chạy bcrypt.compare ngay cả khi email không tồn tại
    if (!user) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      return null;
    }

    if (user.deletedAt) {
      throw new UnauthorizedException({
        status: HttpStatus.UNAUTHORIZED,
        message: HTTP_RESPONSE.AUTH.CONFLICT.message,
        code: HTTP_RESPONSE.AUTH.CONFLICT.code,
      });
    }

    // Kiểm tra trạng thái khoá tài khoản tạm thời (Account Lockout)
    if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
      const remainingSeconds = Math.ceil(
        (new Date(user.lockedUntil).getTime() - Date.now()) / 1000,
      );
      throw new ForbiddenException({
        status: HttpStatus.FORBIDDEN,
        message: HTTP_RESPONSE.AUTH.ACCOUNT_LOCKED.message,
        code: HTTP_RESPONSE.AUTH.ACCOUNT_LOCKED.code,
        retryAfterSeconds: remainingSeconds,
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      const nextAttempts = (user.failedLoginAttempts || 0) + 1;
      const shouldLock = nextAttempts >= MAX_LOGIN_FAILED_ATTEMPTS;
      const lockedUntil = shouldLock
        ? new Date(Date.now() + ACCOUNT_LOCK_DURATION_SECONDS * 1000)
        : null;

      await this.userService.updateUser({
        userId: user.id,
        data: {
          failedLoginAttempts: shouldLock ? 0 : nextAttempts,
          lockedUntil,
        },
      });

      if (shouldLock) {
        throw new ForbiddenException({
          status: HttpStatus.FORBIDDEN,
          message: HTTP_RESPONSE.AUTH.ACCOUNT_LOCKED.message,
          code: HTTP_RESPONSE.AUTH.ACCOUNT_LOCKED.code,
          retryAfterSeconds: ACCOUNT_LOCK_DURATION_SECONDS,
        });
      }

      return null;
    }

    if (user.status === StatusEnum.NOT_ACTIVE) {
      throw new UnauthorizedException({
        status: HttpStatus.UNAUTHORIZED,
        message: HTTP_RESPONSE.AUTH.STATUS_ERROR.message,
        code: HTTP_RESPONSE.AUTH.STATUS_ERROR.code,
      });
    }

    const { password: _p, refreshToken: _rt, ...result } = user;
    return result;
  }

  /**
   * 2. Xác thực User từ JWT Access Token (Kiểm tra thu hồi phiên khi đổi mật khẩu hoặc đăng xuất)
   */
  async validateUserById(payload: { id: string; iat?: number }): Promise<any> {
    const { id, iat } = payload;

    // Kiểm tra mốc thu hồi phiên tức thì trong Redis (khi user logout hoặc đổi mật khẩu)
    try {
      const revokedAfterStr = await this.redis.get(`auth:revoked_after:${id}`);
      if (revokedAfterStr && iat && iat * 1000 < Number(revokedAfterStr)) {
        throw new UnauthorizedException({
          status: HttpStatus.UNAUTHORIZED,
          message: HTTP_RESPONSE.AUTH.UNAUTHORIZED.message,
          code: HTTP_RESPONSE.AUTH.UNAUTHORIZED.code,
        });
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
    }

    const user = await this.userService.findUserById({
      userId: id,
      withDeleted: true,
      skipError: true,
    });

    if (!user) {
      throw new UnauthorizedException({
        status: HttpStatus.UNAUTHORIZED,
        message: HTTP_RESPONSE.AUTH.UNAUTHORIZED.message,
        code: HTTP_RESPONSE.AUTH.UNAUTHORIZED.code,
      });
    }

    if (user.deletedAt) {
      throw new UnauthorizedException({
        status: HttpStatus.UNAUTHORIZED,
        message: HTTP_RESPONSE.AUTH.CONFLICT.message,
        code: HTTP_RESPONSE.AUTH.CONFLICT.code,
      });
    }

    if (user.status === StatusEnum.NOT_ACTIVE) {
      throw new UnauthorizedException({
        status: HttpStatus.UNAUTHORIZED,
        message: HTTP_RESPONSE.AUTH.STATUS_ERROR.message,
        code: HTTP_RESPONSE.AUTH.STATUS_ERROR.code,
      });
    }

    // Nếu mật khẩu đã thay đổi sau thời điểm cấp Access Token, vô hiệu hoá Access Token cũ
    if (user.passwordChangedAt && iat) {
      const pwdChangedSec = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
      if (iat < pwdChangedSec) {
        throw new UnauthorizedException({
          status: HttpStatus.UNAUTHORIZED,
          message: HTTP_RESPONSE.AUTH.UNAUTHORIZED.message,
          code: HTTP_RESPONSE.AUTH.UNAUTHORIZED.code,
        });
      }
    }

    const { password, refreshToken, ...result } = user;
    return result;
  }

  /**
   * 3. Đăng nhập: Cấp cặp Access/Refresh Token với JTI riêng, cập nhật lịch sử đăng nhập & reset bộ đếm lỗi
   */
  async login(payload: { id: string; ipAddress?: string }) {
    const { id, ipAddress } = payload;
    const label = '[login]';
    this.logger.debug(`${label} userId -> ${id}`);

    const existingUser = await this.userService.findUserById({ userId: id });
    const now = new Date();
    const tokens = this.getTokens({ userId: id });
    const hashedRefreshToken = await this.hashRefreshToken(tokens.refreshToken);

    const user = await this.userService.updateUser({
      userId: id,
      data: {
        refreshToken: hashedRefreshToken,
        lastSignInAt: existingUser.currentSignInAt ?? now,
        currentSignInAt: now,
        lastSignInIp: ipAddress ?? existingUser.lastSignInIp ?? null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    const { password, refreshToken, ...result } = user;
    return {
      user: result,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  /**
   * 4. Đăng xuất: Xoá Refresh Token trong DB và ghi nhận mốc thu hồi Access Token trên Redis
   */
  async logout(payload: { userId: string }) {
    const { userId } = payload;
    try {
      await this.redis.set(`auth:revoked_after:${userId}`, String(Date.now()), 'EX', 86400);
    } catch (error) {
      this.logger.warn(`Failed to set revoked_after in Redis for user ${userId}: ${error}`);
    }

    return await this.userService.updateUser({
      userId,
      data: { refreshToken: null },
    });
  }

  private getTokens(payload: { userId: string }) {
    const accessToken = this.getJwtToken({
      userId: payload.userId,
      type: 'access',
      secret: envs.jwtSecret,
      expiresIn: parseExpiresIn(envs.jwtExpiresIn),
    });
    const refreshToken = this.getJwtToken({
      userId: payload.userId,
      type: 'refresh',
      secret: envs.jwtRefreshSecret,
      expiresIn: parseExpiresIn(envs.jwtRefreshExpiresIn),
    });

    return {
      accessToken,
      refreshToken,
    };
  }

  private getJwtToken(payload: {
    userId: string;
    type: JwtTokenPurpose;
    secret: string;
    expiresIn?: string | number;
  }): string {
    const { userId, type, secret, expiresIn } = payload;
    const tokenPayload: IJwtTokenPayload = {
      id: userId,
      type,
      jti: crypto.randomUUID(),
    };

    return this.jwtService.sign(tokenPayload, {
      secret,
      expiresIn,
    } as any);
  }

  private async hashRefreshToken(refreshToken: string): Promise<string> {
    const digest = this.preHashTokenForBcrypt(refreshToken);
    return bcrypt.hash(digest, envs.bcryptSaltRound);
  }

  async updateRefreshTokenHash(payload: { userId: string; refreshToken: string }) {
    const hashedRefreshToken = await this.hashRefreshToken(payload.refreshToken);

    return await this.userService.updateUser({
      userId: payload.userId,
      data: { refreshToken: hashedRefreshToken },
    });
  }

  /**
   * 5. Refresh Token Rotation + Reuse Detection:
   * Nếu phát hiện Refresh Token cũ bị tái sử dụng (Token Theft / Replay), lập tức thu hồi toàn bộ phiên của user!
   */
  async refreshTokens(payload: { userId: string; refreshToken: string }) {
    const { userId, refreshToken } = payload;
    const user = await this.userService.findUserById({
      userId,
      includeSecrets: true,
      skipError: true,
    });

    if (!user || !user.refreshToken || user.deletedAt || user.status !== StatusEnum.ACTIVE) {
      throw new ForbiddenException({
        status: HttpStatus.FORBIDDEN,
        message: HTTP_RESPONSE.AUTH.ACCESS_DENIED.message,
        code: HTTP_RESPONSE.AUTH.ACCESS_DENIED.code,
      });
    }

    const digest = this.preHashTokenForBcrypt(refreshToken);
    let isTokenMatching = await bcrypt.compare(digest, user.refreshToken);

    // Tương thích ngược (Backward Compatibility) với các refreshToken cũ trước khi nâng cấp SHA-256 pre-hash
    if (!isTokenMatching) {
      isTokenMatching = await bcrypt.compare(refreshToken, user.refreshToken);
    }

    if (!isTokenMatching) {
      // Phát hiện Refresh Token Reuse: Thu hồi toàn bộ phiên đăng nhập để bảo vệ tài khoản
      this.logger.warn(
        `[Security Alert] Refresh token reuse detected for userId=${userId}. Revoking active session.`,
      );
      await this.logout({ userId });
      throw new ForbiddenException({
        status: HttpStatus.FORBIDDEN,
        message: HTTP_RESPONSE.AUTH.NOT_MATCH_TOKEN.message,
        code: HTTP_RESPONSE.AUTH.NOT_MATCH_TOKEN.code,
      });
    }

    const tokens = this.getTokens({ userId });
    await this.updateRefreshTokenHash({
      userId,
      refreshToken: tokens.refreshToken,
    });

    return tokens;
  }

  /**
   * 6. Đăng ký tài khoản mới + Ký Activation Token bằng `jwtActivationSecret` tách biệt
   * Hỗ trợ gửi lại email kích hoạt nếu tài khoản đã đăng ký trước đó nhưng chưa kích hoạt.
   */
  async register(payload: { data: IRegister }) {
    const email = payload.data.email.trim().toLowerCase();
    const name = payload.data.name.trim();
    const password = payload.data.password;

    const existingUser = await this.userService.findUserByEmail({
      email,
      skipError: true,
      withDeleted: true,
    });

    if (existingUser) {
      if (!existingUser.deletedAt && existingUser.status === StatusEnum.NOT_ACTIVE) {
        // Nếu tài khoản đã đăng ký nhưng chưa kích hoạt, gửi lại email kích hoạt mới
        const activationToken = this.getJwtToken({
          userId: existingUser.id,
          type: 'activation',
          secret: envs.jwtActivationSecret,
          expiresIn: parseExpiresIn(envs.jwtActivationExpiresIn),
        });
        await this.mailService.sendUserWelcome({
          email: existingUser.email,
          name: existingUser.name,
          token: activationToken,
        });
        const { password: _p, refreshToken: _rt, ...safeExisting } = existingUser;
        return safeExisting;
      }

      throw new BadRequestException({
        status: HttpStatus.BAD_REQUEST,
        message: HTTP_RESPONSE.USER.EMAIL_EXITED.message,
        code: HTTP_RESPONSE.USER.EMAIL_EXITED.code,
      });
    }

    const user = await this.userService.createUser({
      data: {
        email,
        name,
        password,
        provider: 'local',
        status: StatusEnum.NOT_ACTIVE,
      },
    });

    const activationToken = this.getJwtToken({
      userId: user.id,
      type: 'activation',
      secret: envs.jwtActivationSecret,
      expiresIn: parseExpiresIn(envs.jwtActivationExpiresIn),
    });

    await this.mailService.sendUserWelcome({
      email: user.email,
      name: user.name,
      token: activationToken,
    });

    return user;
  }

  /**
   * 7. Gửi lại email kích hoạt tài khoản (Resend Activation Email)
   */
  async resendActivationEmail(payload: { email: string }) {
    const email = payload.email.trim().toLowerCase();
    const user = await this.userService.findUserByEmail({
      email,
      skipError: true,
    });

    if (user && user.status === StatusEnum.NOT_ACTIVE && !user.deletedAt) {
      const activationToken = this.getJwtToken({
        userId: user.id,
        type: 'activation',
        secret: envs.jwtActivationSecret,
        expiresIn: parseExpiresIn(envs.jwtActivationExpiresIn),
      });

      await this.mailService.sendUserWelcome({
        email: user.email,
        name: user.name,
        token: activationToken,
      });
    }

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.AUTH.RESEND_ACTIVATION_SUCCESS.message,
      code: HTTP_RESPONSE.AUTH.RESEND_ACTIVATION_SUCCESS.code,
    };
  }

  /**
   * 8. Quên mật khẩu:
   * - Không ném lỗi 404 khi email không tồn tại (chống dò tìm email - User Enumeration).
   * - Băm mã OTP bằng SHA-256 trước khi lưu vào Redis và thiết lập bộ đếm giới hạn số lần thử.
   */
  async forgotPassword(payload: IForgotPassword) {
    const label = '[forgotPassword]';
    const email = payload.email.trim().toLowerCase();
    const user = await this.userService.findUserByEmail({
      email,
      skipError: true,
    });

    if (user && !user.deletedAt) {
      const otp = generateNumericOtp();
      const hashedOtp = this.preHashTokenForBcrypt(otp);
      const otpKey = `reset-password-otp:${user.email}`;
      const attemptsKey = `reset-password-otp-attempts:${user.email}`;

      try {
        await this.redis
          .multi()
          .set(otpKey, hashedOtp, 'EX', TTL_OTP_SECONDS)
          .set(attemptsKey, '0', 'EX', TTL_OTP_SECONDS)
          .exec();

        await this.mailService.sendPasswordResetOtp({
          email: user.email,
          name: user.name,
          otp,
        });
      } catch (error) {
        this.logger.error(`${label} Redis set OTP error for key ${otpKey} -> ${error}`);
      }
    }
  }

  /**
   * 9. Xác thực mã OTP đặt lại mật khẩu:
   * - Giới hạn tối đa 5 lần nhập sai cho mỗi mã OTP (Brute-force protection).
   * - So sánh Timing-safe (`crypto.timingSafeEqual`).
   * - Cấp `resetToken` và lưu cờ xác thực vào Redis (`reset-password-verified:<email>`) để bước `resetPassword` kiểm tra bắt buộc.
   */
  async verifyPasswordResetOtp(payload: { email: string; otp: string }) {
    const label = '[verifyPasswordResetOtp]';
    const email = payload.email.trim().toLowerCase();
    const otp = payload.otp.trim();

    const otpKey = `reset-password-otp:${email}`;
    const attemptsKey = `reset-password-otp-attempts:${email}`;
    const verifiedKey = `reset-password-verified:${email}`;

    let storedHashedOtp: string | null = null;
    try {
      storedHashedOtp = await this.redis.get(otpKey);
    } catch (error) {
      this.logger.error(`${label} Redis get OTP error for key ${otpKey} -> ${error}`);
      throw new BadRequestException({
        status: HttpStatus.BAD_REQUEST,
        message: HTTP_RESPONSE.AUTH.INVALID_OTP.message,
        code: HTTP_RESPONSE.AUTH.INVALID_OTP.code,
      });
    }

    if (!storedHashedOtp) {
      throw new BadRequestException({
        status: HttpStatus.BAD_REQUEST,
        message: HTTP_RESPONSE.AUTH.INVALID_OTP.message,
        code: HTTP_RESPONSE.AUTH.INVALID_OTP.code,
      });
    }

    const attempts = await this.redis.incr(attemptsKey);
    if (attempts > MAX_OTP_VERIFY_ATTEMPTS) {
      await this.redis.del(otpKey, attemptsKey);
      throw new ForbiddenException({
        status: HttpStatus.FORBIDDEN,
        message: HTTP_RESPONSE.AUTH.OTP_MAX_ATTEMPTS_EXCEEDED.message,
        code: HTTP_RESPONSE.AUTH.OTP_MAX_ATTEMPTS_EXCEEDED.code,
      });
    }

    const incomingHashedOtp = this.preHashTokenForBcrypt(otp);
    const isHashMatch =
      storedHashedOtp.length === incomingHashedOtp.length &&
      crypto.timingSafeEqual(Buffer.from(storedHashedOtp), Buffer.from(incomingHashedOtp));

    // Hỗ trợ tương thích nếu trong Redis đang lưu OTP dạng thuần từ phiên bản cũ
    const isLegacyMatch = !isHashMatch && storedHashedOtp === otp;

    if (!isHashMatch && !isLegacyMatch) {
      throw new BadRequestException({
        status: HttpStatus.BAD_REQUEST,
        message: HTTP_RESPONSE.AUTH.INVALID_OTP.message,
        code: HTTP_RESPONSE.AUTH.INVALID_OTP.code,
      });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedResetToken = this.preHashTokenForBcrypt(resetToken);

    await this.redis
      .multi()
      .del(otpKey, attemptsKey)
      .set(verifiedKey, hashedResetToken, 'EX', TTL_RESET_PASSWORD_TOKEN_SECONDS)
      .exec();

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.AUTH.OTP_VERIFIED.message,
      code: HTTP_RESPONSE.AUTH.OTP_VERIFIED.code,
      data: {
        resetToken,
        expiresInSeconds: TTL_RESET_PASSWORD_TOKEN_SECONDS,
      },
    };
  }

  /**
   * 10. Đặt lại mật khẩu mới:
   * - BẮT BUỘC phải có phiên xác thực OTP hợp lệ trong Redis (`reset-password-verified:<email>`).
   * - Sau khi đổi mật khẩu thành công: xoá cờ xác thực OTP, thu hồi toàn bộ Refresh Token & Access Token cũ, và mở khoá tài khoản nếu đang bị khoá.
   */
  async resetPassword(payload: IResetPassword) {
    const email = payload.email.trim().toLowerCase();
    const { newPassword, resetToken } = payload;

    const verifiedKey = `reset-password-verified:${email}`;
    const storedVerificationHash = await this.redis.get(verifiedKey);

    if (!storedVerificationHash) {
      throw new ForbiddenException({
        status: HttpStatus.FORBIDDEN,
        message: HTTP_RESPONSE.AUTH.RESET_SESSION_EXPIRED.message,
        code: HTTP_RESPONSE.AUTH.RESET_SESSION_EXPIRED.code,
      });
    }

    if (resetToken) {
      const incomingHash = this.preHashTokenForBcrypt(resetToken.trim());
      const isTokenValid =
        storedVerificationHash.length === incomingHash.length &&
        crypto.timingSafeEqual(Buffer.from(storedVerificationHash), Buffer.from(incomingHash));

      if (!isTokenValid) {
        throw new ForbiddenException({
          status: HttpStatus.FORBIDDEN,
          message: HTTP_RESPONSE.AUTH.RESET_SESSION_EXPIRED.message,
          code: HTTP_RESPONSE.AUTH.RESET_SESSION_EXPIRED.code,
        });
      }
    }

    // Xoá ngay phiên xác thực OTP (One-time use)
    await this.redis.del(verifiedKey);

    const user = await this.userService.findUserByEmail({
      email,
      skipError: true,
    });

    if (user) {
      const hashedPassword = await bcrypt.hash(newPassword, envs.bcryptSaltRound);
      const now = new Date();
      await this.userService.updateUser({
        userId: user.id,
        data: {
          password: hashedPassword,
          passwordChangedAt: now,
          refreshToken: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      await this.redis.set(`auth:revoked_after:${user.id}`, String(now.getTime()), 'EX', 86400);
    }

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.AUTH.PASSWORD_RESET_SUCCESS.message,
      code: HTTP_RESPONSE.AUTH.PASSWORD_RESET_SUCCESS.code,
    };
  }

  /**
   * 11. Kích hoạt tài khoản qua email:
   * - Xác thực bằng `jwtActivationSecret` (có fallback sang `jwtSecret` để tương thích với các email cũ đã gửi).
   * - Chặn dùng Access Token hoặc Refresh Token để gọi API kích hoạt.
   */
  async activateAccount(token: string) {
    const label = '[activateAccount]';
    try {
      let payload: IJwtTokenPayload;
      try {
        payload = await this.jwtService.verifyAsync<IJwtTokenPayload>(token, {
          secret: envs.jwtActivationSecret,
        });
      } catch {
        payload = await this.jwtService.verifyAsync<IJwtTokenPayload>(token, {
          secret: envs.jwtSecret,
        });
      }

      if (payload.type && payload.type !== 'activation') {
        throw new UnauthorizedException({
          status: HttpStatus.UNAUTHORIZED,
          message: HTTP_RESPONSE.AUTH.ACTIVATE_FAILED.message,
          code: HTTP_RESPONSE.AUTH.ACTIVATE_FAILED.code,
        });
      }

      const userId = payload.id;

      const user = await this.userService.findUserById({
        userId,
        skipError: true,
      });
      if (!user) {
        throw new UnauthorizedException({
          status: HttpStatus.UNAUTHORIZED,
          message: HTTP_RESPONSE.USER.NOT_FOUND.message,
          code: HTTP_RESPONSE.USER.NOT_FOUND.code,
        });
      }

      if (user.status === StatusEnum.ACTIVE) {
        return {
          status: HttpStatus.BAD_REQUEST,
          message: HTTP_RESPONSE.AUTH.ALREADY_ACTIVE.message,
          code: HTTP_RESPONSE.AUTH.ALREADY_ACTIVE.code,
        };
      }

      await this.userService.updateUser({
        userId,
        data: {
          status: StatusEnum.ACTIVE,
          emailVerifiedAt: new Date(),
        },
      });

      return {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.AUTH.ACTIVATE_SUCCESS.message,
        code: HTTP_RESPONSE.AUTH.ACTIVATE_SUCCESS.code,
      };
    } catch (error) {
      this.logger.error(`${label} error -> ${error}`);
      throw new UnauthorizedException({
        status: HttpStatus.UNAUTHORIZED,
        message: HTTP_RESPONSE.AUTH.ACTIVATE_FAILED.message,
        code: HTTP_RESPONSE.AUTH.ACTIVATE_FAILED.code,
      });
    }
  }

  /**
   * 12. Xác thực và đồng bộ tài khoản Google OAuth2:
   * - Sử dụng CSPRNG (`crypto.randomInt`) thay cho `Math.random()`.
   * - Tự động kích hoạt và liên kết `provider`/`uid` nếu tài khoản cũ chưa kích hoạt.
   */
  async validateGoogleUser(payload: { googleUser: IGoogleUser }) {
    const { googleUser } = payload;
    try {
      const normalizedEmail = googleUser.email.trim().toLowerCase();
      let user = await this.userService.findUserByEmail({
        email: normalizedEmail,
        skipError: true,
      });

      if (!user) {
        const { accessToken, ...newUser } = googleUser;
        const randomPassword = this.generateRandomPassword(LENGTH_PASSWORD_DEFAULT);
        user = await this.userService.createUser({
          data: {
            ...newUser,
            email: normalizedEmail,
            password: randomPassword,
            status: StatusEnum.ACTIVE,
            emailVerifiedAt: new Date(),
          },
        });
      } else if (user.status === StatusEnum.NOT_ACTIVE || !user.uid) {
        user = await this.userService.updateUser({
          userId: user.id,
          data: {
            status: StatusEnum.ACTIVE,
            provider: user.provider || googleUser.provider,
            uid: user.uid || googleUser.uid,
            emailVerifiedAt: user.emailVerifiedAt || new Date(),
          },
        });
      }

      return user;
    } catch (error) {
      this.logger.error(`[validateGoogleUser] error -> ${error}`);
      throw new InternalServerErrorException({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        message: HTTP_RESPONSE.AUTH.GOOGLE_ERROR.message,
        code: HTTP_RESPONSE.AUTH.GOOGLE_ERROR.code,
      });
    }
  }

  generateRandomPassword(length: number): string {
    let password = '';
    for (let i = 0; i < length; i++) {
      const randomIndex = crypto.randomInt(0, SYMBOLS.length);
      password += SYMBOLS[randomIndex];
    }
    return password;
  }
}
