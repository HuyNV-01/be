import { FileProviderEnum } from 'src/common/enum';

export type EnvConfig = {
  APP_URL: string;
  FE_URL: string;
  PORT: number;
  MYSQL_PORT: number;
  MYSQL_USERNAME: string;
  MYSQL_DB_NAME: string;
  MYSQL_PASSWORD: string;
  MYSQL_HOST: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string;
  BCRYPT_SALT_ROUND: number;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  JWT_REFRESH_EXPIRES_IN: string;
  JWT_ACTIVATION_SECRET: string;
  JWT_ACTIVATION_EXPIRES_IN: string;
  MAIL_HOST: string;
  MAIL_USER: string;
  MAIL_PASS: string;
  MAIL_FROM: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_CALLBACK_URL: string;

  STORAGE_PROVIDER?: FileProviderEnum;
  STORAGE_BUCKET?: string;
  STORAGE_REGION?: string;
  STORAGE_ENDPOINT?: string;
  STORAGE_PUBLIC_ENDPOINT?: string;
  STORAGE_ACCESS_KEY?: string;
  STORAGE_SECRET_KEY?: string;
  STORAGE_FORCE_PATH_STYLE?: boolean;
  STORAGE_AUTO_CREATE_BUCKET?: boolean;
  STORAGE_LOCAL_DIR?: string;
  STORAGE_SIGNING_SECRET?: string;

  AWS_BUCKET_NAME?: string;
  AWS_REGION?: string;
  AWS_ENDPOINT?: string;
  AWS_PUBLIC_ENDPOINT?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;

  CHAT_ENCRYPTION_KEY?: string;
  WEBRTC_STUN_URLS?: string;
  WEBRTC_TURN_URLS?: string;
  WEBRTC_TURN_SECRET?: string;
  WEBRTC_TURN_TTL?: number;
};
