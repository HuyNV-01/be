import { registerAs } from '@nestjs/config';

import { envs } from 'src/config/envs';

export default registerAs('database.mysql', () => ({
  type: 'mysql',
  mysqlHost: envs.host,
  mysqlPort: envs.dbport,
  mysqlUsername: envs.user,
  mysqlPassword: envs.password,
  mysqlDbName: envs.database,
  entities: ['dist/**/*.entity.{js, ts}'],
  migrations: ['dist/config/databases/migrations'],
}));
