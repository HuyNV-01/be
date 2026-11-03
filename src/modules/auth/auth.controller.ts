/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';

import express from 'express';
import { envs } from 'src/config/envs';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { ForgotPasswordDto } from 'src/dto/auth/forgot-password.dto';
import { LoginDto } from 'src/dto/auth/login.dto';
import { RegisterDto } from 'src/dto/auth/register.dto';
import { ResetPasswordDto } from 'src/dto/auth/reset-password.dto';
import { VerifyOtpDto } from 'src/dto/auth/verify-otp.dto';
import { parseExpiresInMs } from 'src/utils';

import { AuthService } from './auth.service';
import { AuthRateLimit, AuthRateLimitGuard } from './guards/auth-rate-limit.guard';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { LocalAuthGuard } from './guards/local-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}
  private readonly logger = new Logger(AuthController.name, {
    timestamp: true,
  });

  private getClearRefreshCookieOptions(): express.CookieOptions {
    return {
      httpOnly: true,
      secure: envs.isProduction,
      sameSite: envs.isProduction ? 'strict' : 'lax',
      path: '/api/auth/refresh',
    };
  }

  private getRefreshCookieOptions(): express.CookieOptions {
    return {
      ...this.getClearRefreshCookieOptions(),
      maxAge: parseExpiresInMs(envs.jwtRefreshExpiresIn),
    };
  }

  private extractClientIp(req: express.Request): string {
    const xForwardedFor = req.headers?.['x-forwarded-for'];
    if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
      return xForwardedFor.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  @ApiOperation({ summary: 'Register a new user account' })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'User registered successfully',
    schema: {
      example: {
        status: HttpStatus.CREATED,
        message: HTTP_RESPONSE.AUTH.CREATE_SUCCESS.message,
        code: HTTP_RESPONSE.AUTH.CREATE_SUCCESS.code,
      },
    },
  })
  @UseGuards(AuthRateLimitGuard)
  @AuthRateLimit({ keyPrefix: 'register', limit: 5, windowSeconds: 300, trackByEmail: true })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dataBody: RegisterDto) {
    await this.authService.register({ data: dataBody });
    return {
      status: HttpStatus.CREATED,
      message: HTTP_RESPONSE.AUTH.CREATE_SUCCESS.message,
      code: HTTP_RESPONSE.AUTH.CREATE_SUCCESS.code,
    };
  }

  @ApiOperation({ summary: 'Resend account activation email' })
  @ApiBody({ type: ForgotPasswordDto })
  @UseGuards(AuthRateLimitGuard)
  @AuthRateLimit({
    keyPrefix: 'resend-activation',
    limit: 3,
    windowSeconds: 300,
    trackByEmail: true,
  })
  @Post('resend-activation')
  @HttpCode(HttpStatus.OK)
  async resendActivation(@Body() dataBody: ForgotPasswordDto) {
    return this.authService.resendActivationEmail({ email: dataBody.email });
  }

  @ApiOperation({ summary: 'Login with email and password' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'User logged in successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.AUTH.LOGIN_SUCCESS.message,
        code: HTTP_RESPONSE.AUTH.LOGIN_SUCCESS.code,
        data: {
          user: {
            id: 'user-id',
            email: 'example@gmail.com',
            name: 'User Name',
            status: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        },
      },
    },
  })
  @UseGuards(AuthRateLimitGuard, LocalAuthGuard)
  @AuthRateLimit({ keyPrefix: 'login', limit: 10, windowSeconds: 60, trackByEmail: true })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Request() req: express.Request & { user: { id: string } },
    @Res({ passthrough: true }) res: express.Response,
    @Body() _loginDto: LoginDto,
  ) {
    const ipAddress = this.extractClientIp(req);
    const result = await this.authService.login({
      id: req.user.id,
      ipAddress,
    });
    res.cookie('refresh_token', result.refreshToken, this.getRefreshCookieOptions());
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.AUTH.LOGIN_SUCCESS.message,
      code: HTTP_RESPONSE.AUTH.LOGIN_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Logout and revoke current session' })
  @ApiBearerAuth('access-token')
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'User logged out successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.AUTH.LOGOUT_SUCCESS.message,
        code: HTTP_RESPONSE.AUTH.LOGOUT_SUCCESS.code,
      },
    },
  })
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Request() req: { user: { id: string } },
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const userId = req.user.id;
    await this.authService.logout({ userId });
    res.clearCookie('refresh_token', this.getClearRefreshCookieOptions());
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.AUTH.LOGOUT_SUCCESS.message,
      code: HTTP_RESPONSE.AUTH.LOGOUT_SUCCESS.code,
    };
  }

  @ApiOperation({ summary: 'Rotate refresh token and issue new token pair' })
  @ApiBearerAuth('refresh-token')
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Token refreshed successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.AUTH.REFRESH_TOKEN_SUCCESS.message,
        code: HTTP_RESPONSE.AUTH.REFRESH_TOKEN_SUCCESS.code,
        data: {
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token',
        },
      },
    },
  })
  @UseGuards(AuthRateLimitGuard, JwtRefreshGuard)
  @AuthRateLimit({ keyPrefix: 'refresh', limit: 20, windowSeconds: 60 })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshTokens(
    @Request() req: { user: { id: string; refreshToken: string } },
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const userId = req.user.id;
    const refreshToken = req.user.refreshToken;
    const result = await this.authService.refreshTokens({
      userId,
      refreshToken,
    });
    res.cookie('refresh_token', result.refreshToken, this.getRefreshCookieOptions());
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.AUTH.REFRESH_TOKEN_SUCCESS.message,
      code: HTTP_RESPONSE.AUTH.REFRESH_TOKEN_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Activate user account via email token' })
  @ApiQuery({ name: 'token', type: 'string' })
  @ApiResponse({
    status: HttpStatus.FOUND,
    description: 'Account activated successfully',
  })
  @Get('activate')
  async activateAccount(@Query('token') token: string, @Res() res: express.Response) {
    const label = '[activateAccount]';
    try {
      await this.authService.activateAccount(token);
      return res.redirect(`${envs.feUrl}/login?activated=true`);
    } catch (error) {
      this.logger.error(`${label} error -> ${error}`);
      return res.redirect(`${envs.feUrl}/login?activated=failed`);
    }
  }

  @ApiOperation({ summary: 'Request OTP for password reset' })
  @ApiBody({ type: ForgotPasswordDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'OTP sent successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.AUTH.FORGOT_PASSWORD_SUCCESS.message,
        code: HTTP_RESPONSE.AUTH.FORGOT_PASSWORD_SUCCESS.code,
      },
    },
  })
  @UseGuards(AuthRateLimitGuard)
  @AuthRateLimit({ keyPrefix: 'forgot-password', limit: 3, windowSeconds: 180, trackByEmail: true })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dataBody: ForgotPasswordDto) {
    const label = '[forgotPassword]';
    this.logger.debug(`${label} email -> ${dataBody.email}`);
    await this.authService.forgotPassword({ email: dataBody.email });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.AUTH.FORGOT_PASSWORD_SUCCESS.message,
      code: HTTP_RESPONSE.AUTH.FORGOT_PASSWORD_SUCCESS.code,
    };
  }

  @ApiOperation({ summary: 'Verify password reset OTP' })
  @ApiBody({ type: VerifyOtpDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'OTP verified successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.AUTH.OTP_VERIFIED.message,
        code: HTTP_RESPONSE.AUTH.OTP_VERIFIED.code,
        data: {
          resetToken: 'hex-reset-token',
          expiresInSeconds: 300,
        },
      },
    },
  })
  @UseGuards(AuthRateLimitGuard)
  @AuthRateLimit({ keyPrefix: 'verify-otp', limit: 5, windowSeconds: 180, trackByEmail: true })
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dataBody: VerifyOtpDto) {
    const { email, otp } = dataBody;
    return await this.authService.verifyPasswordResetOtp({
      email,
      otp,
    });
  }

  @ApiOperation({ summary: 'Reset password after OTP verification' })
  @ApiBody({ type: ResetPasswordDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Password reset successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.AUTH.PASSWORD_RESET_SUCCESS.message,
        code: HTTP_RESPONSE.AUTH.PASSWORD_RESET_SUCCESS.code,
      },
    },
  })
  @UseGuards(AuthRateLimitGuard)
  @AuthRateLimit({ keyPrefix: 'reset-password', limit: 5, windowSeconds: 300, trackByEmail: true })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dataBody: ResetPasswordDto) {
    const { email, newPassword, resetToken } = dataBody;
    return await this.authService.resetPassword({
      email,
      newPassword,
      resetToken,
    });
  }

  @UseGuards(GoogleAuthGuard)
  @Get('google')
  @HttpCode(HttpStatus.OK)
  async googleAuth() {}

  @UseGuards(GoogleAuthGuard)
  @Get('google/redirect')
  @HttpCode(HttpStatus.OK)
  async googleAuthRedirect(
    @Request() req: express.Request & { user: { id: string } },
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const ipAddress = this.extractClientIp(req);
    const result = await this.authService.login({
      id: req.user.id,
      ipAddress,
    });

    res.cookie('refresh_token', result.refreshToken, this.getRefreshCookieOptions());
    return res.redirect(`${envs.feUrl}?token=${result.accessToken}`);
  }

  @UseGuards(JwtAuthGuard)
  @Get('callback')
  @HttpCode(HttpStatus.OK)
  getProfile(@Request() req: { user: any }) {
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.AUTH.LOGIN_SUCCESS.message,
      code: HTTP_RESPONSE.AUTH.LOGIN_SUCCESS.code,
      data: req.user,
    };
  }
}
