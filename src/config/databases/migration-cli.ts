import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

import { DatabaseEvolutionService } from './database-evolution.service';
import dataSource from './db-datasource';
import { SmartMigrationEngine } from './smart-migration.engine';

type MigrationAction =
  | 'evolve'
  | 'prune'
  | 'generate'
  | 'create'
  | 'create:data'
  | 'run'
  | 'revert'
  | 'show'
  | 'log'
  | 'sync-data';

const action = process.argv[2] as MigrationAction | undefined;
const rawNameArg = process.argv
  .slice(3)
  .find((arg) => !arg.startsWith('-'))
  ?.replace(/^name=/i, '');

const migrationName = rawNameArg || process.env.npm_config_name || 'AutoMigration';
const maxKeepArg = process.argv
  .slice(3)
  .find((arg) => arg.startsWith('--keep='))
  ?.split('=')[1];
const maxKeepMigrations = maxKeepArg ? Math.max(1, Number(maxKeepArg)) : 5;

const dataSourcePath = resolve(__dirname, 'db-datasource.ts');
const typeormCliPath = resolve(process.cwd(), 'node_modules/typeorm/cli.js');
const migrationsDir = 'src/config/databases/migrations';

const typeormRunner = `npx ts-node -r tsconfig-paths/register "${typeormCliPath}"`;
const baseCli = `${typeormRunner} -d "${dataSourcePath}"`;

function runCommand(cmd: string): void {
  console.log(`\n🚀 [Database CLI] Executing: ${cmd}\n`);
  execSync(cmd, { stdio: 'inherit' });
}

function createDataMigrationTemplate(name: string): void {
  const timestamp = Date.now();
  const cleanName = name.replace(/[^a-zA-Z0-9]/g, '');
  const className = `${cleanName}${timestamp}`;
  const fileName = `${timestamp}-${cleanName}.ts`;
  const fullPath = resolve(process.cwd(), migrationsDir, fileName);

  const template = `import { MigrationInterface, QueryRunner } from 'typeorm';
  import { SchemaMigrationHelper } from '../schema-migration.helper';

  export class ${className} implements MigrationInterface {
    name = '${className}';

    public async up(queryRunner: QueryRunner): Promise<void> {
      // Ví dụ sử dụng SchemaMigrationHelper để thêm cột và tự động đồng bộ dữ liệu cũ mà không cần viết SQL thủ công:
      // await SchemaMigrationHelper.safeAddColumn(
      //   queryRunner,
      //   'users',
      //   { name: 'new_column', type: 'varchar', length: '100', isNullable: false },
      //   (row) => row.name || 'default_value',
      // );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
      // await SchemaMigrationHelper.safeDropColumn(queryRunner, 'users', 'new_column');
    }
  }
  `;

  writeFileSync(fullPath, template, 'utf8');
  console.log(`\n✅ Created smart data migration template at: ${fullPath}\n`);
}

async function runDataSyncCli(): Promise<void> {
  console.log('\n🚀 [Database CLI] Initializing DataSource for Data Sync...');
  await dataSource.initialize();
  try {
    const evolutionService = new DatabaseEvolutionService(dataSource);
    await evolutionService.onApplicationBootstrap();
    console.log('✅ [Database CLI] Data Sync completed successfully.\n');
  } finally {
    await dataSource.destroy();
  }
}

async function runPruneCli(): Promise<void> {
  await dataSource.initialize();
  try {
    const engine = new SmartMigrationEngine(dataSource, { maxKeepMigrations });
    await engine.pruneOldMigrations();
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

switch (action) {
  case 'evolve': {
    const engine = new SmartMigrationEngine(dataSource, { maxKeepMigrations });
    engine.evolve(migrationName).catch((err) => {
      console.error('❌ Smart DB Evolve failed:', err);
      process.exit(1);
    });
    break;
  }
  case 'prune': {
    runPruneCli().catch((err) => {
      console.error('❌ Migration Prune failed:', err);
      process.exit(1);
    });
    break;
  }
  case 'generate': {
    const targetPath = `${migrationsDir}/${migrationName}`;
    runCommand(`${baseCli} migration:generate "${targetPath}"`);
    const engine = new SmartMigrationEngine(dataSource, { maxKeepMigrations });
    engine.pruneOldMigrations().catch((err) => {
      console.warn('⚠️ Prune warning:', err);
    });
    break;
  }
  case 'create': {
    const targetPath = `${migrationsDir}/${migrationName}`;
    runCommand(`${typeormRunner} migration:create "${targetPath}"`);
    break;
  }
  case 'create:data': {
    createDataMigrationTemplate(migrationName);
    break;
  }
  case 'run': {
    runCommand(`${baseCli} migration:run`);
    const engine = new SmartMigrationEngine(dataSource, { maxKeepMigrations });
    engine.pruneOldMigrations().catch((err) => {
      console.warn('⚠️ Prune warning:', err);
    });
    break;
  }
  case 'revert': {
    runCommand(`${baseCli} migration:revert`);
    break;
  }
  case 'show': {
    runCommand(`${baseCli} migration:show`);
    break;
  }
  case 'log': {
    runCommand(`${baseCli} schema:log`);
    break;
  }
  case 'sync-data': {
    runDataSyncCli().catch((err) => {
      console.error('❌ Data Sync failed:', err);
      process.exit(1);
    });
    break;
  }
  default: {
    console.error(
      '❌ Invalid command. Use: evolve | prune | generate | create | create:data | run | revert | show | log | sync-data',
    );
    process.exit(1);
  }
}
