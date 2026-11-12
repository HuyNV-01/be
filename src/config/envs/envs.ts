/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import 'dotenv/config';
import * as joi from 'joi';
import { FileProviderEnum } from 'src/common/enum';
import {
  DEFAULT_TUNNEL_DOMAIN_SUFFIXES,
  normalizePublicBaseUrl,
  resolveProviderFromUrl,
  tunnelOriginRegistry,
} from 'src/config/tunnel/tunnel.config';
import { ITunnelGatewayConfig, TunnelProviderEnum } from 'src/config/tunnel/tunnel.interface';
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

    META_GRAPH_API_VERSION: joi.string().optional().default('v27.1'),
    META_APP_ID: joi.string().optional().allow(''),
    META_APP_SECRET: joi.string().optional().allow(''),
    META_WEBHOOK_VERIFY_TOKEN: joi.string().optional().allow(''),
    ZALO_OA_API_VERSION: joi.string().optional().default('v3.0'),
    ZALO_APP_ID: joi.string().optional().allow(''),
    ZALO_APP_SECRET: joi.string().optional().allow(''),
    ZALO_WEBHOOK_VERIFY_TOKEN: joi.string().optional().allow(''),
    TIKTOK_SHOP_APP_KEY: joi.string().optional().allow(''),
    TIKTOK_SHOP_APP_SECRET: joi.string().optional().allow(''),
    SHOPEE_PARTNER_ID: joi.string().optional().allow(''),
    SHOPEE_PARTNER_KEY: joi.string().optional().allow(''),

    PUBLIC_TUNNEL_PROVIDER: joi
      .string()
      .valid(...Object.values(TunnelProviderEnum))
      .optional()
      .allow(''),
    PUBLIC_TUNNEL_ENABLED: joi.boolean().optional(),
    PUBLIC_WEBHOOK_BASE_URL: joi.string().optional().allow(''),
    PUBLIC_FRONTEND_URL: joi.string().optional().allow(''),
    NGROK_DOMAIN: joi.string().optional().allow(''),
    NGROK_AUTHTOKEN: joi.string().optional().allow(''),
    NGROK_INSPECT_URL: joi.string().optional().allow('').default('http://127.0.0.1:4040'),
    PUBLIC_TUNNEL_AUTO_DETECT: joi.boolean().optional().default(true),
    PUBLIC_TUNNEL_ALLOW_WILDCARD_ORIGIN: joi.boolean().optional().default(true),
    CORS_ALLOWED_ORIGINS: joi.string().optional().allow(''),
    CORS_ALLOWED_DOMAIN_SUFFIXES: joi.string().optional().allow(''),
  })
  .unknown(true)
  .required();

const { error, value: envVars } = envVarsSchema.validate(process.env, {
  abortEarly: false,
});

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

const localAppUrl = normalizePublicBaseUrl(envVars.APP_URL) || envVars.APP_URL;
const localFeUrl = normalizePublicBaseUrl(envVars.FE_URL) || envVars.FE_URL;

const isTunnelExplicitlyDisabled = envVars.PUBLIC_TUNNEL_ENABLED === false;
const resolvedNgrokDomainUrl = isTunnelExplicitlyDisabled
  ? null
  : normalizePublicBaseUrl(envVars.NGROK_DOMAIN);
const resolvedPublicWebhookBaseUrl = isTunnelExplicitlyDisabled
  ? null
  : normalizePublicBaseUrl(envVars.PUBLIC_WEBHOOK_BASE_URL) || resolvedNgrokDomainUrl || null;
const resolvedPublicFrontendUrl = isTunnelExplicitlyDisabled
  ? null
  : normalizePublicBaseUrl(envVars.PUBLIC_FRONTEND_URL) || null;

const resolvedTunnelProvider = resolveProviderFromUrl(
  resolvedPublicWebhookBaseUrl,
  envVars.PUBLIC_TUNNEL_PROVIDER,
);

const extraAllowedOrigins = [
  localAppUrl,
  localFeUrl,
  ...(envVars.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => normalizePublicBaseUrl(item))
    .filter((item): item is string => Boolean(item)),
];

const allowedDomainSuffixes = (envVars.CORS_ALLOWED_DOMAIN_SUFFIXES || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const tunnelGatewayConfig: ITunnelGatewayConfig = {
  provider: resolvedTunnelProvider,
  enabled:
    envVars.PUBLIC_TUNNEL_ENABLED ??
    Boolean(resolvedPublicWebhookBaseUrl || resolvedTunnelProvider !== TunnelProviderEnum.NONE),
  publicWebhookBaseUrl: resolvedPublicWebhookBaseUrl,
  publicFrontendUrl: resolvedPublicFrontendUrl,
  ngrokDomain: envVars.NGROK_DOMAIN?.trim() || null,
  ngrokAuthtoken: envVars.NGROK_AUTHTOKEN?.trim() || null,
  ngrokInspectUrl: (envVars.NGROK_INSPECT_URL || 'http://127.0.0.1:4040').replace(/\/+$/, ''),
  autoDetectLocalAgent: isTunnelExplicitlyDisabled
    ? false
    : (envVars.PUBLIC_TUNNEL_AUTO_DETECT ?? true),
  allowWildcardTunnelOrigin: envVars.PUBLIC_TUNNEL_ALLOW_WILDCARD_ORIGIN ?? true,
  extraAllowedOrigins,
  allowedDomainSuffixes:
    allowedDomainSuffixes.length > 0 ? allowedDomainSuffixes : DEFAULT_TUNNEL_DOMAIN_SUFFIXES,
};

if (resolvedPublicWebhookBaseUrl) {
  tunnelOriginRegistry.setActivePublicBaseUrl(resolvedPublicWebhookBaseUrl);
}
if (resolvedPublicFrontendUrl) {
  tunnelOriginRegistry.setActiveFrontendUrl(resolvedPublicFrontendUrl);
}

const effectiveAppUrl = resolvedPublicWebhookBaseUrl || localAppUrl;
const effectiveFeUrl = resolvedPublicFrontendUrl || localFeUrl;

export const envs = {
  nodeEnv: envVars.NODE_ENV || 'development',
  isProduction:
    (envVars.NODE_ENV || '').toLowerCase() === 'production' ||
    effectiveFeUrl.startsWith('https://'),
  appUrl: effectiveAppUrl,
  feUrl: effectiveFeUrl,
  localAppUrl,
  localFeUrl,
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
      effectiveAppUrl,
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

  omnichannelSaas: {
    metaGraphApiVersion: envVars.META_GRAPH_API_VERSION || 'v27.1',
    metaAppId: envVars.META_APP_ID || '',
    metaAppSecret: envVars.META_APP_SECRET || '',
    metaWebhookVerifyToken: envVars.META_WEBHOOK_VERIFY_TOKEN || 'pancake_seller_os_verify_token',
    zaloOaApiVersion: envVars.ZALO_OA_API_VERSION || 'v3.0',
    zaloAppId: envVars.ZALO_APP_ID || '',
    zaloAppSecret: envVars.ZALO_APP_SECRET || '',
    zaloWebhookVerifyToken: envVars.ZALO_WEBHOOK_VERIFY_TOKEN || 'pancake_zalo_verify_token',
    tiktokShopAppKey: envVars.TIKTOK_SHOP_APP_KEY || '',
    tiktokShopAppSecret: envVars.TIKTOK_SHOP_APP_SECRET || '',
    shopeePartnerId: envVars.SHOPEE_PARTNER_ID || '',
    shopeePartnerKey: envVars.SHOPEE_PARTNER_KEY || '',
  },

  tunnel: tunnelGatewayConfig,
};
