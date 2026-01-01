import { StatusEnum } from 'src/common/enum';

export interface ILogin {
  email: string;
  password: string;
}

export interface IRegister {
  email: string;
  password: string;
  name: string;
}

export interface IForgotPassword {
  email: string;
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
