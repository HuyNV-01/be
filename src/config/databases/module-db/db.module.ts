import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import * as joi from 'joi';

import dbConfig from './db.config';
import { DatabaseConfigService } from './dbConfig.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [dbConfig],
      validationSchema: joi.object({
        MYSQL_DB_NAME: joi.string().required(),
        MYSQL_HOST: joi.string().required(),
        MYSQL_PORT: joi.number().required(),
        MYSQL_USERNAME: joi.string().required(),
        MYSQL_PASSWORD: joi.string(),
      }),
    }),
  ],
  providers: [ConfigService, DatabaseConfigService],
  exports: [ConfigService, DatabaseConfigService],
})
export class DatabaseConfigModule {}
