/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import {
  IForgotPassword,
  IGoogleUser,
  ILogin,
  IRegister,
} from 'src/interface/auth.interface';
import * as bcrypt from 'bcrypt';
import { parseExpiresIn } from 'src/utils';
import { envs } from 'src/config/envs';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { StatusEnum } from 'src/common/enum';
import { MailService } from '../mail/mail.service';
import { generateNumericOtp } from 'src/utils/otp.util';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  LENGTH_PASSWORD_DEFAULT,
  SYMBOLS,
  TTL_OTP_SECONDS,
} from 'src/constants';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  private readonly logger = new Logger(AuthService.name, { timestamp: true });

  async validateUser(payload: { data: ILogin }): Promise<any> {
    const { email, password } = payload.data;
    const user = await this.userService.findUserByEmail({ email });
    if (user && user.status === StatusEnum.NOT_ACTIVE) {
      throw new UnauthorizedException({
        status: HttpStatus.UNAUTHORIZED,
        message: HTTP_RESPONSE.AUTH.STATUS_ERROR.message,
        code: HTTP_RESPONSE.AUTH.STATUS_ERROR.code,
      });
    }
    if (user && user.deletedAt) {
      throw new UnauthorizedException({
        status: HttpStatus.UNAUTHORIZED,
        message: HTTP_RESPONSE.AUTH.CONFLICT.message,
        code: HTTP_RESPONSE.AUTH.CONFLICT.code,
      });
    }
    if (user && (await bcrypt.compare(password, user.password))) {
      const { password, ...result } = user;
      return result;
    }
    return null;
  }

  async validateUserById(payload: { id: string }): Promise<any> {
    const { id } = payload;
    const user = await this.userService.findUserById({ userId: id });
    if (user.status === StatusEnum.NOT_ACTIVE) {
      throw new UnauthorizedException({
        status: HttpStatus.UNAUTHORIZED,
        message: HTTP_RESPONSE.AUTH.STATUS_ERROR.message,
        code: HTTP_RESPONSE.AUTH.STATUS_ERROR.code,
      });
    }
    if (user.deletedAt) {
      throw new UnauthorizedException({
        status: HttpStatus.UNAUTHORIZED,
        message: HTTP_RESPONSE.AUTH.CONFLICT.message,
        code: HTTP_RESPONSE.AUTH.CONFLICT.code,
      });
    }
    const { password, refreshToken, ...result } = user;
    return result;
  }

  async login(payload: { id: string }) {
    const { id } = payload;
    const label = '[login]';
    this.logger.debug(`${label} userId -> ${id}`);

    const tokens = this.getTokens({ userId: id });
    const user = await this.updateRefreshTokenHash({
      userId: id,
      refreshToken: tokens.refreshToken,
    });
    const { password, refreshToken, ...result } = user;
    return {
      user: result,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async logout(payload: { userId: string }) {
    return await this.userService.updateUser({
      userId: payload.userId,
      data: { refreshToken: null },
    });
  }

  private getTokens(payload: { userId: string }) {
    const accessToken = this.getJwtToken({
      userId: payload.userId,
      expiresIn: parseExpiresIn(envs.jwtExpiresIn),
    });
    const refreshToken = this.getJwtToken({
      userId: payload.userId,
      expiresIn: parseExpiresIn(envs.jwtRefreshExpiresIn),
    });

    return {
      accessToken: accessToken,
      refreshToken: refreshToken,
    };
  }

  private getJwtToken(payload: {
    userId: string;
    expiresIn?: string | number;
  }): string {
    const { userId, expiresIn } = payload;

    return this.jwtService.sign({ id: userId }, { expiresIn } as any);
  }

  async updateRefreshTokenHash(payload: {
    userId: string;
    refreshToken: string;
  }) {
    const hashedRefreshToken = await bcrypt.hash(
      payload.refreshToken,
      envs.bcryptSaltRound,
    );

    return await this.userService.updateUser({
      userId: payload.userId,
      data: { refreshToken: hashedRefreshToken },
    });
  }

  async refreshTokens(payload: { userId: string; refreshToken: string }) {
    const { userId, refreshToken } = payload;
    const user = await this.userService.findUserById({ userId });
    if (!user || !user.refreshToken) {
      throw new ForbiddenException({
        status: HttpStatus.FORBIDDEN,
        message: HTTP_RESPONSE.AUTH.ACCESS_DENIED.message,
        code: HTTP_RESPONSE.AUTH.ACCESS_DENIED.code,
      });
    }

    const isTokenMatching = await bcrypt.compare(
      refreshToken,
      user.refreshToken,
    );

    if (!isTokenMatching) {
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

  async register(payload: { data: IRegister }) {
    const { data: newUser } = payload;
    const user = await this.userService.createUser({ data: newUser });
    const { password, ...result } = user;
    const activationToken = this.getJwtToken({
      userId: user.id,
      expiresIn: parseExpiresIn(envs.jwtActivationExpiresIn),
    });

    await this.mailService.sendUserWelcome({
      email: newUser.email,
      name: newUser.name,
      token: activationToken,
    });
    return result;
  }

  async forgotPassword(payload: IForgotPassword) {
    const label = '[forgotPassword]';
    const { email } = payload;
    const user = await this.userService.findUserByEmail({ email });

    if (user) {
      const otp = generateNumericOtp();
      const redisKey = `reset-password-otp:${user.email}`;
      try {
        await this.redis.set(redisKey, otp, 'EX', TTL_OTP_SECONDS);
        await this.mailService.sendPasswordResetOtp({
          email: user.email,
          name: user.name,
          otp,
        });
      } catch (error) {
        this.logger.error(
          `${label} Redis set OTP error for key ${redisKey} -> ${error}`,
        );
      }
    }
  }

  async verifyPasswordResetOtp(payload: { email: string; otp: string }) {
    const label = '[verifyPasswordResetOtp]';
    const { email, otp } = payload;
    const redisKey = `reset-password-otp:${email}`;
    try {
      const storedOtp = await this.redis.get(redisKey);
      if (storedOtp !== otp) {
        throw new BadRequestException({
          status: HttpStatus.BAD_REQUEST,
          message: HTTP_RESPONSE.AUTH.INVALID_OTP.message,
          code: HTTP_RESPONSE.AUTH.INVALID_OTP.code,
        });
      }
      await this.redis.del(redisKey);
      return {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.AUTH.OTP_VERIFIED.message,
        code: HTTP_RESPONSE.AUTH.OTP_VERIFIED.code,
      };
    } catch (error) {
      this.logger.error(
        `${label} Redis get OTP error for key ${redisKey} -> ${error}`,
      );
      throw new BadRequestException({
        status: HttpStatus.BAD_REQUEST,
        message: HTTP_RESPONSE.AUTH.INVALID_OTP.message,
        code: HTTP_RESPONSE.AUTH.INVALID_OTP.code,
      });
    }
  }

  async resetPassword(payload: { email: string; newPassword: string }) {
    const { email, newPassword } = payload;
    const user = await this.userService.findUserByEmail({ email });
    const hashedPassword = await bcrypt.hash(newPassword, envs.bcryptSaltRound);
    if (user) {
      await this.userService.updateUser({
        userId: user.id,
        data: { password: hashedPassword },
      });
    }
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.AUTH.PASSWORD_RESET_SUCCESS.message,
      code: HTTP_RESPONSE.AUTH.PASSWORD_RESET_SUCCESS.code,
    };
  }

  async activateAccount(token: string) {
    const label = '[activateAccount]';
    try {
      const payload: { id: string } = await this.jwtService.verifyAsync(token, {
        secret: envs.jwtSecret,
      });

      const userId = payload.id;

      const user = await this.userService.findUserById({ userId });
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
        data: { status: StatusEnum.ACTIVE },
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

  async validateGoogleUser(payload: { googleUser: IGoogleUser }) {
    const { googleUser } = payload;
    try {
      let user = await this.userService.findUserByEmail({
        email: googleUser.email,
        skipError: true,
      });

      if (!user) {
        const { accessToken, ...newUser } = googleUser;
        const randomPassword = this.generateRandomPassword(
          LENGTH_PASSWORD_DEFAULT,
        );
        newUser.password = bcrypt.hashSync(
          randomPassword,
          envs.bcryptSaltRound,
        );
        user = await this.userService.createUser({ data: newUser });
      }

      return user;
    } catch (error) {
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
      const randomIndex = Math.floor(Math.random() * SYMBOLS.length);
      password += SYMBOLS[randomIndex];
    }
    return password;
  }
}
