import { execSync } from 'child_process';
import { resolve } from 'path';

type MigrationAction = 'generate' | 'create' | 'run' | 'revert' | 'show' | 'log';

const action = process.argv[2] as MigrationAction | undefined;
const rawNameArg = process.argv
  .slice(3)
  .find((arg) => !arg.startsWith('-'))
  ?.replace(/^name=/i, '');

const migrationName = rawNameArg || process.env.npm_config_name || 'AutoMigration';

const dataSourcePath = resolve(__dirname, 'db-datasource.ts');
const typeormCliPath = resolve(process.cwd(), 'node_modules/typeorm/cli.js');
const migrationsDir = 'src/config/databases/migrations';

const typeormRunner = `npx ts-node -r tsconfig-paths/register "${typeormCliPath}"`;
const baseCli = `${typeormRunner} -d "${dataSourcePath}"`;

function runCommand(cmd: string): void {
  console.log(`\n🚀 [Database CLI] Executing: ${cmd}\n`);
  execSync(cmd, { stdio: 'inherit' });
}

switch (action) {
  case 'generate': {
    const targetPath = `${migrationsDir}/${migrationName}`;
    runCommand(`${baseCli} migration:generate "${targetPath}"`);
    break;
  }
  case 'create': {
    const targetPath = `${migrationsDir}/${migrationName}`;
    runCommand(`${typeormRunner} migration:create "${targetPath}"`);
    break;
  }
  case 'run': {
    runCommand(`${baseCli} migration:run`);
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
  default: {
    console.error('❌ Invalid command. Use: generate | create | run | revert | show | log');
    process.exit(1);
  }
}
