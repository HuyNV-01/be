import { MigrationInterface, QueryRunner } from "typeorm";

export class AutoMigration1792942586947 implements MigrationInterface {
    name = 'AutoMigration1792942586947'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`conversation_participants\` CHANGE \`userId\` \`userId\` varchar(36) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`messages\` CHANGE \`conversationId\` \`conversationId\` varchar(36) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`messages\` CHANGE \`senderId\` \`senderId\` varchar(36) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`files\` CHANGE \`mime_type\` \`mime_type\` varchar(128) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`media\` CHANGE \`file_id\` \`file_id\` varchar(36) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`media\` CHANGE \`target_id\` \`target_id\` varchar(36) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`contacts\` CHANGE \`userId\` \`userId\` varchar(36) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`contacts\` CHANGE \`contactId\` \`contactId\` varchar(36) NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX \`IDX_e43efbfa3b850160b5b2c50e3e\` ON \`conversation_participants\` (\`conversationId\`, \`userId\`)`);
        await queryRunner.query(`CREATE INDEX \`IDX_e5663ce0c730b2de83445e2fd1\` ON \`messages\` (\`conversationId\`)`);
        await queryRunner.query(`CREATE INDEX \`IDX_2db9cf2b3ca111742793f6c37c\` ON \`messages\` (\`senderId\`)`);
        await queryRunner.query(`CREATE INDEX \`IDX_11b381be6776b9dbd8a878f83e\` ON \`messages\` (\`conversationId\`, \`senderId\`, \`client_temp_id\`)`);
        await queryRunner.query(`CREATE INDEX \`IDX_445bed739e56ceeda7befc1ed7\` ON \`messages\` (\`conversationId\`, \`is_pinned\`)`);
        await queryRunner.query(`CREATE INDEX \`IDX_5d512d651fc003ea089e125e5a\` ON \`messages\` (\`conversationId\`, \`created_at\`)`);
        await queryRunner.query(`CREATE INDEX \`IDX_9a3333da0464320bdc44ca96cf\` ON \`files\` (\`uploader_id\`)`);
        await queryRunner.query(`CREATE INDEX \`IDX_cac82b29eea888470cc40043b7\` ON \`media\` (\`file_id\`)`);
        await queryRunner.query(`CREATE INDEX \`IDX_1fb301d5be1426037042452c82\` ON \`media\` (\`target_id\`, \`type\`)`);
        await queryRunner.query(`CREATE INDEX \`IDX_e8e85cc81cb9d998f41b0b6455\` ON \`contacts\` (\`contactId\`, \`status\`)`);
        await queryRunner.query(`CREATE INDEX \`IDX_6edcc46815031ed265d8f9b325\` ON \`contacts\` (\`userId\`, \`status\`)`);
        await queryRunner.query(`CREATE UNIQUE INDEX \`IDX_01f3fb3c74eac4e08afe8e26b3\` ON \`contacts\` (\`userId\`, \`contactId\`)`);
        await queryRunner.query(`ALTER TABLE \`conversation_participants\` ADD CONSTRAINT \`FK_4453e20858b14ab765a09ad728c\` FOREIGN KEY (\`conversationId\`) REFERENCES \`conversations\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`conversation_participants\` ADD CONSTRAINT \`FK_18c4ba3b127461649e5f5039dbf\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`messages\` ADD CONSTRAINT \`FK_e5663ce0c730b2de83445e2fd19\` FOREIGN KEY (\`conversationId\`) REFERENCES \`conversations\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`messages\` ADD CONSTRAINT \`FK_2db9cf2b3ca111742793f6c37ce\` FOREIGN KEY (\`senderId\`) REFERENCES \`users\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`files\` ADD CONSTRAINT \`FK_9a3333da0464320bdc44ca96cfb\` FOREIGN KEY (\`uploader_id\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`media\` ADD CONSTRAINT \`FK_cac82b29eea888470cc40043b76\` FOREIGN KEY (\`file_id\`) REFERENCES \`files\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`contacts\` ADD CONSTRAINT \`FK_30ef77942fc8c05fcb829dcc61d\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`contacts\` ADD CONSTRAINT \`FK_2f2eeb268dcaf6e7f1c2176949f\` FOREIGN KEY (\`contactId\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`contacts\` DROP FOREIGN KEY \`FK_2f2eeb268dcaf6e7f1c2176949f\``);
        await queryRunner.query(`ALTER TABLE \`contacts\` DROP FOREIGN KEY \`FK_30ef77942fc8c05fcb829dcc61d\``);
        await queryRunner.query(`ALTER TABLE \`media\` DROP FOREIGN KEY \`FK_cac82b29eea888470cc40043b76\``);
        await queryRunner.query(`ALTER TABLE \`files\` DROP FOREIGN KEY \`FK_9a3333da0464320bdc44ca96cfb\``);
        await queryRunner.query(`ALTER TABLE \`messages\` DROP FOREIGN KEY \`FK_2db9cf2b3ca111742793f6c37ce\``);
        await queryRunner.query(`ALTER TABLE \`messages\` DROP FOREIGN KEY \`FK_e5663ce0c730b2de83445e2fd19\``);
        await queryRunner.query(`ALTER TABLE \`conversation_participants\` DROP FOREIGN KEY \`FK_18c4ba3b127461649e5f5039dbf\``);
        await queryRunner.query(`ALTER TABLE \`conversation_participants\` DROP FOREIGN KEY \`FK_4453e20858b14ab765a09ad728c\``);
        await queryRunner.query(`DROP INDEX \`IDX_01f3fb3c74eac4e08afe8e26b3\` ON \`contacts\``);
        await queryRunner.query(`DROP INDEX \`IDX_6edcc46815031ed265d8f9b325\` ON \`contacts\``);
        await queryRunner.query(`DROP INDEX \`IDX_e8e85cc81cb9d998f41b0b6455\` ON \`contacts\``);
        await queryRunner.query(`DROP INDEX \`IDX_1fb301d5be1426037042452c82\` ON \`media\``);
        await queryRunner.query(`DROP INDEX \`IDX_cac82b29eea888470cc40043b7\` ON \`media\``);
        await queryRunner.query(`DROP INDEX \`IDX_9a3333da0464320bdc44ca96cf\` ON \`files\``);
        await queryRunner.query(`DROP INDEX \`IDX_5d512d651fc003ea089e125e5a\` ON \`messages\``);
        await queryRunner.query(`DROP INDEX \`IDX_445bed739e56ceeda7befc1ed7\` ON \`messages\``);
        await queryRunner.query(`DROP INDEX \`IDX_11b381be6776b9dbd8a878f83e\` ON \`messages\``);
        await queryRunner.query(`DROP INDEX \`IDX_2db9cf2b3ca111742793f6c37c\` ON \`messages\``);
        await queryRunner.query(`DROP INDEX \`IDX_e5663ce0c730b2de83445e2fd1\` ON \`messages\``);
        await queryRunner.query(`DROP INDEX \`IDX_e43efbfa3b850160b5b2c50e3e\` ON \`conversation_participants\``);
        await queryRunner.query(`ALTER TABLE \`contacts\` CHANGE \`contactId\` \`contactId\` varchar(36) NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE \`contacts\` CHANGE \`userId\` \`userId\` varchar(36) NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE \`media\` CHANGE \`target_id\` \`target_id\` varchar(36) NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE \`media\` CHANGE \`file_id\` \`file_id\` varchar(36) NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE \`files\` CHANGE \`mime_type\` \`mime_type\` varchar(128) NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE \`messages\` CHANGE \`senderId\` \`senderId\` varchar(36) NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE \`messages\` CHANGE \`conversationId\` \`conversationId\` varchar(36) NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE \`conversation_participants\` CHANGE \`userId\` \`userId\` varchar(36) NOT NULL DEFAULT ''`);
    }

}
