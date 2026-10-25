import { StatusEnum } from 'src/common/enum';

export type JwtTokenPurpose = 'access' | 'refresh' | 'activation' | 'reset_password';

export interface IJwtTokenPayload {
  id: string;
  type: JwtTokenPurpose;
  jti?: string;
  iat?: number;
  exp?: number;
}

export interface ILogin {
  email: string;
  password: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface IRegister {
  email: string;
  password: string;
  name: string;
}

export interface IForgotPassword {
  email: string;
}

export interface IResetPassword {
  email: string;
  newPassword: string;
  resetToken?: string;
}

export interface IGoogleUser {
  email: string;
  name: string;
  password: string;
  status: StatusEnum;
  provider: string;
  uid: string;
  accessToken: string;
}
