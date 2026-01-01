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
import { ApiBearerAuth, ApiBody, ApiQuery, ApiResponse } from '@nestjs/swagger';

import express from 'express';
import { envs } from 'src/config/envs';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { ForgotPasswordDto } from 'src/dto/auth/forgot-password.dto';
import { LoginDto } from 'src/dto/auth/login.dto';
import { RegisterDto } from 'src/dto/auth/register.dto';
import { ResetPasswordDto } from 'src/dto/auth/reset-password.dto';
import { VerifyOtpDto } from 'src/dto/auth/verify-otp.dto';

import { AuthService } from './auth.service';
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
            status: 0,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        },
      },
    },
  })
  @UseGuards(LocalAuthGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Request() req: { user: { id: string } },
    @Res({ passthrough: true }) res: express.Response,
    @Body() loginDto: LoginDto,
  ) {
    const result = await this.authService.login({ id: req.user.id });
    res.cookie('refresh_token', result.refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/auth/refresh',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.AUTH.LOGIN_SUCCESS.message,
      code: HTTP_RESPONSE.AUTH.LOGIN_SUCCESS.code,
      data: result,
    };
  }

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
    res.clearCookie('refresh_token', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/auth/refresh',
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.AUTH.LOGOUT_SUCCESS.message,
      code: HTTP_RESPONSE.AUTH.LOGOUT_SUCCESS.code,
    };
  }

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
  @UseGuards(JwtRefreshGuard)
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
    res.cookie('refresh_token', result.refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/auth/refresh',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.AUTH.REFRESH_TOKEN_SUCCESS.message,
      code: HTTP_RESPONSE.AUTH.REFRESH_TOKEN_SUCCESS.code,
      data: result,
    };
  }

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

  @ApiBody({ type: VerifyOtpDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'OTP verified successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.AUTH.OTP_VERIFIED.message,
        code: HTTP_RESPONSE.AUTH.OTP_VERIFIED.code,
      },
    },
  })
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dataBody: VerifyOtpDto) {
    const { email, otp } = dataBody;
    const result = await this.authService.verifyPasswordResetOtp({
      email,
      otp,
    });
    return result;
  }

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
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dataBody: ResetPasswordDto) {
    const { email, newPassword } = dataBody;
    const result = await this.authService.resetPassword({
      email,
      newPassword,
    });
    return result;
  }

  @UseGuards(GoogleAuthGuard)
  @Get('google')
  @HttpCode(HttpStatus.OK)
  async googleAuth(@Req() req) {}

  @UseGuards(GoogleAuthGuard)
  @Get('google/redirect')
  @HttpCode(HttpStatus.OK)
  async googleAuthRedirect(
    @Request() req: { user: { id: string } },
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const result = await this.authService.login({ id: req.user.id });

    res.cookie('refresh_token', result.refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/auth/refresh',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
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
