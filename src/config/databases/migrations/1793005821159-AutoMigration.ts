import { MigrationInterface, QueryRunner } from 'typeorm';

export class AutoMigration1793005821159 implements MigrationInterface {
  name = 'AutoMigration1793005821159';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryRunner.query(`CREATE TABLE \`notifications\` (\`id\` varchar(36) NOT NULL, \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`created_by\` varchar(36) NULL, \`updated_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`updated_by\` varchar(36) NULL, \`deleted_at\` timestamp(6) NULL, \`deleted_by\` varchar(36) NULL, \`version\` int NOT NULL DEFAULT '1', \`recipient_id\` varchar(36) NOT NULL, \`actor_id\` varchar(36) NULL, \`type\` enum ('NEW_MESSAGE', 'MESSAGE_REPLY', 'MESSAGE_REACTION', 'MESSAGE_PINNED', 'FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'GROUP_INVITE', 'GROUP_MEMBER_ADDED', 'MISSED_CALL', 'SYSTEM') NOT NULL DEFAULT 'SYSTEM', \`title\` varchar(255) NOT NULL, \`content\` text NOT NULL, \`resource_type\` enum ('CONVERSATION', 'MESSAGE', 'CONTACT', 'CALL', 'USER', 'SYSTEM') NOT NULL DEFAULT 'SYSTEM', \`resource_id\` varchar(64) NULL, \`dedupe_key\` varchar(120) NULL, \`is_read\` tinyint NOT NULL DEFAULT 0, \`read_at\` timestamp(6) NULL, \`metadata\` json NULL, INDEX \`IDX_77ee7b06d6f802000c0846f3a5\` (\`created_at\`), INDEX \`IDX_5332a4daa46fd3f4e6625dd275\` (\`recipient_id\`), INDEX \`IDX_de962608d1d6cd6457cfa388c9\` (\`recipient_id\`, \`resource_type\`, \`resource_id\`), INDEX \`IDX_d6618e82b5f8167185ed2a2f8e\` (\`recipient_id\`, \`dedupe_key\`), INDEX \`IDX_a0e23ed71f5b46f4892369b78f\` (\`recipient_id\`, \`is_read\`, \`created_at\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    await queryRunner.query(`ALTER TABLE \`notifications\` ADD CONSTRAINT \`FK_5332a4daa46fd3f4e6625dd275d\` FOREIGN KEY (\`recipient_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE \`notifications\` ADD CONSTRAINT \`FK_20f8b51fd9655c0b69feed5efc6\` FOREIGN KEY (\`actor_id\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`);
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryRunner.query(`ALTER TABLE \`notifications\` DROP FOREIGN KEY \`FK_20f8b51fd9655c0b69feed5efc6\``);
    await queryRunner.query(`ALTER TABLE \`notifications\` DROP FOREIGN KEY \`FK_5332a4daa46fd3f4e6625dd275d\``);
    await queryRunner.query(`DROP INDEX \`IDX_a0e23ed71f5b46f4892369b78f\` ON \`notifications\``);
    await queryRunner.query(`DROP INDEX \`IDX_d6618e82b5f8167185ed2a2f8e\` ON \`notifications\``);
    await queryRunner.query(`DROP INDEX \`IDX_de962608d1d6cd6457cfa388c9\` ON \`notifications\``);
    await queryRunner.query(`DROP INDEX \`IDX_5332a4daa46fd3f4e6625dd275\` ON \`notifications\``);
    await queryRunner.query(`DROP INDEX \`IDX_77ee7b06d6f802000c0846f3a5\` ON \`notifications\``);
    await queryRunner.query(`DROP TABLE \`notifications\``);
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}
