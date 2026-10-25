import { RedisModuleOptions } from '@nestjs-modules/ioredis';
import { HOST_DEFAULT, PORT_REDIS_DEFAULT } from 'src/constants';

import { envs } from '../envs/envs';

export const redisConfig = {
  host: envs.redisHost || HOST_DEFAULT,
  port: Number(envs.redisPort || PORT_REDIS_DEFAULT),
  password:
    envs.redisPassword && envs.redisPassword.trim() !== '' ? envs.redisPassword.trim() : undefined,
};

const authSegment = redisConfig.password ? `:${encodeURIComponent(redisConfig.password)}@` : '';

export const redisUrl = `redis://${authSegment}${redisConfig.host}:${redisConfig.port}`;

export const redisType = {
  single: 'single',
  cluster: 'cluster',
} as const;

export const redisOption: RedisModuleOptions = {
  type: redisType.single,
  options: {
    host: redisConfig.host,
    port: redisConfig.port,
    password: redisConfig.password,
    retryStrategy: (times: number) => Math.min(times * 200, 3000),
    maxRetriesPerRequest: null,
  },
};
