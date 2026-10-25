import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { DataSource, QueryRunner, Table } from 'typeorm';

import { DatabaseEvolutionService } from './database-evolution.service';
import dataSource from './db-datasource';

export interface SmartEvolveOptions {
  migrationName?: string;
  maxKeepMigrations?: number;
}

interface ParsedMigrationFile {
  fileName: string;
  fullPath: string;
  timestamp: number;
  className: string | null;
}

export class SmartMigrationEngine {
  private readonly migrationsDir: string;
  private readonly dataSourcePath: string;
  private readonly typeormCliPath: string;
  private readonly maxKeepMigrations: number;

  constructor(
    private readonly ds: DataSource = dataSource,
    options?: { maxKeepMigrations?: number },
  ) {
    this.migrationsDir = resolve(process.cwd(), 'src/config/databases/migrations');
    this.dataSourcePath = resolve(__dirname, 'db-datasource.ts');
    this.typeormCliPath = resolve(process.cwd(), 'node_modules/typeorm/cli.js');
    this.maxKeepMigrations = options?.maxKeepMigrations ?? 5;

    if (!existsSync(this.migrationsDir)) {
      mkdirSync(this.migrationsDir, { recursive: true });
    }
  }

  async evolve(migrationName: string = 'AutoMigration'): Promise<void> {
    console.log('\n================================================================');
    console.log('🚀 [Smart DB Engine] Starting the automatic database upgrade process');
    console.log('================================================================\n');

    if (!this.ds.isInitialized) {
      await this.ds.initialize();
    }

    try {
      const migrationsTableName = this.ds.options.migrationsTableName || 'typeorm_migrations';

      console.log('🔹 [Step 1/5] Checking and executing pending migrations...');
      const pendingBefore = await this.ds.showMigrations();
      if (pendingBefore) {
        await this.ds.runMigrations({ transaction: 'each' });
        console.log('   ✅ Pending migrations applied successfully.');
      } else {
        console.log('   ✅ No pending migrations found.');
      }

      console.log(
        '\n🔹 [Step 2/5] Scanning all Entities to detect schema changes (Schema Diff)...',
      );
      const sqlInMemory = await this.ds.driver.createSchemaBuilder().log();

      if (sqlInMemory.upQueries.length === 0) {
        console.log(
          '   ✨ Current database schema matches 100% with Entities. No new migration file needed.',
        );
      } else {
        console.log(`   🔍 Detected ${sqlInMemory.upQueries.length} schema change queries.`);

        const cleanName = migrationName.replace(/[^a-zA-Z0-9]/g, '') || 'AutoMigration';
        const targetPath = `src/config/databases/migrations/${cleanName}`;
        const cmd = `npx ts-node -r tsconfig-paths/register "${this.typeormCliPath}" -d "${this.dataSourcePath}" migration:generate "${targetPath}"`;

        console.log(`   🛠️  Automatically generating new migration file...`);
        execSync(cmd, { stdio: 'inherit' });

        const newestFile = this.getSortedMigrationFiles().at(-1);
        if (newestFile) {
          this.enhanceGeneratedMigrationForLegacyData(newestFile.fullPath);
          console.log(`   📄 Migration file created and optimized: ${newestFile.fileName}`);
        }

        console.log(
          '\n🔹 [Step 3/5] Applying new schema to Database while preserving legacy data...',
        );
        await this.executeRawUpQueriesSafely(sqlInMemory.upQueries.map((q) => q.query));

        if (newestFile && newestFile.className) {
          await this.recordMigrationAsExecuted(
            migrationsTableName,
            newestFile.timestamp,
            newestFile.className,
          );
        }
        console.log('   ✅ New schema applied and legacy data preserved successfully!');
      }

      console.log('\n🔹 [Step 4/5] Synchronizing and normalizing legacy data into new fields...');
      const evolutionService = new DatabaseEvolutionService(this.ds);
      await evolutionService.onApplicationBootstrap();
      console.log('   ✅ Legacy data synchronization completed.');

      console.log(
        `\n🔹 [Step 5/5] Cleaning up migration history (Keeping only the latest ${this.maxKeepMigrations} files)...`,
      );
      await this.pruneOldMigrations(migrationsTableName);

      console.log('\n================================================================');
      console.log('🎉 [Smart DB Engine] Database Upgrade & Data Synchronization COMPLETED!');
      console.log('================================================================\n');
    } finally {
      if (this.ds.isInitialized) {
        await this.ds.destroy();
      }
    }
  }

  private enhanceGeneratedMigrationForLegacyData(filePath: string): void {
    if (!existsSync(filePath)) return;
    const content = readFileSync(filePath, 'utf8');

    const enhanced = content.replace(
      /ALTER TABLE `([^`]+)` ADD `([^`]+)` (varchar\(\d+\)|int|smallint|tinyint|bigint|datetime|timestamp|text|json) NOT NULL(?! DEFAULT)/gi,
      (fullMatch, table: string, col: string, colType: string) => {
        const lowerType = colType.toLowerCase();
        if (lowerType.startsWith('varchar')) {
          return `ALTER TABLE \`${table}\` ADD \`${col}\` ${colType} NOT NULL DEFAULT ''`;
        }
        if (
          lowerType.includes('int') ||
          lowerType === 'decimal' ||
          lowerType === 'double' ||
          lowerType === 'float'
        ) {
          return `ALTER TABLE \`${table}\` ADD \`${col}\` ${colType} NOT NULL DEFAULT 0`;
        }
        if (lowerType === 'datetime' || lowerType === 'timestamp') {
          return `ALTER TABLE \`${table}\` ADD \`${col}\` ${colType} NOT NULL DEFAULT CURRENT_TIMESTAMP`;
        }
        return fullMatch;
      },
    );

    if (enhanced !== content) {
      writeFileSync(filePath, enhanced, 'utf8');
    }
  }

  private async executeRawUpQueriesSafely(queries: string[]): Promise<void> {
    const queryRunner: QueryRunner = this.ds.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      for (const rawQuery of queries) {
        const safeQuery = rawQuery.replace(
          /ALTER TABLE `([^`]+)` ADD `([^`]+)` (varchar\(\d+\)|int|smallint|tinyint|bigint|datetime|timestamp) NOT NULL(?! DEFAULT)/i,
          (fullMatch, table: string, col: string, colType: string) => {
            const lowerType = colType.toLowerCase();
            if (lowerType.startsWith('varchar')) {
              return `ALTER TABLE \`${table}\` ADD \`${col}\` ${colType} NOT NULL DEFAULT ''`;
            }
            if (lowerType.includes('int')) {
              return `ALTER TABLE \`${table}\` ADD \`${col}\` ${colType} NOT NULL DEFAULT 0`;
            }
            if (lowerType === 'datetime' || lowerType === 'timestamp') {
              return `ALTER TABLE \`${table}\` ADD \`${col}\` ${colType} NOT NULL DEFAULT CURRENT_TIMESTAMP`;
            }
            return fullMatch;
          },
        );
        await queryRunner.query(safeQuery);
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async ensureMigrationsTableExists(
    queryRunner: QueryRunner,
    migrationsTableName: string,
  ): Promise<void> {
    const hasTable = await queryRunner.hasTable(migrationsTableName);
    if (hasTable) {
      return;
    }

    await queryRunner.createTable(
      new Table({
        name: migrationsTableName,
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'timestamp',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'name',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
        ],
      }),
      true,
    );
  }

  private async recordMigrationAsExecuted(
    migrationsTableName: string,
    timestamp: number,
    className: string,
  ): Promise<void> {
    const queryRunner = this.ds.createQueryRunner();
    try {
      await this.ensureMigrationsTableExists(queryRunner, migrationsTableName);
      const existing = await queryRunner.manager
        .createQueryBuilder()
        .select('m.name', 'name')
        .from(migrationsTableName, 'm')
        .where('m.name = :name', { name: className })
        .getRawOne<{ name: string }>();

      if (!existing) {
        await queryRunner.manager
          .createQueryBuilder()
          .insert()
          .into(migrationsTableName)
          .values({
            timestamp,
            name: className,
          })
          .execute();
      }
    } finally {
      await queryRunner.release();
    }
  }

  public getSortedMigrationFiles(): ParsedMigrationFile[] {
    if (!existsSync(this.migrationsDir)) return [];

    const files = readdirSync(this.migrationsDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.d.ts'),
    );

    const parsed: ParsedMigrationFile[] = files.map((fileName) => {
      const fullPath = join(this.migrationsDir, fileName);
      const matchTs = /^(\d+)-/.exec(fileName);
      const timestamp = matchTs ? Number(matchTs[1]) : 0;

      let className: string | null = null;
      try {
        const content = readFileSync(fullPath, 'utf8');
        const classMatch =
          /export\s+class\s+([A-Za-z0-9_]+)\s+implements\s+MigrationInterface/.exec(content);
        if (classMatch) {
          className = classMatch[1];
        }
      } catch {
        className = null;
      }

      return {
        fileName,
        fullPath,
        timestamp,
        className,
      };
    });

    return parsed.sort((a, b) => a.timestamp - b.timestamp);
  }

  public async pruneOldMigrations(
    migrationsTableName: string = 'typeorm_migrations',
  ): Promise<void> {
    const allFiles = this.getSortedMigrationFiles();

    if (allFiles.length <= this.maxKeepMigrations) {
      console.log(
        `   ✅ Currently have ${allFiles.length}/${this.maxKeepMigrations} migration files. No cleanup needed.`,
      );
      return;
    }

    const filesToDelete = allFiles.slice(0, allFiles.length - this.maxKeepMigrations);
    const filesToKeep = allFiles.slice(-this.maxKeepMigrations);

    for (const file of filesToDelete) {
      try {
        unlinkSync(file.fullPath);
        console.log(`   🗑️  Deleted old migration file: ${file.fileName}`);

        if (this.ds.isInitialized && file.className) {
          await this.ds.manager
            .createQueryBuilder()
            .delete()
            .from(migrationsTableName)
            .where('name = :name', { name: file.className })
            .execute();
        }
      } catch (err) {
        console.warn(`   ⚠️ Failed to delete file ${file.fileName}:`, err);
      }
    }

    console.log(
      `   ✨ Kept the latest ${filesToKeep.length} migration files: ${filesToKeep
        .map((f) => f.fileName)
        .join(', ')}`,
    );
  }
}
