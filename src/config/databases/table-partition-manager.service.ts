import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { DataSource, QueryRunner } from 'typeorm';

interface PartitionSpec {
  name: string;
  lessThanUnix: number;
}

@Injectable()
export class TablePartitionManagerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TablePartitionManagerService.name, {
    timestamp: true,
  });

  private readonly PARTITIONED_TABLES = ['messages', 'call_participants'];
  private readonly MONTHS_AHEAD = 3;

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.DB_AUTO_PARTITION === 'false') {
      return;
    }

    try {
      await this.ensureMonthlyPartitionsForAllTables();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[TablePartitionManager] Bootstrap partition check warning: ${msg}`);
    }
  }

  /**
   * Tự động chạy vào 00:00 ngày mùng 1 hàng tháng để tạo trước phân vùng cho 3 tháng kế tiếp.
   */
  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT)
  async handleMonthlyPartitionMaintenance(): Promise<void> {
    try {
      await this.ensureMonthlyPartitionsForAllTables();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[TablePartitionManager] Monthly maintenance failed: ${msg}`);
    }
  }

  /**
   * Đảm bảo toàn bộ bảng mục tiêu đã được thiết lập Monthly Range Partitioning
   * và có đủ phân vùng cho tháng hiện tại + 3 tháng tương lai.
   */
  public async ensureMonthlyPartitionsForAllTables(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      for (const tableName of this.PARTITIONED_TABLES) {
        const exists = await queryRunner.hasTable(tableName);
        if (!exists) continue;

        const existingPartitions = await this.getExistingPartitions(queryRunner, tableName);

        if (existingPartitions.length === 0) {
          await this.initializeTableMonthlyPartitioning(queryRunner, tableName);
        } else {
          await this.extendFutureMonthlyPartitions(queryRunner, tableName, existingPartitions);
        }
      }
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Lấy danh sách tên các phân vùng hiện có của một bảng từ INFORMATION_SCHEMA.PARTITIONS.
   */
  private async getExistingPartitions(
    queryRunner: QueryRunner,
    tableName: string,
  ): Promise<string[]> {
    const rows: Array<{ partitionName: string | null }> = await queryRunner.query(
      `
      SELECT PARTITION_NAME AS partitionName
      FROM INFORMATION_SCHEMA.PARTITIONS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND PARTITION_NAME IS NOT NULL
      ORDER BY PARTITION_ORDINAL_POSITION ASC
      `,
      [tableName],
    );

    return rows.map((r) => r.partitionName).filter((name): name is string => Boolean(name));
  }

  /**
   * Chuẩn bị cấu trúc khóa chính (id, created_at), gỡ Foreign Key vật lý,
   * và kích hoạt PARTITION BY RANGE (FLOOR(UNIX_TIMESTAMP(created_at))) lần đầu tiên.
   */
  private async initializeTableMonthlyPartitioning(
    queryRunner: QueryRunner,
    tableName: string,
  ): Promise<void> {
    this.logger.log(
      `[TablePartitionManager] Initializing monthly partitions for "${tableName}"...`,
    );

    // 1. Gỡ bỏ các Foreign Key vật lý trên bảng (nếu có từ các bản migration cũ)
    const fks: Array<{ constraintName: string }> = await queryRunner.query(
      `
      SELECT CONSTRAINT_NAME AS constraintName
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      `,
      [tableName],
    );

    for (const fk of fks) {
      await queryRunner.query(
        `ALTER TABLE \`${tableName}\` DROP FOREIGN KEY \`${fk.constraintName}\``,
      );
    }

    // 2. Đảm bảo có Index đơn trên cột `id` trước khi đổi PRIMARY KEY sang (id, created_at)
    const idIndexes: Array<{ indexName: string }> = await queryRunner.query(
      `
      SELECT INDEX_NAME AS indexName
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = 'id'
        AND INDEX_NAME != 'PRIMARY'
      `,
      [tableName],
    );

    if (idIndexes.length === 0) {
      await queryRunner.query(
        `ALTER TABLE \`${tableName}\` ADD INDEX \`idx_${tableName}_id_lookup\` (\`id\`)`,
      );
    }

    // 3. Chuyển PRIMARY KEY sang khóa phức hợp (id, created_at) nếu chưa có created_at
    const pkCols: Array<{ columnName: string }> = await queryRunner.query(
      `
      SELECT COLUMN_NAME AS columnName
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = 'PRIMARY'
      `,
      [tableName],
    );

    const hasCreatedAtInPk = pkCols.some((c) => c.columnName === 'created_at');
    if (!hasCreatedAtInPk) {
      await queryRunner.query(
        `ALTER TABLE \`${tableName}\` DROP PRIMARY KEY, ADD PRIMARY KEY (\`id\`, \`created_at\`)`,
      );
    }

    // 4. Khởi tạo dải phân vùng từ tháng trước đến +3 tháng tới + p_future
    const specs = this.buildMonthlyPartitionSpecs(-1, this.MONTHS_AHEAD);
    const partitionDefs = [
      ...specs.map((s) => `PARTITION \`${s.name}\` VALUES LESS THAN (${s.lessThanUnix})`),
      `PARTITION \`p_future\` VALUES LESS THAN MAXVALUE`,
    ].join(',\n        ');

    await queryRunner.query(`
      ALTER TABLE \`${tableName}\`
      PARTITION BY RANGE (FLOOR(UNIX_TIMESTAMP(\`created_at\`))) (
        ${partitionDefs}
      )
    `);

    this.logger.log(
      `[TablePartitionManager] Partitioned "${tableName}" with ${specs.length} monthly partitions + p_future.`,
    );
  }

  /**
   * Mở rộng phân vùng cho các tháng mới bằng lệnh REORGANIZE PARTITION p_future
   * mà không cần rebuild lại dữ liệu các tháng cũ.
   */
  private async extendFutureMonthlyPartitions(
    queryRunner: QueryRunner,
    tableName: string,
    existingPartitions: string[],
  ): Promise<void> {
    const existingSet = new Set(existingPartitions);
    const specs = this.buildMonthlyPartitionSpecs(0, this.MONTHS_AHEAD);
    const missingSpecs = specs.filter((s) => !existingSet.has(s.name));

    if (missingSpecs.length === 0 || !existingSet.has('p_future')) {
      return;
    }

    const reorganizeDefs = [
      ...missingSpecs.map((s) => `PARTITION \`${s.name}\` VALUES LESS THAN (${s.lessThanUnix})`),
      `PARTITION \`p_future\` VALUES LESS THAN MAXVALUE`,
    ].join(',\n        ');

    await queryRunner.query(`
      ALTER TABLE \`${tableName}\`
      REORGANIZE PARTITION \`p_future\` INTO (
        ${reorganizeDefs}
      )
    `);

    this.logger.log(
      `[TablePartitionManager] Added monthly partitions [${missingSpecs.map((m) => m.name).join(', ')}] to "${tableName}".`,
    );
  }

  /**
   * Sinh danh sách mốc phân vùng tháng theo chuẩn UTC:
   * Ví dụ phân vùng `p_2026_10` chứa toàn bộ bản ghi có `created_at < 2026-11-01 00:00:00 UTC`.
   */
  private buildMonthlyPartitionSpecs(
    startMonthOffset: number,
    endMonthOffset: number,
  ): PartitionSpec[] {
    const now = new Date();
    const baseYear = now.getUTCFullYear();
    const baseMonth = now.getUTCMonth();
    const specs: PartitionSpec[] = [];

    for (let offset = startMonthOffset; offset <= endMonthOffset; offset++) {
      const targetDate = new Date(Date.UTC(baseYear, baseMonth + offset, 1, 0, 0, 0));
      const nextMonthDate = new Date(
        Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth() + 1, 1, 0, 0, 0),
      );

      const year = targetDate.getUTCFullYear();
      const monthStr = String(targetDate.getUTCMonth() + 1).padStart(2, '0');

      specs.push({
        name: `p_${year}_${monthStr}`,
        lessThanUnix: Math.floor(nextMonthDate.getTime() / 1000),
      });
    }

    return specs;
  }
}
