/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
import { Logger } from '@nestjs/common';

import {
  EntityTarget,
  ObjectLiteral,
  QueryRunner,
  TableColumn,
  TableColumnOptions,
  TableForeignKey,
  TableForeignKeyOptions,
  TableIndex,
  TableIndexOptions,
} from 'typeorm';

export interface BatchTransformOptions<TRow = Record<string, any>> {
  tableName: string;
  primaryKey?: string;
  batchSize?: number;
  whereClause?: string;
  whereParams?: any[];
  selectColumns?: string[];
  transformRow: (
    row: TRow,
    queryRunner: QueryRunner,
  ) => Promise<Record<string, any> | null> | Record<string, any> | null;
}

export interface CopyColumnDataOptions<TSource = any, TTarget = any> {
  tableName: string;
  sourceColumn: string;
  targetColumn: string;
  primaryKey?: string;
  batchSize?: number;
  onlyWhenTargetNull?: boolean;
  transform?: (sourceValue: TSource, row: Record<string, any>) => Promise<TTarget> | TTarget;
}

export class SchemaMigrationHelper {
  private static readonly logger = new Logger(SchemaMigrationHelper.name);

  static async safeAddColumn(
    queryRunner: QueryRunner,
    tableName: string,
    columnOptions: TableColumnOptions,
    backfillValue?: any | ((row: Record<string, any>) => any),
  ): Promise<void> {
    const hasCol = await queryRunner.hasColumn(tableName, columnOptions.name);
    if (hasCol) {
      this.logger.log(`[Skip] Column '${tableName}.${columnOptions.name}' already exists.`);
      return;
    }

    const needsTwoStepNotNull =
      !columnOptions.isNullable &&
      columnOptions.default === undefined &&
      backfillValue !== undefined;

    if (needsTwoStepNotNull) {
      await queryRunner.addColumn(
        tableName,
        new TableColumn({
          ...columnOptions,
          isNullable: true,
        }),
      );

      if (typeof backfillValue === 'function') {
        await this.batchTransformData(queryRunner, {
          tableName,
          transformRow: async (row) => ({
            [columnOptions.name]: await backfillValue(row),
          }),
        });
      } else {
        await queryRunner.manager
          .createQueryBuilder()
          .update(tableName)
          .set({ [columnOptions.name]: backfillValue })
          .where(`${columnOptions.name} IS NULL`)
          .execute();
      }

      // Bước 3: Khoá cột thành NOT NULL theo đúng thiết kế
      await queryRunner.changeColumn(
        tableName,
        columnOptions.name,
        new TableColumn({
          ...columnOptions,
          isNullable: false,
        }),
      );
    } else {
      await queryRunner.addColumn(tableName, new TableColumn(columnOptions));

      if (backfillValue !== undefined && typeof backfillValue === 'function') {
        await this.batchTransformData(queryRunner, {
          tableName,
          transformRow: async (row) => ({
            [columnOptions.name]: await backfillValue(row),
          }),
        });
      }
    }

    this.logger.log(`[Added] Column '${tableName}.${columnOptions.name}' successfully.`);
  }

  static async safeRenameColumn(
    queryRunner: QueryRunner,
    tableName: string,
    oldColumnName: string,
    newColumnName: string,
  ): Promise<void> {
    const hasOld = await queryRunner.hasColumn(tableName, oldColumnName);
    const hasNew = await queryRunner.hasColumn(tableName, newColumnName);

    if (!hasOld && hasNew) {
      this.logger.log(
        `[Skip] Column '${tableName}.${oldColumnName}' already renamed to '${newColumnName}'.`,
      );
      return;
    }
    if (!hasOld) {
      throw new Error(
        `Cannot rename column: source column '${tableName}.${oldColumnName}' does not exist.`,
      );
    }

    await queryRunner.renameColumn(tableName, oldColumnName, newColumnName);
    this.logger.log(`[Renamed] Column '${tableName}.${oldColumnName}' -> '${newColumnName}'.`);
  }

  static async safeModifyColumn(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
    newColumnOptions: TableColumnOptions,
    preNormalizeTransform?: (oldValue: any, row: Record<string, any>) => any,
  ): Promise<void> {
    const hasCol = await queryRunner.hasColumn(tableName, columnName);
    if (!hasCol) {
      await this.safeAddColumn(queryRunner, tableName, newColumnOptions);
      return;
    }

    if (preNormalizeTransform) {
      await this.batchTransformData(queryRunner, {
        tableName,
        selectColumns: ['id', columnName],
        transformRow: async (row) => {
          const nextVal = await preNormalizeTransform(row[columnName], row);
          if (nextVal === row[columnName]) return null;
          return { [columnName]: nextVal };
        },
      });
    }

    await queryRunner.changeColumn(tableName, columnName, new TableColumn(newColumnOptions));
    this.logger.log(`[Modified] Column '${tableName}.${columnName}' updated.`);
  }

  static async safeDropColumn(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
    archiveToColumn?: {
      targetColumn: string;
      transform?: (val: any, row: Record<string, any>) => any;
    },
  ): Promise<void> {
    const hasCol = await queryRunner.hasColumn(tableName, columnName);
    if (!hasCol) {
      this.logger.log(`[Skip] Column '${tableName}.${columnName}' already dropped.`);
      return;
    }

    if (archiveToColumn) {
      await this.copyAndTransformColumn(queryRunner, {
        tableName,
        sourceColumn: columnName,
        targetColumn: archiveToColumn.targetColumn,
        transform: archiveToColumn.transform,
      });
    }

    await queryRunner.dropColumn(tableName, columnName);
    this.logger.log(`[Dropped] Column '${tableName}.${columnName}'.`);
  }

  static async copyAndTransformColumn<TSource = any, TTarget = any>(
    queryRunner: QueryRunner,
    options: CopyColumnDataOptions<TSource, TTarget>,
  ): Promise<number> {
    const {
      tableName,
      sourceColumn,
      targetColumn,
      primaryKey = 'id',
      batchSize = 500,
      onlyWhenTargetNull = true,
      transform,
    } = options;

    if (!transform) {
      const qb = queryRunner.manager
        .createQueryBuilder()
        .update(tableName)
        .set({ [targetColumn]: () => `\`${sourceColumn}\`` });

      if (onlyWhenTargetNull) {
        qb.where(`\`${targetColumn}\` IS NULL AND \`${sourceColumn}\` IS NOT NULL`);
      }

      const res = await qb.execute();
      return res.affected || 0;
    }

    return this.batchTransformData(queryRunner, {
      tableName,
      primaryKey,
      batchSize,
      selectColumns: [primaryKey, sourceColumn, targetColumn],
      whereClause: onlyWhenTargetNull ? `\`${targetColumn}\` IS NULL` : undefined,
      transformRow: async (row) => {
        const transformed = await transform(row[sourceColumn] as TSource, row);
        return { [targetColumn]: transformed };
      },
    });
  }

  static async batchTransformData<TRow extends Record<string, any> = Record<string, any>>(
    queryRunner: QueryRunner,
    options: BatchTransformOptions<TRow>,
  ): Promise<number> {
    const {
      tableName,
      primaryKey = 'id',
      batchSize = 500,
      whereClause,
      selectColumns,
      transformRow,
    } = options;

    let offset = 0;
    let totalUpdated = 0;

    while (true) {
      const qb = queryRunner.manager
        .createQueryBuilder()
        .from(tableName, 't')
        .orderBy(`t.${primaryKey}`, 'ASC')
        .offset(offset)
        .limit(batchSize);

      if (selectColumns && selectColumns.length > 0) {
        const cols = Array.from(new Set([primaryKey, ...selectColumns]));
        qb.select(cols.map((c) => `t.${c} AS ${c}`));
      } else {
        qb.select('t.*');
      }

      if (whereClause) {
        qb.where(whereClause);
      }

      const rows = await qb.getRawMany();
      if (!rows || rows.length === 0) {
        break;
      }

      for (const row of rows) {
        const pkVal = row[primaryKey];
        if (pkVal === undefined || pkVal === null) continue;

        const patch = await transformRow(row, queryRunner);
        if (patch && Object.keys(patch).length > 0) {
          await queryRunner.manager
            .createQueryBuilder()
            .update(tableName)
            .set(patch)
            .where(`\`${primaryKey}\` = :pkVal`, { pkVal })
            .execute();
          totalUpdated++;
        }
      }

      if (rows.length < batchSize) {
        break;
      }
      offset += batchSize;
    }

    this.logger.log(
      `[BatchTransform] Completed on '${tableName}': ${totalUpdated} row(s) synchronized.`,
    );
    return totalUpdated;
  }

  static async safeCreateIndex(
    queryRunner: QueryRunner,
    tableName: string,
    indexOptions: TableIndexOptions,
  ): Promise<void> {
    const table = await queryRunner.getTable(tableName);
    if (!table) return;

    const exists = table.indices.some(
      (idx) =>
        (indexOptions.name && idx.name === indexOptions.name) ||
        (idx.columnNames.length === indexOptions.columnNames.length &&
          idx.columnNames.every((col, i) => col === indexOptions.columnNames[i])),
    );

    if (exists) {
      this.logger.log(
        `[Skip] Index on '${tableName}(${indexOptions.columnNames.join(', ')})' already exists.`,
      );
      return;
    }

    await queryRunner.createIndex(tableName, new TableIndex(indexOptions));
    this.logger.log(
      `[Created] Index '${indexOptions.name || indexOptions.columnNames.join('_')}' on '${tableName}'.`,
    );
  }

  static async safeCreateForeignKey(
    queryRunner: QueryRunner,
    tableName: string,
    fkOptions: TableForeignKeyOptions,
    orphanStrategy: 'DELETE' | 'SET_NULL' | 'NONE' = 'DELETE',
  ): Promise<void> {
    const table = await queryRunner.getTable(tableName);
    if (!table) return;

    const exists = table.foreignKeys.some(
      (fk) =>
        (fkOptions.name && fk.name === fkOptions.name) ||
        (fk.referencedTableName === fkOptions.referencedTableName &&
          fk.columnNames.join(',') === fkOptions.columnNames.join(',')),
    );

    if (exists) {
      this.logger.log(
        `[Skip] ForeignKey on '${tableName}(${fkOptions.columnNames.join(',')})' already exists.`,
      );
      return;
    }

    // Tự động xử lý dữ liệu cũ bị mồ côi (không khớp bảng cha) trước khi gắn khoá ngoại
    if (
      orphanStrategy !== 'NONE' &&
      fkOptions.columnNames.length === 1 &&
      fkOptions.referencedColumnNames.length === 1
    ) {
      const childCol = fkOptions.columnNames[0];
      const parentTable = fkOptions.referencedTableName;
      const parentCol = fkOptions.referencedColumnNames[0];

      const subQuery = queryRunner.manager
        .createQueryBuilder()
        .subQuery()
        .select(`p.\`${parentCol}\``)
        .from(parentTable, 'p')
        .getQuery();

      if (orphanStrategy === 'SET_NULL') {
        await queryRunner.manager
          .createQueryBuilder()
          .update(tableName)
          .set({ [childCol]: null })
          .where(`\`${childCol}\` IS NOT NULL AND \`${childCol}\` NOT IN ${subQuery}`)
          .execute();
      } else if (orphanStrategy === 'DELETE') {
        await queryRunner.manager
          .createQueryBuilder()
          .delete()
          .from(tableName)
          .where(`\`${childCol}\` IS NOT NULL AND \`${childCol}\` NOT IN ${subQuery}`)
          .execute();
      }
    }

    await queryRunner.createForeignKey(tableName, new TableForeignKey(fkOptions));
    this.logger.log(
      `[Created] ForeignKey on '${tableName}(${fkOptions.columnNames.join(',')})' -> '${fkOptions.referencedTableName}'.`,
    );
  }

  static async upsertSeedData<T extends ObjectLiteral>(
    queryRunner: QueryRunner,
    entity: EntityTarget<T>,
    records: Partial<T>[],
    conflictPaths: (keyof T & string)[],
  ): Promise<void> {
    if (!records || records.length === 0) return;
    const repo = queryRunner.manager.getRepository(entity);
    await repo.upsert(records as any, {
      conflictPaths: conflictPaths as string[],
      skipUpdateIfNoValuesChanged: true,
    });
  }
}
