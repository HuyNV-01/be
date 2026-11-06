import { MigrationInterface, QueryRunner } from 'typeorm';

export class AutoMigration1793963571892 implements MigrationInterface {
  name = 'AutoMigration1793963571892';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryRunner.query(`ALTER TABLE \`messages\` ADD \`shop_id\` varchar(36) NULL`);
    await queryRunner.query(`ALTER TABLE \`messages\` ADD \`direction\` enum ('INBOUND', 'OUTBOUND', 'INTERNAL_NOTE', 'SYSTEM') NOT NULL DEFAULT 'INBOUND'`);
    await queryRunner.query(`ALTER TABLE \`messages\` ADD \`external_message_id\` varchar(128) NULL`);
    await queryRunner.query(`ALTER TABLE \`messages\` ADD \`is_internal_note\` tinyint NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE \`messages\` ADD \`message_tag_ids_json\` json NULL`);
    await queryRunner.query(`ALTER TABLE \`messages\` ADD \`extracted_entities_json\` json NULL`);
    await queryRunner.query(`ALTER TABLE \`messages\` ADD \`ai_draft_confidence\` decimal(5,4) NULL`);
    await queryRunner.query(`ALTER TABLE \`messages\` ADD \`order_id_ref\` varchar(36) NULL`);
    await queryRunner.query(`DROP INDEX \`IDX_de962608d1d6cd6457cfa388c9\` ON \`notifications\``);
    await queryRunner.query(`ALTER TABLE \`notifications\` CHANGE \`type\` \`type\` enum ('NEW_MESSAGE', 'MESSAGE_REPLY', 'MESSAGE_MENTION', 'MESSAGE_REACTION', 'MESSAGE_PINNED', 'FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'GROUP_INVITE', 'GROUP_MEMBER_ADDED', 'MISSED_CALL', 'SHOP_INVITATION', 'SHOP_INVITATION_ACCEPTED', 'SHOP_JOIN_REQUEST', 'SHOP_JOIN_APPROVED', 'SHOP_JOIN_REJECTED', 'SHOP_ROLE_UPDATED', 'SHOP_MEMBER_STATUS_CHANGED', 'SHOP_SHIFT_HANDOVER', 'SHOP_FORCE_OFFLINE', 'SHOP_WORKSPACE_UPDATED', 'CHANNEL_CONNECTED', 'CHANNEL_TOKEN_WARNING', 'INBOX_CONVERSATION_ASSIGNED', 'INBOX_SLA_RECLAIMED', 'MARKETPLACE_ORDER_SYNCED', 'SYSTEM') NOT NULL DEFAULT 'SYSTEM'`);
    await queryRunner.query(`ALTER TABLE \`notifications\` CHANGE \`resource_type\` \`resource_type\` enum ('CONVERSATION', 'MESSAGE', 'CONTACT', 'CALL', 'USER', 'SHOP_WORKSPACE', 'SHOP_MEMBER', 'SHOP_INVITATION', 'CHANNEL_INTEGRATION', 'WEBHOOK_LOG', 'SYSTEM') NOT NULL DEFAULT 'SYSTEM'`);
    await queryRunner.query(`CREATE INDEX \`IDX_de962608d1d6cd6457cfa388c9\` ON \`notifications\` (\`recipient_id\`, \`resource_type\`, \`resource_id\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_msg_shop_conv_created\` ON \`messages\` (\`shop_id\`, \`conversationId\`, \`created_at\`)`);
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryRunner.query(`DROP INDEX \`idx_msg_shop_conv_created\` ON \`messages\``);
    await queryRunner.query(`DROP INDEX \`IDX_de962608d1d6cd6457cfa388c9\` ON \`notifications\``);
    await queryRunner.query(`ALTER TABLE \`notifications\` CHANGE \`resource_type\` \`resource_type\` enum ('CONVERSATION', 'MESSAGE', 'CONTACT', 'CALL', 'USER', 'SHOP_WORKSPACE', 'SHOP_MEMBER', 'SHOP_INVITATION', 'SYSTEM') NOT NULL DEFAULT 'SYSTEM'`);
    await queryRunner.query(`ALTER TABLE \`notifications\` CHANGE \`type\` \`type\` enum ('NEW_MESSAGE', 'MESSAGE_REPLY', 'MESSAGE_MENTION', 'MESSAGE_REACTION', 'MESSAGE_PINNED', 'FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'GROUP_INVITE', 'GROUP_MEMBER_ADDED', 'MISSED_CALL', 'SHOP_INVITATION', 'SHOP_INVITATION_ACCEPTED', 'SHOP_JOIN_REQUEST', 'SHOP_JOIN_APPROVED', 'SHOP_JOIN_REJECTED', 'SHOP_ROLE_UPDATED', 'SHOP_MEMBER_STATUS_CHANGED', 'SYSTEM') NOT NULL DEFAULT 'SYSTEM'`);
    await queryRunner.query(`CREATE INDEX \`IDX_de962608d1d6cd6457cfa388c9\` ON \`notifications\` (\`recipient_id\`, \`resource_type\`, \`resource_id\`)`);
    await queryRunner.query(`ALTER TABLE \`messages\` DROP COLUMN \`order_id_ref\``);
    await queryRunner.query(`ALTER TABLE \`messages\` DROP COLUMN \`ai_draft_confidence\``);
    await queryRunner.query(`ALTER TABLE \`messages\` DROP COLUMN \`extracted_entities_json\``);
    await queryRunner.query(`ALTER TABLE \`messages\` DROP COLUMN \`message_tag_ids_json\``);
    await queryRunner.query(`ALTER TABLE \`messages\` DROP COLUMN \`is_internal_note\``);
    await queryRunner.query(`ALTER TABLE \`messages\` DROP COLUMN \`external_message_id\``);
    await queryRunner.query(`ALTER TABLE \`messages\` DROP COLUMN \`direction\``);
    await queryRunner.query(`ALTER TABLE \`messages\` DROP COLUMN \`shop_id\``);
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}
