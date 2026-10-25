import { join } from 'path';
import 'tsconfig-paths/register';
import { DataSource, DataSourceOptions } from 'typeorm';

import { envs } from '../envs/envs';

export const dataSourceOptions: DataSourceOptions = {
  type: 'mysql',
  host: envs.host,
  port: envs.dbport,
  username: envs.user,
  password: envs.password,
  database: envs.database,

  entities: [join(__dirname, '../../entity/**/*.entity{.ts,.js}')],
  migrations: [join(__dirname, './migrations/*{.ts,.js}')],

  synchronize: false,
  migrationsRun: process.env.DB_AUTO_MIGRATE === 'true',
  migrationsTransactionMode: 'each',
  migrationsTableName: 'typeorm_migrations',

  charset: 'utf8mb4',
  timezone: 'Z',
  maxQueryExecutionTime: Number(process.env.DB_SLOW_QUERY_THRESHOLD_MS || 2000),
  logging:
    process.env.DB_LOGGING === 'true' ? ['query', 'error', 'warn', 'schema'] : ['error', 'warn'],

  extra: {
    connectionLimit: Number(process.env.DB_POOL_SIZE || 20),
    maxIdle: Number(process.env.DB_MAX_IDLE || 10),
    idleTimeout: Number(process.env.DB_IDLE_TIMEOUT_MS || 60000),
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 10000,
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: false,
  },
};

const dataSource = new DataSource(dataSourceOptions);

export default dataSource;
