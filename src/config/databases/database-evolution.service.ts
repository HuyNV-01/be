import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { DataSource, EntityMetadata, ValueTransformer } from 'typeorm';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';

/**
 * DatabaseEvolutionService (100% Zero-Config & Metadata-Driven):
 * Tự động quét siêu dữ liệu (Metadata) của TOÀN BỘ các Entity trong dự án (`this.dataSource.entityMetadatas`)
 * và đối chiếu với dữ liệu thực tế trong Database để tự động đồng bộ, chuẩn hoá và điền dữ liệu thiếu (Backfill)
 * cho các bản ghi cũ mà KHÔNG CẦN khai báo bất kỳ task thủ công nào khi thêm bảng mới hay cột mới trong tương lai.
 */
@Injectable()
export class DatabaseEvolutionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabaseEvolutionService.name, { timestamp: true });

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.DB_AUTO_DATA_SYNC === 'false') {
      return;
    }

    try {
      await this.autoSynchronizeAllEntitiesData();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[DatabaseEvolution] Auto data sync warning: ${msg}`);
    }
  }

  /**
   * Tự động duyệt qua tất cả các Entity đã đăng ký trong hệ thống:
   * 1. Tự động điền giá trị `default` cho các cột mới thêm trên các dòng dữ liệu cũ đang bị NULL.
   * 2. Tự động chuẩn hoá giá trị các cột dạng `enum` nếu dữ liệu cũ bị rỗng hoặc lệch tập giá trị hợp lệ.
   * 3. Tự động khởi tạo giá trị mặc định an toàn (`[]` hoặc `{}`) cho các cột kiểu `json` đang bị NULL trên dữ liệu cũ.
   * 4. Tự động chạy bộ biến đổi dữ liệu (`column.transformer`) của Entity trên các bản ghi cũ chưa được chuẩn hoá.
   */
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

  /**
   * Tự động phát hiện các cột có cấu hình `default` hoặc kiểu `json` / `enum` trong Entity
   * và tự động điền (Backfill) vào các dòng dữ liệu cũ đang bị NULL hoặc không hợp lệ.
   */
  private async syncMissingDefaultsAndJsonColumns(entityMeta: EntityMetadata): Promise<void> {
    const tableName = entityMeta.tableName;

    for (const col of entityMeta.columns) {
      // Bỏ qua các cột khoá chính, cột xoá mềm (deleted_at) hoặc cột tự động tăng
      if (col.isPrimary || col.isDeleteDate || col.isGenerated) {
        continue;
      }

      const dbColName = col.databaseName;
      const staticDefault = this.resolveStaticDefaultValue(col);

      // 1. Nếu cột trong Entity có khai báo giá trị `default` tĩnh, tự động cập nhật các bản ghi cũ đang bị NULL
      if (staticDefault !== undefined && staticDefault !== null) {
        await this.dataSource.manager
          .createQueryBuilder()
          .update(tableName)
          .set({ [col.propertyName]: staticDefault })
          .where(`\`${dbColName}\` IS NULL`)
          .execute();
      }

      // 2. Nếu cột là kiểu `enum` và có giá trị default, tự động sửa các dòng dữ liệu cũ có giá trị không nằm trong tập enum mới
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
          .execute();
      }

      // 3. Nếu cột là kiểu `json` và không cho phép NULL (`isNullable === false`), tự động điền mảng rỗng `[]` cho các dòng cũ
      if (col.type === 'json' && !col.isNullable && staticDefault === undefined) {
        await this.dataSource.manager
          .createQueryBuilder()
          .update(tableName)
          .set({ [col.propertyName]: () => `'[]'` })
          .where(`\`${dbColName}\` IS NULL`)
          .execute();
      }
    }
  }

  /**
   * Kiểm tra một ValueTransformer có hàm `to` hợp lệ hay không bằng toán tử `'to' in ...`
   * để không tách method khỏi object (tránh lỗi ESLint `@typescript-eslint/unbound-method`).
   */
  private hasValidToTransformer(transformer?: ValueTransformer | ValueTransformer[]): boolean {
    if (!transformer) {
      return false;
    }
    const firstTransformer = Array.isArray(transformer) ? transformer[0] : transformer;
    return Boolean(firstTransformer && 'to' in firstTransformer);
  }

  /**
   * Tự động phát hiện các cột có gắn `transformer` trên `@Column({ transformer: ... })`
   * và chạy chuẩn hoá theo từng lô (Batch) cho toàn bộ dữ liệu cũ trong bảng.
   */
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
              // Gọi trực tiếp `tr.to(transformedVal)` gắn với ngữ cảnh `tr`
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

  /**
   * Trích xuất giá trị mặc định tĩnh từ cấu hình `@Column({ default: ... })` của Entity
   */
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
