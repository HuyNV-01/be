import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

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

/**
 * Thực thi TypeORM CLI trực tiếp qua Node (`process.execPath`) với `ts-node/register/transpile-only`
 * để tránh spawn lồng `npx -> ts-node -> cmd.exe` gây tràn V8 Zone Allocation trên Windows.
 */
function runTypeormCli(typeormArgs: string[], includeDataSource: boolean = true): void {
  const tsNodeRegister = require.resolve('ts-node/register/transpile-only');
  const tsconfigPathsRegister = require.resolve('tsconfig-paths/register');

  const nodeArgs: string[] = [
    '--max-old-space-size=4096',
    '-r',
    tsNodeRegister,
    '-r',
    tsconfigPathsRegister,
    typeormCliPath,
  ];

  if (includeDataSource) {
    nodeArgs.push('-d', dataSourcePath);
  }

  nodeArgs.push(...typeormArgs);

  console.log(`\n🚀 [Database CLI] Executing: node ${typeormArgs.join(' ')}\n`);

  const result = spawnSync(process.execPath, nodeArgs, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: {
      ...process.env,
      TS_NODE_TRANSPILE_ONLY: '1',
      TS_NODE_FILES: 'false',
      TS_NODE_LOG_ERROR: 'true',
    },
  });

  if (result.error) {
    console.error('❌ [Database CLI] Spawn failed:', result.error);
    process.exit(1);
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
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
  const [{ default: dataSource }, { DatabaseEvolutionService }] = await Promise.all([
    import('./db-datasource'),
    import('./database-evolution.service'),
  ]);

  await dataSource.initialize();
  try {
    const evolutionService = new DatabaseEvolutionService(dataSource);
    await evolutionService.onApplicationBootstrap();
    console.log('✅ [Database CLI] Data Sync completed successfully.\n');
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

async function runPruneCli(initializeDataSource: boolean = true): Promise<void> {
  const [{ default: dataSource }, { SmartMigrationEngine }] = await Promise.all([
    import('./db-datasource'),
    import('./smart-migration.engine'),
  ]);

  if (initializeDataSource && !dataSource.isInitialized) {
    await dataSource.initialize();
  }

  try {
    const engine = new SmartMigrationEngine(dataSource, { maxKeepMigrations });
    await engine.pruneOldMigrations();
  } finally {
    if (initializeDataSource && dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

async function runEvolveCli(): Promise<void> {
  const [{ default: dataSource }, { SmartMigrationEngine }] = await Promise.all([
    import('./db-datasource'),
    import('./smart-migration.engine'),
  ]);

  const engine = new SmartMigrationEngine(dataSource, { maxKeepMigrations });
  await engine.evolve(migrationName);
}

async function main(): Promise<void> {
  switch (action) {
    case 'evolve': {
      await runEvolveCli();
      break;
    }
    case 'prune': {
      await runPruneCli(true);
      break;
    }
    case 'generate': {
      const targetPath = `${migrationsDir}/${migrationName}`;
      runTypeormCli(['migration:generate', targetPath], true);
      await runPruneCli(false).catch((err) => {
        console.warn('⚠️ Prune warning:', err);
      });
      break;
    }
    case 'create': {
      const targetPath = `${migrationsDir}/${migrationName}`;
      runTypeormCli(['migration:create', targetPath], false);
      break;
    }
    case 'create:data': {
      createDataMigrationTemplate(migrationName);
      break;
    }
    case 'run': {
      runTypeormCli(['migration:run'], true);
      await runPruneCli(false).catch((err) => {
        console.warn('⚠️ Prune warning:', err);
      });
      break;
    }
    case 'revert': {
      runTypeormCli(['migration:revert'], true);
      break;
    }
    case 'show': {
      runTypeormCli(['migration:show'], true);
      break;
    }
    case 'log': {
      runTypeormCli(['schema:log'], true);
      break;
    }
    case 'sync-data': {
      await runDataSyncCli();
      break;
    }
    default: {
      console.error(
        '❌ Invalid command. Use: evolve | prune | generate | create | create:data | run | revert | show | log | sync-data',
      );
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('❌ [Database CLI] Unexpected error:', err);
  process.exit(1);
});
