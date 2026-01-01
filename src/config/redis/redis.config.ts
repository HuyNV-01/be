import { RedisModuleOptions } from '@nestjs-modules/ioredis';
import { HOST_DEFAULT, PORT_REDIS_DEFAULT } from 'src/constants';

import { envs } from '../envs';

export const redisConfig = {
  host: envs.redisHost || HOST_DEFAULT,
  port: envs.redisPort || PORT_REDIS_DEFAULT,
};

export const redisUrl = `redis://${redisConfig.host}:${redisConfig.port}`;

export const redisType = {
  single: 'single',
  cluster: 'cluster',
};

export const redisOption: RedisModuleOptions = {
  type: redisType.single,
  url: redisUrl,
} as RedisModuleOptions;
