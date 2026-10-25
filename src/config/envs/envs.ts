/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import 'dotenv/config';
import * as joi from 'joi';
import { FileProviderEnum } from 'src/common/enum';
import { EnvConfig } from 'src/types/envs';

const envVarsSchema = joi
  .object<EnvConfig>({
    NODE_ENV: joi.string().valid('development', 'production', 'test').default('development'),
    APP_URL: joi.string().required(),
    FE_URL: joi.string().required(),
    PORT: joi.number().default(3000),
    MYSQL_DB_NAME: joi.string().required(),
    MYSQL_USERNAME: joi.string().required(),
    MYSQL_PASSWORD: joi.string().required(),
    MYSQL_PORT: joi.number().required(),
    MYSQL_HOST: joi.string().required(),
    REDIS_HOST: joi.string().required(),
    REDIS_PORT: joi.number().required(),
    REDIS_PASSWORD: joi.string().optional().allow(''),
    BCRYPT_SALT_ROUND: joi.number().min(8).max(16).required(),
    JWT_SECRET: joi.string().required(),
    JWT_REFRESH_SECRET: joi.string().optional(),
    JWT_EXPIRES_IN: joi.string().required(),
    JWT_REFRESH_EXPIRES_IN: joi.string().required(),
    JWT_ACTIVATION_SECRET: joi.string().required(),
    JWT_ACTIVATION_EXPIRES_IN: joi.string().required(),
    MAIL_HOST: joi.string().required(),
    MAIL_USER: joi.string().required(),
    MAIL_PASS: joi.string().required(),
    MAIL_FROM: joi.string().required(),
    GOOGLE_CLIENT_ID: joi.string().required(),
    GOOGLE_CLIENT_SECRET: joi.string().required(),
    GOOGLE_CALLBACK_URL: joi.string().required(),

    STORAGE_PROVIDER: joi
      .string()
      .valid(...Object.values(FileProviderEnum))
      .optional(),
    STORAGE_BUCKET: joi.string().optional(),
    STORAGE_REGION: joi.string().default('ap-southeast-1'),
    STORAGE_ENDPOINT: joi.string().optional().allow(''),
    STORAGE_PUBLIC_ENDPOINT: joi.string().optional().allow(''),
    STORAGE_ACCESS_KEY: joi.string().optional().allow(''),
    STORAGE_SECRET_KEY: joi.string().optional().allow(''),
    STORAGE_FORCE_PATH_STYLE: joi.boolean().default(true),
    STORAGE_AUTO_CREATE_BUCKET: joi.boolean().default(true),
    STORAGE_LOCAL_DIR: joi.string().default('uploads'),
    STORAGE_SIGNING_SECRET: joi.string().optional(),

    CHAT_ENCRYPTION_KEY: joi.string().optional(),
    WEBRTC_STUN_URLS: joi
      .string()
      .default('stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
    WEBRTC_TURN_URLS: joi.string().optional().allow(''),
    WEBRTC_TURN_SECRET: joi.string().optional().allow(''),
    WEBRTC_TURN_TTL: joi.number().default(86400),
  })
  .unknown(true)
  .required();

const { error, value: envVars } = envVarsSchema.validate(process.env, {
  abortEarly: false,
});

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

export const envs = {
  nodeEnv: envVars.NODE_ENV || 'development',
  isProduction:
    (envVars.NODE_ENV || '').toLowerCase() === 'production' ||
    envVars.FE_URL.startsWith('https://'),
  appUrl: envVars.APP_URL,
  feUrl: envVars.FE_URL,
  port: envVars.PORT,
  database: envVars.MYSQL_DB_NAME,
  user: envVars.MYSQL_USERNAME,
  password: envVars.MYSQL_PASSWORD,
  dbport: envVars.MYSQL_PORT,
  host: envVars.MYSQL_HOST,
  redisHost: envVars.REDIS_HOST,
  redisPort: envVars.REDIS_PORT,
  redisPassword: envVars.REDIS_PASSWORD,
  bcryptSaltRound: Number(envVars.BCRYPT_SALT_ROUND),
  jwtSecret: envVars.JWT_SECRET,
  jwtRefreshSecret: envVars.JWT_REFRESH_SECRET || `${envVars.JWT_SECRET}_refresh`,
  jwtExpiresIn: envVars.JWT_EXPIRES_IN,
  jwtRefreshExpiresIn: envVars.JWT_REFRESH_EXPIRES_IN,
  jwtActivationSecret: envVars.JWT_ACTIVATION_SECRET,
  jwtActivationExpiresIn: envVars.JWT_ACTIVATION_EXPIRES_IN,
  mailHost: envVars.MAIL_HOST,
  mailUser: envVars.MAIL_USER,
  mailPass: envVars.MAIL_PASS,
  mailFrom: envVars.MAIL_FROM,
  googleClientId: envVars.GOOGLE_CLIENT_ID,
  googleClientSecret: envVars.GOOGLE_CLIENT_SECRET,
  googleCallbackUrl: envVars.GOOGLE_CALLBACK_URL,

  storage: {
    provider:
      envVars.STORAGE_PROVIDER ||
      (envVars.AWS_ENDPOINT ? FileProviderEnum.SEAWEEDFS : FileProviderEnum.LOCAL),
    bucket: envVars.STORAGE_BUCKET || envVars.AWS_BUCKET_NAME || 'app-bucket',
    region: envVars.STORAGE_REGION || envVars.AWS_REGION || 'ap-southeast-1',
    endpoint: envVars.STORAGE_ENDPOINT || envVars.AWS_ENDPOINT || 'http://localhost:8333',
    publicEndpoint:
      envVars.STORAGE_PUBLIC_ENDPOINT ||
      envVars.AWS_PUBLIC_ENDPOINT ||
      envVars.STORAGE_ENDPOINT ||
      envVars.AWS_ENDPOINT ||
      envVars.APP_URL,
    accessKey: envVars.STORAGE_ACCESS_KEY || envVars.AWS_ACCESS_KEY_ID || 'seaweedadmin',
    secretKey: envVars.STORAGE_SECRET_KEY || envVars.AWS_SECRET_ACCESS_KEY || 'seaweedsecret123',
    forcePathStyle: envVars.STORAGE_FORCE_PATH_STYLE ?? true,
    autoCreateBucket: envVars.STORAGE_AUTO_CREATE_BUCKET ?? true,
    localDir: envVars.STORAGE_LOCAL_DIR || 'uploads',
    signingSecret: envVars.STORAGE_SIGNING_SECRET || envVars.JWT_SECRET,
  },

  chat: {
    encryptionKey: envVars.CHAT_ENCRYPTION_KEY || envVars.JWT_SECRET,
    stunUrls: (
      envVars.WEBRTC_STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
    )
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    turnUrls: (envVars.WEBRTC_TURN_URLS || '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    turnSecret: envVars.WEBRTC_TURN_SECRET || envVars.JWT_SECRET,
    turnTtl: Number(envVars.WEBRTC_TURN_TTL || 86400),
  },
};
