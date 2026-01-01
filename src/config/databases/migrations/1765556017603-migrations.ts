import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1765556017603 implements MigrationInterface {
    name = 'Migrations1765556017603'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`users\` (\`id\` varchar(36) NOT NULL, \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`created_by\` varchar(255) NULL, \`updated_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`updated_by\` varchar(255) NULL, \`deleted_at\` timestamp(6) NULL, \`deleted_by\` varchar(255) NULL, \`email\` varchar(255) NOT NULL, \`password\` varchar(255) NOT NULL, \`name\` varchar(100) NOT NULL, \`role\` varchar(8) NOT NULL DEFAULT 'USER', \`status\` smallint NOT NULL DEFAULT '0', \`current_sign_in_at\` datetime NULL, \`last_sign_in_at\` datetime NULL, \`refresh_token\` text NULL, \`provider\` varchar(255) NULL, \`uid\` varchar(255) NULL, INDEX \`IDX_c9b5b525a96ddc2c5647d7f7fa\` (\`created_at\`), INDEX \`IDX_2d4a15c7f8b3864a5465fb687e\` (\`email\`, \`name\`), UNIQUE INDEX \`IDX_97672ac88f789774dd47f7c8be\` (\`email\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`conversation_participants\` (\`id\` varchar(36) NOT NULL, \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`created_by\` varchar(255) NULL, \`updated_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`updated_by\` varchar(255) NULL, \`deleted_at\` timestamp(6) NULL, \`deleted_by\` varchar(255) NULL, \`conversationId\` varchar(255) NOT NULL, \`userId\` varchar(255) NOT NULL, \`isAdmin\` tinyint NOT NULL DEFAULT 0, \`lastReadAt\` datetime NULL, \`isMuted\` tinyint NOT NULL DEFAULT 0, \`joinedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`IDX_298787f257b50cbb1953d2bd55\` (\`created_at\`), UNIQUE INDEX \`IDX_e43efbfa3b850160b5b2c50e3e\` (\`conversationId\`, \`userId\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`conversations\` (\`id\` varchar(36) NOT NULL, \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`created_by\` varchar(255) NULL, \`updated_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`updated_by\` varchar(255) NULL, \`deleted_at\` timestamp(6) NULL, \`deleted_by\` varchar(255) NULL, \`type\` enum ('DIRECT', 'GROUP') NOT NULL DEFAULT 'DIRECT', \`name\` varchar(255) NULL, \`avatar\` varchar(255) NULL, \`lastMessage\` text NULL, \`lastMessageSenderId\` varchar(255) NULL, \`lastMessageType\` varchar(255) NULL, \`lastMessageAt\` datetime NULL, INDEX \`IDX_f0bb90db8338e6dc6c349ece99\` (\`created_at\`), INDEX \`IDX_b853c3320df7cf06b7bfa413c8\` (\`lastMessageAt\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`messages\` (\`id\` varchar(36) NOT NULL, \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`created_by\` varchar(255) NULL, \`updated_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`updated_by\` varchar(255) NULL, \`deleted_at\` timestamp(6) NULL, \`deleted_by\` varchar(255) NULL, \`content\` text NULL, \`type\` enum ('TEXT', 'IMAGE', 'FILE', 'SYSTEM') NOT NULL DEFAULT 'TEXT', \`metadata\` json NULL, \`conversationId\` varchar(255) NOT NULL, \`senderId\` varchar(255) NOT NULL, \`readBy\` json NULL, INDEX \`IDX_0777b63da90c27d6ed993dc60b\` (\`created_at\`), INDEX \`IDX_e5663ce0c730b2de83445e2fd1\` (\`conversationId\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`files\` (\`id\` varchar(36) NOT NULL, \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`created_by\` varchar(255) NULL, \`updated_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`updated_by\` varchar(255) NULL, \`deleted_at\` timestamp(6) NULL, \`deleted_by\` varchar(255) NULL, \`original_name\` varchar(255) NOT NULL, \`file_name\` varchar(255) NOT NULL, \`mime_type\` varchar(255) NOT NULL, \`size\` bigint NOT NULL, \`provider\` enum ('MINIO', 'S3', 'LOCAL') NOT NULL, \`bucket\` varchar(255) NOT NULL, \`path\` varchar(255) NOT NULL, \`url\` text NOT NULL, \`metadata\` json NULL, \`hash\` varchar(255) NULL, \`expires_at\` timestamp NULL, \`uploader_id\` varchar(255) NULL, INDEX \`IDX_c66506fd4a933e403dc80edd69\` (\`created_at\`), INDEX \`IDX_b7fd70eedc0d46577c63639855\` (\`hash\`), INDEX \`IDX_c3351d130d1f6a1ec0f694f0d2\` (\`expires_at\`), UNIQUE INDEX \`IDX_9bd7dd3bddb0a6ae274744af85\` (\`file_name\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`media\` (\`id\` varchar(36) NOT NULL, \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`created_by\` varchar(255) NULL, \`updated_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`updated_by\` varchar(255) NULL, \`deleted_at\` timestamp(6) NULL, \`deleted_by\` varchar(255) NULL, \`file_id\` varchar(255) NOT NULL, \`target_id\` varchar(255) NOT NULL, \`type\` enum ('USER_AVATAR', 'USER_COVER', 'MESSAGE_ATTACHMENT', 'POST_IMAGE') NOT NULL, \`order\` int NOT NULL DEFAULT '0', INDEX \`IDX_c30f45ea7b47895ca14398e974\` (\`created_at\`), INDEX \`IDX_1fb301d5be1426037042452c82\` (\`target_id\`, \`type\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`contacts\` (\`id\` varchar(36) NOT NULL, \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`created_by\` varchar(255) NULL, \`updated_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`updated_by\` varchar(255) NULL, \`deleted_at\` timestamp(6) NULL, \`deleted_by\` varchar(255) NULL, \`userId\` varchar(255) NOT NULL, \`contactId\` varchar(255) NOT NULL, \`status\` enum ('PENDING_SENT', 'PENDING_RECEIVED', 'FRIEND', 'BLOCKED') NOT NULL DEFAULT 'PENDING_SENT', \`alias\` varchar(255) NULL, INDEX \`IDX_ec4f69b757fb905b908d0e6607\` (\`created_at\`), INDEX \`IDX_6edcc46815031ed265d8f9b325\` (\`userId\`, \`status\`), UNIQUE INDEX \`IDX_01f3fb3c74eac4e08afe8e26b3\` (\`userId\`, \`contactId\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`conversation_participants\` ADD CONSTRAINT \`FK_4453e20858b14ab765a09ad728c\` FOREIGN KEY (\`conversationId\`) REFERENCES \`conversations\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`conversation_participants\` ADD CONSTRAINT \`FK_18c4ba3b127461649e5f5039dbf\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`messages\` ADD CONSTRAINT \`FK_e5663ce0c730b2de83445e2fd19\` FOREIGN KEY (\`conversationId\`) REFERENCES \`conversations\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`messages\` ADD CONSTRAINT \`FK_2db9cf2b3ca111742793f6c37ce\` FOREIGN KEY (\`senderId\`) REFERENCES \`users\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`files\` ADD CONSTRAINT \`FK_9a3333da0464320bdc44ca96cfb\` FOREIGN KEY (\`uploader_id\`) REFERENCES \`users\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
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
        await queryRunner.query(`DROP INDEX \`IDX_ec4f69b757fb905b908d0e6607\` ON \`contacts\``);
        await queryRunner.query(`DROP TABLE \`contacts\``);
        await queryRunner.query(`DROP INDEX \`IDX_1fb301d5be1426037042452c82\` ON \`media\``);
        await queryRunner.query(`DROP INDEX \`IDX_c30f45ea7b47895ca14398e974\` ON \`media\``);
        await queryRunner.query(`DROP TABLE \`media\``);
        await queryRunner.query(`DROP INDEX \`IDX_9bd7dd3bddb0a6ae274744af85\` ON \`files\``);
        await queryRunner.query(`DROP INDEX \`IDX_c3351d130d1f6a1ec0f694f0d2\` ON \`files\``);
        await queryRunner.query(`DROP INDEX \`IDX_b7fd70eedc0d46577c63639855\` ON \`files\``);
        await queryRunner.query(`DROP INDEX \`IDX_c66506fd4a933e403dc80edd69\` ON \`files\``);
        await queryRunner.query(`DROP TABLE \`files\``);
        await queryRunner.query(`DROP INDEX \`IDX_e5663ce0c730b2de83445e2fd1\` ON \`messages\``);
        await queryRunner.query(`DROP INDEX \`IDX_0777b63da90c27d6ed993dc60b\` ON \`messages\``);
        await queryRunner.query(`DROP TABLE \`messages\``);
        await queryRunner.query(`DROP INDEX \`IDX_b853c3320df7cf06b7bfa413c8\` ON \`conversations\``);
        await queryRunner.query(`DROP INDEX \`IDX_f0bb90db8338e6dc6c349ece99\` ON \`conversations\``);
        await queryRunner.query(`DROP TABLE \`conversations\``);
        await queryRunner.query(`DROP INDEX \`IDX_e43efbfa3b850160b5b2c50e3e\` ON \`conversation_participants\``);
        await queryRunner.query(`DROP INDEX \`IDX_298787f257b50cbb1953d2bd55\` ON \`conversation_participants\``);
        await queryRunner.query(`DROP TABLE \`conversation_participants\``);
        await queryRunner.query(`DROP INDEX \`IDX_97672ac88f789774dd47f7c8be\` ON \`users\``);
        await queryRunner.query(`DROP INDEX \`IDX_2d4a15c7f8b3864a5465fb687e\` ON \`users\``);
        await queryRunner.query(`DROP INDEX \`IDX_c9b5b525a96ddc2c5647d7f7fa\` ON \`users\``);
        await queryRunner.query(`DROP TABLE \`users\``);
    }

}
