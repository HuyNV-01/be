import { RedisModuleOptions } from '@nestjs-modules/ioredis';
import { HOST_DEFAULT, PORT_REDIS_DEFAULT } from 'src/constants';

import { envs } from '../envs';

export const redisConfig = {
  host: envs.redisHost || HOST_DEFAULT,
  port: Number(envs.redisPort || PORT_REDIS_DEFAULT),
  password: envs.redisPassword || undefined,
};

const authSegment = redisConfig.password ? `:${encodeURIComponent(redisConfig.password)}@` : '';

export const redisUrl = `redis://${authSegment}${redisConfig.host}:${redisConfig.port}`;

export const redisType = {
  single: 'single',
  cluster: 'cluster',
};

export const redisOption: RedisModuleOptions = {
  type: redisType.single,
  url: redisUrl,
  options: {
    password: redisConfig.password,
  },
} as RedisModuleOptions;
