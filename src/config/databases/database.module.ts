import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DatabaseEvolutionService } from './database-evolution.service';
import { dataSourceOptions } from './db-datasource';
import { TablePartitionManagerService } from './table-partition-manager.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        ...dataSourceOptions,
        autoLoadEntities: true,
      }),
    }),
  ],
  providers: [DatabaseEvolutionService, TablePartitionManagerService],
  exports: [DatabaseEvolutionService, TablePartitionManagerService],
})
export class DatabaseModule {}
