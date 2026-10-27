import { MigrationInterface, QueryRunner } from 'typeorm';

export class AutoMigration1793040369288 implements MigrationInterface {
  name = 'AutoMigration1793040369288';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryRunner.query(`ALTER TABLE \`conversation_participants\` ADD \`sound_enabled\` tinyint NOT NULL DEFAULT 1`);
    await queryRunner.query(`ALTER TABLE \`conversation_participants\` ADD \`read_receipts_enabled\` tinyint NOT NULL DEFAULT 1`);
    await queryRunner.query(`ALTER TABLE \`conversation_participants\` ADD \`is_restricted\` tinyint NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE \`conversation_participants\` ADD \`is_hidden\` tinyint NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE \`conversation_participants\` ADD \`cleared_at\` datetime NULL`);
    await queryRunner.query(`ALTER TABLE \`conversation_participants\` ADD \`nickname\` varchar(100) NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`disappearing_ttl\` int NULL`);
    await queryRunner.query(`ALTER TABLE \`messages\` ADD \`expires_at\` datetime NULL`);
    await queryRunner.query(`CREATE INDEX \`IDX_3a83b1bc057fd8dd8ffcc926ca\` ON \`messages\` (\`expires_at\`)`);
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryRunner.query(`DROP INDEX \`IDX_3a83b1bc057fd8dd8ffcc926ca\` ON \`messages\``);
    await queryRunner.query(`ALTER TABLE \`messages\` DROP COLUMN \`expires_at\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`disappearing_ttl\``);
    await queryRunner.query(`ALTER TABLE \`conversation_participants\` DROP COLUMN \`nickname\``);
    await queryRunner.query(`ALTER TABLE \`conversation_participants\` DROP COLUMN \`cleared_at\``);
    await queryRunner.query(`ALTER TABLE \`conversation_participants\` DROP COLUMN \`is_hidden\``);
    await queryRunner.query(`ALTER TABLE \`conversation_participants\` DROP COLUMN \`is_restricted\``);
    await queryRunner.query(`ALTER TABLE \`conversation_participants\` DROP COLUMN \`read_receipts_enabled\``);
    await queryRunner.query(`ALTER TABLE \`conversation_participants\` DROP COLUMN \`sound_enabled\``);
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}
