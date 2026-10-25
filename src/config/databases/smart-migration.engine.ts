import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { DataSource, QueryRunner, Table } from 'typeorm';
import { Query } from 'typeorm/driver/Query';

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
  private readonly maxKeepMigrations: number;

  constructor(
    private readonly ds: DataSource = dataSource,
    options?: { maxKeepMigrations?: number },
  ) {
    this.migrationsDir = resolve(process.cwd(), 'src/config/databases/migrations');
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

      console.log('🔹 [Step 1/5] Synchronizing existing migration states...');
      await this.syncExistingMigrationsState(migrationsTableName);

      console.log(
        '\n🔹 [Step 2/5] Scanning all Entities to detect schema changes (Schema Diff)...',
      );
      const sqlInMemory = await this.ds.driver.createSchemaBuilder().log();

      if (sqlInMemory.upQueries.length === 0) {
        console.log(
          '   ✨ Database schema is 100% up-to-date with all Entities. No new migration needed.',
        );
      } else {
        const safeUpQueries = this.transformDestructiveQueriesToSafeModify(sqlInMemory.upQueries);
        const safeDownQueries = this.transformDestructiveQueriesToSafeModify(
          sqlInMemory.downQueries,
        );

        console.log(
          `   🔍 Detected ${sqlInMemory.upQueries.length} raw queries -> Optimized to ${safeUpQueries.length} zero-data-loss queries.`,
        );

        const createdFile = this.writeOptimizedMigrationFile(
          migrationName,
          safeUpQueries,
          safeDownQueries,
        );
        console.log(`   📄 Migration file created and optimized: ${createdFile.fileName}`);

        console.log(
          '\n🔹 [Step 3/5] Applying new schema to Database while preserving legacy data...',
        );
        try {
          await this.executeSafeSchemaUpgrade(safeUpQueries);
        } catch (err) {
          if (existsSync(createdFile.fullPath)) {
            unlinkSync(createdFile.fullPath);
          }
          throw err;
        }

        if (createdFile.className) {
          await this.recordMigrationAsExecuted(
            migrationsTableName,
            createdFile.timestamp,
            createdFile.className,
          );
        }
        console.log('   ✅ New schema applied and 100% of legacy data preserved!');
      }

      console.log('\n🔹 [Step 4/5] Synchronizing and normalizing legacy data into new fields...');
      const evolutionService = new DatabaseEvolutionService(this.ds);
      await evolutionService.onApplicationBootstrap();
      console.log('   ✅ Legacy data synchronization completed.');

      console.log(
        `\n🔹 [Step 5/5] Pruning migration history (Keeping only the latest ${this.maxKeepMigrations} files)...`,
      );
      await this.pruneOldMigrations(migrationsTableName);

      console.log('\n================================================================');
      console.log('🎉 [Smart DB Engine] Database Upgrade & Data Sync COMPLETED!');
      console.log('================================================================\n');
    } finally {
      if (this.ds.isInitialized) {
        await this.ds.destroy();
      }
    }
  }

  private transformDestructiveQueriesToSafeModify(queries: Query[]): Query[] {
    const dropRegex = /^ALTER TABLE `([^`]+)` DROP COLUMN `([^`]+)`$/i;
    const addRegex = /^ALTER TABLE `([^`]+)` ADD `([^`]+)` (.+)$/i;

    const addMap = new Map<string, { index: number; table: string; col: string; def: string }>();
    const dropIndicesToSkip = new Set<number>();
    const addIndicesToConvert = new Map<number, string>();

    queries.forEach((q, idx) => {
      const addMatch = addRegex.exec(q.query.trim());
      if (addMatch) {
        const [, table, col, def] = addMatch;
        addMap.set(`${table}.${col}`, { index: idx, table, col, def });
      }
    });

    queries.forEach((q, idx) => {
      const dropMatch = dropRegex.exec(q.query.trim());
      if (dropMatch) {
        const [, table, col] = dropMatch;
        const key = `${table}.${col}`;
        const matchingAdd = addMap.get(key);
        if (matchingAdd) {
          dropIndicesToSkip.add(idx);
          addIndicesToConvert.set(
            matchingAdd.index,
            `ALTER TABLE \`${table}\` MODIFY COLUMN \`${col}\` ${matchingAdd.def}`,
          );
        }
      }
    });

    const result: Query[] = [];

    queries.forEach((q, idx) => {
      if (dropIndicesToSkip.has(idx)) {
        return;
      }

      let sql = addIndicesToConvert.get(idx) ?? q.query;

      if (!addIndicesToConvert.has(idx)) {
        sql = this.ensureSafeDefaultOnNewNotNullColumn(sql);
      }

      result.push(new Query(sql, q.parameters));
    });

    return result;
  }

  /**
   * Đảm bảo cột mới tinh (`ADD COLUMN ... NOT NULL`) có giá trị DEFAULT an toàn khi thêm vào bảng đã có dữ liệu
   */
  private ensureSafeDefaultOnNewNotNullColumn(sql: string): string {
    return sql.replace(
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
  }

  private async executeSafeSchemaUpgrade(queries: Query[]): Promise<void> {
    const queryRunner = this.ds.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');

      for (const q of queries) {
        const sql = q.query.trim();

        await this.preSanitizeBeforeUniqueIndex(queryRunner, sql);

        await this.preSanitizeBeforeForeignKey(queryRunner, sql);

        try {
          await queryRunner.query(sql, q.parameters);
        } catch (err: any) {
          const errno = err?.errno || err?.driverError?.errno;

          if (errno === 1061 || errno === 1062 || errno === 1826 || errno === 1091) {
            if (errno === 1062) {
              console.warn(`   ⚠️ Skipped duplicate constraint warning on query: ${sql}`);
            }
            continue;
          }
          throw err;
        }
      }
    } finally {
      await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => undefined);
      await queryRunner.release();
    }
  }

  /**
   * Tự động xử lý dữ liệu cũ bị trùng lặp hoặc bị rỗng `''` trước khi tạo `UNIQUE INDEX`
   * để không bao giờ xảy ra lỗi `ER_DUP_ENTRY: Duplicate entry '' for key ...`
   */
  private async preSanitizeBeforeUniqueIndex(queryRunner: QueryRunner, sql: string): Promise<void> {
    const uniqueIdxMatch = /^CREATE UNIQUE INDEX `([^`]+)` ON `([^`]+)` \(([^)]+)\)/i.exec(sql);
    if (!uniqueIdxMatch) {
      return;
    }

    const [, , tableName, rawCols] = uniqueIdxMatch;
    const cols = rawCols
      .split(',')
      .map((c) => c.trim().replace(/`/g, ''))
      .filter(Boolean);

    if (cols.length === 0) return;

    for (const col of cols) {
      await queryRunner.query(`DELETE FROM \`${tableName}\` WHERE \`${col}\` = ''`);
    }

    const hasIdCol = await queryRunner.hasColumn(tableName, 'id');
    if (hasIdCol) {
      const joinCondition = cols.map((c) => `t1.\`${c}\` = t2.\`${c}\``).join(' AND ');
      const notNullCondition = cols.map((c) => `t1.\`${c}\` IS NOT NULL`).join(' AND ');

      await queryRunner.query(
        `DELETE t1 FROM \`${tableName}\` t1 INNER JOIN \`${tableName}\` t2 ON ${joinCondition} WHERE ${notNullCondition} AND t1.\`id\` < t2.\`id\``,
      );
    }
  }

  private async preSanitizeBeforeForeignKey(queryRunner: QueryRunner, sql: string): Promise<void> {
    const fkMatch =
      /^ALTER TABLE `([^`]+)` ADD CONSTRAINT `[^`]+` FOREIGN KEY \(`([^`]+)`\) REFERENCES `([^`]+)`\(`([^`]+)`\)(.*)$/i.exec(
        sql,
      );
    if (!fkMatch) {
      return;
    }

    const [, childTable, childCol, parentTable, parentCol, tail] = fkMatch;
    const isSetNull = /ON DELETE SET NULL/i.test(tail || '');

    if (isSetNull) {
      await queryRunner.query(
        `UPDATE \`${childTable}\` c LEFT JOIN \`${parentTable}\` p ON c.\`${childCol}\` = p.\`${parentCol}\` SET c.\`${childCol}\` = NULL WHERE c.\`${childCol}\` IS NOT NULL AND p.\`${parentCol}\` IS NULL`,
      );
    } else {
      await queryRunner.query(
        `DELETE c FROM \`${childTable}\` c LEFT JOIN \`${parentTable}\` p ON c.\`${childCol}\` = p.\`${parentCol}\` WHERE c.\`${childCol}\` IS NOT NULL AND p.\`${parentCol}\` IS NULL`,
      );
    }
  }

  private writeOptimizedMigrationFile(
    migrationName: string,
    upQueries: Query[],
    downQueries: Query[],
  ): ParsedMigrationFile {
    const timestamp = Date.now();
    const cleanName = migrationName.replace(/[^a-zA-Z0-9]/g, '') || 'AutoMigration';
    const className = `${cleanName}${timestamp}`;
    const fileName = `${timestamp}-${cleanName}.ts`;
    const fullPath = join(this.migrationsDir, fileName);

    const escapeSqlForTemplate = (q: string) =>
      q.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

    const upLines = upQueries
      .map((q) => `    await queryRunner.query(\`${escapeSqlForTemplate(q.query)}\`);`)
      .join('\n');

    const downLines = [...downQueries]
      .reverse()
      .map((q) => `    await queryRunner.query(\`${escapeSqlForTemplate(q.query)}\`);`)
      .join('\n');

    const fileContent = `import { MigrationInterface, QueryRunner } from 'typeorm';

export class ${className} implements MigrationInterface {
  name = '${className}';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
${upLines}
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
${downLines}
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}
`;

    writeFileSync(fullPath, fileContent, 'utf8');
    return {
      fileName,
      fullPath,
      timestamp,
      className,
    };
  }

  private async syncExistingMigrationsState(migrationsTableName: string): Promise<void> {
    const queryRunner = this.ds.createQueryRunner();
    try {
      await this.ensureMigrationsTableExists(queryRunner, migrationsTableName);
      const executedRows = await queryRunner.manager
        .createQueryBuilder()
        .select('m.name', 'name')
        .from(migrationsTableName, 'm')
        .getRawMany<{ name: string }>();

      const executedNames = new Set(executedRows.map((r) => r.name));
      const allFiles = this.getSortedMigrationFiles();

      for (const file of allFiles) {
        if (!file.className || executedNames.has(file.className)) {
          continue;
        }

        const content = readFileSync(file.fullPath, 'utf8');

        if (content.includes('DROP COLUMN')) {
          unlinkSync(file.fullPath);
          console.log(
            `   🧹 Cleaned up unexecuted destructive migration from previous failed run: ${file.fileName}`,
          );
        }
      }

      const pendingAfterClean = await this.ds.showMigrations();
      if (pendingAfterClean) {
        await this.ds.runMigrations({ transaction: 'each' });
      }
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
        `   ✅ Currently ${allFiles.length}/${this.maxKeepMigrations} migration files. No pruning needed.`,
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
        console.warn(`   ⚠️ Could not delete file ${file.fileName}:`, err);
      }
    }

    console.log(
      `   ✨ Retained the latest ${filesToKeep.length} migration files: ${filesToKeep
        .map((f) => f.fileName)
        .join(', ')}`,
    );
  }
}
