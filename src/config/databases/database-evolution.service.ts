import { Injectable, Logger, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';

import {
  DataSource,
  EntityMetadata,
  QueryRunner,
  Table,
  TableColumn,
  TableIndex,
  ValueTransformer,
} from 'typeorm';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';

interface DbColumnInfoRow {
  columnName: string;
  dataType: string;
  columnType: string;
  isNullable: string;
  columnDefault: string | null;
  characterMaximumLength?: number | string | null;
}

@Injectable()
export class DatabaseEvolutionService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(DatabaseEvolutionService.name, { timestamp: true });
  private readonly PARTITIONED_TABLES = new Set([
    'messages',
    'call_participants',
    'channel_webhook_logs',
    'security_audit_logs',
  ]);

  private schemaReady = false;
  private evolutionPromise: Promise<void> | null = null;

  constructor(private readonly dataSource: DataSource) {}

  public isReady(): boolean {
    return this.schemaReady;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureSchemaAndDataEvolved();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureSchemaAndDataEvolved();
  }

  public async ensureSchemaAndDataEvolved(): Promise<void> {
    if (this.schemaReady) {
      return;
    }
    if (this.evolutionPromise) {
      return this.evolutionPromise;
    }

    this.evolutionPromise = (async () => {
      try {
        if (process.env.DB_AUTO_SCHEMA_SYNC !== 'false') {
          await this.synchronizeMissingTablesColumnsAndEnums();
        }
        if (process.env.DB_AUTO_DATA_SYNC !== 'false') {
          await this.autoSynchronizeAllEntitiesData();
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[DatabaseEvolution] Evolution warning: ${msg}`);
      } finally {
        this.schemaReady = true;
      }
    })();

    return this.evolutionPromise;
  }

  public async synchronizeMissingTablesColumnsAndEnums(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      for (const entityMeta of this.dataSource.entityMetadatas) {
        const tableName = entityMeta.tableName;
        const hasTable = await queryRunner.hasTable(tableName);

        if (!hasTable) {
          await this.createMissingEntityTable(queryRunner, entityMeta);
          continue;
        }

        await this.addMissingColumnsAndUpdateEnums(queryRunner, entityMeta);
        await this.createMissingEntityIndices(queryRunner, entityMeta);
      }
    } finally {
      await queryRunner.release();
    }
  }

  private async createMissingEntityTable(
    queryRunner: QueryRunner,
    entityMeta: EntityMetadata,
  ): Promise<void> {
    const tableName = entityMeta.tableName;
    try {
      const columns = entityMeta.columns.map((col) => this.buildTableColumnOptions(col));
      const table = new Table({
        name: tableName,
        columns,
      });
      await queryRunner.createTable(table, true, false, false);
      this.logger.log(`[DatabaseEvolution] Created missing table "${tableName}".`);
      await this.createMissingEntityIndices(queryRunner, entityMeta);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[DatabaseEvolution] Could not create table "${tableName}": ${msg}`);
    }
  }

  private async addMissingColumnsAndUpdateEnums(
    queryRunner: QueryRunner,
    entityMeta: EntityMetadata,
  ): Promise<void> {
    const tableName = entityMeta.tableName;

    const existingRows: DbColumnInfoRow[] = await queryRunner.query(
      `
      SELECT
        COLUMN_NAME AS columnName,
        DATA_TYPE AS dataType,
        COLUMN_TYPE AS columnType,
        IS_NULLABLE AS isNullable,
        COLUMN_DEFAULT AS columnDefault,
        CHARACTER_MAXIMUM_LENGTH AS characterMaximumLength
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      `,
      [tableName],
    );

    const existingColMap = new Map<string, DbColumnInfoRow>();
    for (const row of existingRows) {
      existingColMap.set(row.columnName.toLowerCase(), row);
    }

    for (const col of entityMeta.columns) {
      const dbColName = col.databaseName;
      const existingCol = existingColMap.get(dbColName.toLowerCase());

      if (!existingCol) {
        await this.addSingleMissingColumnSql(queryRunner, tableName, col);
        continue;
      }

      if (col.type === 'enum' && Array.isArray(col.enum) && col.enum.length > 0) {
        const currentColumnType = existingCol.columnType || '';
        const missingEnumVal = col.enum.some(
          (val) => !currentColumnType.includes(`'${String(val)}'`),
        );
        if (missingEnumVal) {
          await this.modifyEnumColumnSql(queryRunner, tableName, col);
        }
        continue;
      }

      await this.upgradeColumnTypeOrLengthIfNeeded(queryRunner, tableName, col, existingCol);
    }
  }

  private async upgradeColumnTypeOrLengthIfNeeded(
    queryRunner: QueryRunner,
    tableName: string,
    col: ColumnMetadata,
    existingCol: DbColumnInfoRow,
  ): Promise<void> {
    if (col.isPrimary) {
      return;
    }

    const desiredRawType = typeof col.type === 'string' ? col.type.toLowerCase() : 'varchar';
    const currentDataType = (existingCol.dataType || '').toLowerCase();
    const dbColName = col.databaseName;

    const isDesiredText =
      desiredRawType === 'text' || desiredRawType === 'mediumtext' || desiredRawType === 'longtext';
    if (isDesiredText && (currentDataType === 'varchar' || currentDataType === 'tinytext')) {
      try {
        const colDefSql = this.buildMySqlColumnDefinition(col);
        await queryRunner.query(
          `ALTER TABLE \`${tableName}\` MODIFY COLUMN \`${dbColName}\` ${colDefSql}`,
        );
        this.logger.log(
          `[DatabaseEvolution] Upgraded column "${tableName}.${dbColName}" from ${existingCol.columnType} to ${desiredRawType.toUpperCase()} to prevent string truncation.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[DatabaseEvolution] Could not widen column "${tableName}.${dbColName}" to TEXT: ${msg}`,
        );
      }
      return;
    }

    if (
      (desiredRawType === 'varchar' || desiredRawType === 'character varying') &&
      currentDataType === 'varchar' &&
      col.length
    ) {
      const desiredLen = Number(col.length);
      const currentLen = Number(existingCol.characterMaximumLength || 0);
      if (desiredLen > 0 && currentLen > 0 && desiredLen > currentLen) {
        try {
          const colDefSql = this.buildMySqlColumnDefinition(col);
          await queryRunner.query(
            `ALTER TABLE \`${tableName}\` MODIFY COLUMN \`${dbColName}\` ${colDefSql}`,
          );
          this.logger.log(
            `[DatabaseEvolution] Widened column "${tableName}.${dbColName}" from varchar(${currentLen}) to varchar(${desiredLen}).`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `[DatabaseEvolution] Could not widen varchar column "${tableName}.${dbColName}": ${msg}`,
          );
        }
      }
    }
  }

  private async addSingleMissingColumnSql(
    queryRunner: QueryRunner,
    tableName: string,
    col: ColumnMetadata,
  ): Promise<void> {
    const dbColName = col.databaseName;
    try {
      const colDefSql = this.buildMySqlColumnDefinition(col);
      await queryRunner.query(
        `ALTER TABLE \`${tableName}\` ADD COLUMN \`${dbColName}\` ${colDefSql}`,
      );
      this.logger.log(
        `[DatabaseEvolution] Added missing column "${tableName}.${dbColName}" automatically.`,
      );
    } catch (err: any) {
      const errno = err?.errno || err?.driverError?.errno;
      if (errno === 1060) {
        return;
      }
      try {
        await queryRunner.addColumn(tableName, new TableColumn(this.buildTableColumnOptions(col)));
        this.logger.log(
          `[DatabaseEvolution] Added missing column "${tableName}.${dbColName}" via TableColumn.`,
        );
      } catch (innerErr) {
        const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
        this.logger.warn(
          `[DatabaseEvolution] Failed adding column "${tableName}.${dbColName}": ${msg}`,
        );
      }
    }
  }

  private async modifyEnumColumnSql(
    queryRunner: QueryRunner,
    tableName: string,
    col: ColumnMetadata,
  ): Promise<void> {
    const dbColName = col.databaseName;
    try {
      const colDefSql = this.buildMySqlColumnDefinition(col);
      await queryRunner.query(
        `ALTER TABLE \`${tableName}\` MODIFY COLUMN \`${dbColName}\` ${colDefSql}`,
      );
      this.logger.log(`[DatabaseEvolution] Updated enum values on "${tableName}.${dbColName}".`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[DatabaseEvolution] Failed updating enum "${tableName}.${dbColName}": ${msg}`,
      );
    }
  }

  private buildMySqlColumnDefinition(col: ColumnMetadata): string {
    const rawType = typeof col.type === 'string' ? col.type.toLowerCase() : 'varchar';
    const staticDefault = this.resolveStaticDefaultValue(col);

    let sqlType = 'varchar(255)';
    if (rawType === 'varchar' || rawType === 'character varying') {
      const len = col.length ? Number(col.length) : 255;
      sqlType = `varchar(${len})`;
    } else if (rawType === 'text' || rawType === 'longtext' || rawType === 'mediumtext') {
      sqlType = rawType;
    } else if (rawType === 'boolean' || rawType === 'bool' || rawType === 'tinyint') {
      sqlType = 'tinyint(1)';
    } else if (rawType === 'int' || rawType === 'integer') {
      sqlType = 'int';
    } else if (rawType === 'smallint') {
      sqlType = 'smallint';
    } else if (rawType === 'bigint') {
      sqlType = 'bigint';
    } else if (rawType === 'decimal' || rawType === 'numeric') {
      const precision = col.precision ?? 10;
      const scale = col.scale ?? 2;
      sqlType = `decimal(${precision},${scale})`;
    } else if (rawType === 'datetime') {
      sqlType = col.precision ? `datetime(${col.precision})` : 'datetime';
    } else if (rawType === 'timestamp') {
      sqlType = col.precision ? `timestamp(${col.precision})` : 'timestamp';
    } else if (rawType === 'json') {
      sqlType = 'json';
    } else if (rawType === 'enum' && Array.isArray(col.enum) && col.enum.length > 0) {
      const enumVals = col.enum.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ');
      sqlType = `enum(${enumVals})`;
    }

    if (rawType === 'json' || rawType === 'text' || rawType === 'longtext') {
      return `${sqlType} NULL`;
    }

    const isNullable = Boolean(col.isNullable);
    let defaultClause = '';

    if (staticDefault !== undefined && staticDefault !== null) {
      if (typeof staticDefault === 'boolean') {
        defaultClause = ` DEFAULT ${staticDefault ? 1 : 0}`;
      } else if (typeof staticDefault === 'number') {
        defaultClause = ` DEFAULT ${staticDefault}`;
      } else if (typeof staticDefault === 'string') {
        defaultClause = ` DEFAULT '${staticDefault.replace(/'/g, "''")}'`;
      }
    } else if (isNullable) {
      defaultClause = ' DEFAULT NULL';
    } else {
      if (sqlType.startsWith('varchar')) {
        defaultClause = " DEFAULT ''";
      } else if (sqlType.includes('int') || sqlType.startsWith('decimal')) {
        defaultClause = ' DEFAULT 0';
      } else if (sqlType.startsWith('enum') && Array.isArray(col.enum) && col.enum.length > 0) {
        defaultClause = ` DEFAULT '${String(col.enum[0]).replace(/'/g, "''")}'`;
      }
    }

    return `${sqlType} ${isNullable ? 'NULL' : 'NOT NULL'}${defaultClause}`;
  }

  private buildTableColumnOptions(col: ColumnMetadata) {
    const rawType = typeof col.type === 'string' ? col.type.toLowerCase() : 'varchar';
    const staticDefault = this.resolveStaticDefaultValue(col);
    const isJsonOrText = rawType === 'json' || rawType === 'text' || rawType === 'longtext';

    let formattedDefault: any = undefined;
    if (!isJsonOrText && staticDefault !== undefined && staticDefault !== null) {
      if (typeof staticDefault === 'boolean') {
        formattedDefault = staticDefault ? 1 : 0;
      } else if (typeof staticDefault === 'number') {
        formattedDefault = staticDefault;
      } else if (typeof staticDefault === 'string') {
        formattedDefault = `'${staticDefault.replace(/'/g, "''")}'`;
      }
    } else if (col.isCreateDate || col.isUpdateDate) {
      formattedDefault = 'CURRENT_TIMESTAMP(6)';
    }

    return {
      name: col.databaseName,
      type: rawType === 'boolean' ? 'tinyint' : rawType,
      length: col.length ? String(col.length) : rawType === 'uuid' ? '36' : undefined,
      precision: col.precision,
      scale: col.scale,
      enum: Array.isArray(col.enum) ? col.enum.map(String) : undefined,
      isPrimary: col.isPrimary,
      isNullable: isJsonOrText ? true : Boolean(col.isNullable),
      default: formattedDefault,
    };
  }

  private async createMissingEntityIndices(
    queryRunner: QueryRunner,
    entityMeta: EntityMetadata,
  ): Promise<void> {
    const tableName = entityMeta.tableName;
    const isPartitioned = this.PARTITIONED_TABLES.has(tableName);

    const existingStatRows: Array<{ indexName: string }> = await queryRunner.query(
      `
      SELECT DISTINCT INDEX_NAME AS indexName
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      `,
      [tableName],
    );

    const existingIdxNames = new Set(existingStatRows.map((r) => r.indexName.toLowerCase()));

    for (const idx of entityMeta.indices) {
      if (!idx.name || existingIdxNames.has(idx.name.toLowerCase())) {
        continue;
      }

      const colNames = idx.columns.map((c) => c.databaseName).filter(Boolean);
      if (colNames.length === 0) continue;

      const canBeUnique =
        Boolean(idx.isUnique) && (!isPartitioned || colNames.includes('created_at'));

      try {
        await queryRunner.createIndex(
          tableName,
          new TableIndex({
            name: idx.name,
            columnNames: colNames,
            isUnique: canBeUnique,
          }),
        );
        existingIdxNames.add(idx.name.toLowerCase());
      } catch {
        // Ignore duplicate index errors
      }
    }
  }

  public async autoSynchronizeAllEntitiesData(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      for (const entityMeta of this.dataSource.entityMetadatas) {
        const tableName = entityMeta.tableName;
        const hasTable = await queryRunner.hasTable(tableName);
        if (!hasTable) {
          continue;
        }

        await this.syncMissingDefaultsAndJsonColumns(entityMeta);
        await this.syncColumnTransformers(entityMeta);
      }
    } finally {
      await queryRunner.release();
    }
  }

  private async syncMissingDefaultsAndJsonColumns(entityMeta: EntityMetadata): Promise<void> {
    const tableName = entityMeta.tableName;

    for (const col of entityMeta.columns) {
      if (col.isPrimary || col.isDeleteDate || col.isGenerated) {
        continue;
      }

      const dbColName = col.databaseName;
      const staticDefault = this.resolveStaticDefaultValue(col);

      if (staticDefault !== undefined && staticDefault !== null) {
        await this.dataSource.manager
          .createQueryBuilder()
          .update(tableName)
          .set({ [col.propertyName]: staticDefault })
          .where(`\`${dbColName}\` IS NULL`)
          .execute()
          .catch(() => undefined);
      }

      if (
        col.type === 'enum' &&
        Array.isArray(col.enum) &&
        col.enum.length > 0 &&
        staticDefault !== undefined &&
        staticDefault !== null
      ) {
        await this.dataSource.manager
          .createQueryBuilder()
          .update(tableName)
          .set({ [col.propertyName]: staticDefault })
          .where(`\`${dbColName}\` NOT IN (:...validEnums)`, { validEnums: col.enum })
          .execute()
          .catch(() => undefined);
      }

      if (col.type === 'json' && !col.isNullable && staticDefault === undefined) {
        await this.dataSource.manager
          .createQueryBuilder()
          .update(tableName)
          .set({ [col.propertyName]: () => `'[]'` })
          .where(`\`${dbColName}\` IS NULL`)
          .execute()
          .catch(() => undefined);
      }
    }
  }

  private hasValidToTransformer(transformer?: ValueTransformer | ValueTransformer[]): boolean {
    if (!transformer) {
      return false;
    }
    const firstTransformer = Array.isArray(transformer) ? transformer[0] : transformer;
    return Boolean(firstTransformer && 'to' in firstTransformer);
  }

  private async syncColumnTransformers(entityMeta: EntityMetadata): Promise<void> {
    const transformerColumns = entityMeta.columns.filter(
      (col) => !col.isPrimary && this.hasValidToTransformer(col.transformer),
    );

    if (transformerColumns.length === 0) {
      return;
    }

    const primaryCol = entityMeta.primaryColumns[0];
    if (!primaryCol) {
      return;
    }

    const tableName = entityMeta.tableName;
    const pkDbName = primaryCol.databaseName;
    const batchSize = 500;
    let offset = 0;

    while (true) {
      const selectCols = [
        `t.\`${pkDbName}\` AS \`${pkDbName}\``,
        ...transformerColumns.map((c) => `t.\`${c.databaseName}\` AS \`${c.databaseName}\``),
      ];

      const rows = await this.dataSource.manager
        .createQueryBuilder()
        .select(selectCols)
        .from(tableName, 't')
        .orderBy(`t.\`${pkDbName}\``, 'ASC')
        .offset(offset)
        .limit(batchSize)
        .getRawMany<Record<string, any>>();

      if (!rows || rows.length === 0) {
        break;
      }

      for (const row of rows) {
        const pkVal = row[pkDbName];
        if (pkVal === undefined || pkVal === null) continue;

        const patch: Record<string, any> = {};

        for (const col of transformerColumns) {
          const rawVal = row[col.databaseName];
          if (rawVal === undefined || rawVal === null || !col.transformer) continue;

          const transformers = Array.isArray(col.transformer) ? col.transformer : [col.transformer];
          let transformedVal: any = rawVal;

          for (const tr of transformers) {
            if (tr && 'to' in tr) {
              transformedVal = tr.to(transformedVal);
            }
          }

          if (transformedVal !== rawVal && typeof transformedVal !== 'object') {
            patch[col.propertyName] = transformedVal;
          }
        }

        if (Object.keys(patch).length > 0) {
          await this.dataSource.manager
            .createQueryBuilder()
            .update(tableName)
            .set(patch)
            .where(`\`${pkDbName}\` = :pkVal`, { pkVal })
            .execute();
        }
      }

      if (rows.length < batchSize) {
        break;
      }
      offset += batchSize;
    }
  }

  private resolveStaticDefaultValue(col: ColumnMetadata): any {
    if (col.default === undefined || col.default === null) {
      return undefined;
    }

    if (typeof col.default === 'function') {
      const fnResult = col.default();
      if (typeof fnResult === 'string' && /CURRENT_TIMESTAMP|NOW\(\)|UUID\(\)/i.test(fnResult)) {
        return undefined;
      }
      return fnResult;
    }

    return col.default;
  }
}
