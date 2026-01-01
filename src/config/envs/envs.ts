/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import 'dotenv/config';
import * as joi from 'joi';
import { EnvConfig } from 'src/types/envs';

const envVarsSchema = joi
  .object<EnvConfig>({
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
    BCRYPT_SALT_ROUND: joi.number().required(),
    JWT_SECRET: joi.string().required(),
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
  bcryptSaltRound: envVars.BCRYPT_SALT_ROUND,
  jwtSecret: envVars.JWT_SECRET,
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
};
