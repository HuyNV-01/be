import { MigrationInterface, QueryRunner } from 'typeorm';

export class AutoMigration1793878662515 implements MigrationInterface {
  name = 'AutoMigration1793878662515';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryRunner.query(`CREATE TABLE \`channel_integrations\` (\`id\` varchar(36) NOT NULL, \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`created_by\` varchar(36) NULL, \`updated_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`updated_by\` varchar(36) NULL, \`deleted_at\` timestamp(6) NULL, \`deleted_by\` varchar(36) NULL, \`version\` int NOT NULL DEFAULT '1', \`shop_id\` varchar(36) NOT NULL, \`channel_type\` enum ('INTERNAL', 'FACEBOOK_PAGE', 'INSTAGRAM', 'ZALO_OA', 'TIKTOK_SHOP', 'SHOPEE', 'LAZADA', 'WEBSITE_LIVECHAT') NOT NULL, \`external_page_id\` varchar(128) NOT NULL, \`external_shop_id\` varchar(128) NULL, \`page_name\` varchar(200) NOT NULL, \`page_short_code\` varchar(24) NOT NULL, \`avatar_url\` varchar(500) NULL, \`access_token_encrypted\` text NOT NULL, \`refresh_token_encrypted\` text NULL, \`webhook_verify_secret_encrypted\` text NULL, \`meta_dataset_id\` varchar(128) NULL, \`capi_access_token_encrypted\` text NULL, \`token_expires_at\` datetime NULL, \`webhook_status\` enum ('HEALTHY', 'TOKEN_EXPIRING_SOON', 'TOKEN_EXPIRED', 'WEBHOOK_DISCONNECTED', 'RATE_LIMITED') NOT NULL DEFAULT 'HEALTHY', \`last_webhook_received_at\` datetime NULL, \`last_error_message\` varchar(500) NULL, \`is_active\` tinyint NOT NULL DEFAULT 1, INDEX \`IDX_1266d2ff6085ec3f38ddb35605\` (\`created_at\`), INDEX \`idx_channel_webhook_lookup\` (\`channel_type\`, \`external_page_id\`), UNIQUE INDEX \`uq_channel_ext_page\` (\`shop_id\`, \`channel_type\`, \`external_page_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    await queryRunner.query(`CREATE TABLE \`channel_webhook_logs\` (\`id\` varchar(36) NOT NULL, \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`created_by\` varchar(36) NULL, \`updated_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`updated_by\` varchar(36) NULL, \`deleted_at\` timestamp(6) NULL, \`deleted_by\` varchar(36) NULL, \`version\` int NOT NULL DEFAULT '1', \`shop_id\` varchar(36) NULL, \`channel_integration_id\` varchar(36) NULL, \`channel_type\` enum ('INTERNAL', 'FACEBOOK_PAGE', 'INSTAGRAM', 'ZALO_OA', 'TIKTOK_SHOP', 'SHOPEE', 'LAZADA', 'WEBSITE_LIVECHAT') NOT NULL DEFAULT 'FACEBOOK_PAGE', \`idempotency_key\` varchar(160) NOT NULL, \`event_type\` varchar(100) NOT NULL, \`headers_json\` json NOT NULL, \`raw_payload_json\` json NOT NULL, \`processing_status\` enum ('RECEIVED', 'PROCESSED', 'DUPLICATE_SKIPPED', 'FAILED_DLQ', 'REPLAYED_SUCCESS') NOT NULL DEFAULT 'RECEIVED', \`processing_duration_ms\` int NOT NULL DEFAULT '0', \`error_stack\` text NULL, \`replayed_count\` int NOT NULL DEFAULT '0', INDEX \`IDX_fc7348516f050a7e9ee44d12b8\` (\`created_at\`), INDEX \`idx_webhook_status_created\` (\`shop_id\`, \`processing_status\`, \`created_at\`), INDEX \`idx_webhook_dedupe_lookup\` (\`shop_id\`, \`channel_type\`, \`idempotency_key\`), INDEX \`idx_channel_webhook_logs_id_lookup\` (\`id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`shop_id\` varchar(36) NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`channel_type\` enum ('INTERNAL', 'FACEBOOK_PAGE', 'INSTAGRAM', 'ZALO_OA', 'TIKTOK_SHOP', 'SHOPEE', 'LAZADA', 'WEBSITE_LIVECHAT') NOT NULL DEFAULT 'INTERNAL'`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`channel_integration_id\` varchar(36) NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`external_thread_id\` varchar(128) NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`customer_id\` varchar(36) NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`assigned_agent_id\` varchar(36) NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`support_status\` enum ('NEW', 'WAITING_AGENT_REPLY', 'WAITING_CUSTOMER_REPLY', 'SNOOZED', 'RESOLVED') NOT NULL DEFAULT 'NEW'`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`ai_handling_mode\` enum ('AUTOPILOT', 'COPILOT', 'HUMAN_ONLY') NOT NULL DEFAULT 'COPILOT'`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`sla_deadline_at\` datetime NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`last_customer_message_at\` datetime NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`last_agent_reply_at\` datetime NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`first_seen_by_agent_id\` varchar(36) NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`first_seen_at\` datetime NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`has_phone_collected\` tinyint NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`has_order_created\` tinyint NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`source_post_id\` varchar(128) NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`source_ad_id\` varchar(128) NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`ctwa_click_id\` varchar(255) NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`active_tag_ids_json\` json NULL`);
    await queryRunner.query(`ALTER TABLE \`conversations\` ADD \`snoozed_until_at\` datetime NULL`);
    await queryRunner.query(`DROP INDEX \`IDX_de962608d1d6cd6457cfa388c9\` ON \`notifications\``);
    await queryRunner.query(`ALTER TABLE \`notifications\` CHANGE \`type\` \`type\` enum ('NEW_MESSAGE', 'MESSAGE_REPLY', 'MESSAGE_MENTION', 'MESSAGE_REACTION', 'MESSAGE_PINNED', 'FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'GROUP_INVITE', 'GROUP_MEMBER_ADDED', 'MISSED_CALL', 'SHOP_INVITATION', 'SHOP_INVITATION_ACCEPTED', 'SHOP_JOIN_REQUEST', 'SHOP_JOIN_APPROVED', 'SHOP_JOIN_REJECTED', 'SHOP_ROLE_UPDATED', 'SHOP_MEMBER_STATUS_CHANGED', 'SYSTEM') NOT NULL DEFAULT 'SYSTEM'`);
    await queryRunner.query(`ALTER TABLE \`notifications\` CHANGE \`resource_type\` \`resource_type\` enum ('CONVERSATION', 'MESSAGE', 'CONTACT', 'CALL', 'USER', 'SHOP_WORKSPACE', 'SHOP_MEMBER', 'SHOP_INVITATION', 'SYSTEM') NOT NULL DEFAULT 'SYSTEM'`);
    await queryRunner.query(`CREATE INDEX \`idx_conv_shop_channel_assigned\` ON \`conversations\` (\`shop_id\`, \`channel_integration_id\`, \`assigned_agent_id\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_conv_shop_support_sla\` ON \`conversations\` (\`shop_id\`, \`support_status\`, \`sla_deadline_at\`)`);
    await queryRunner.query(`CREATE INDEX \`IDX_de962608d1d6cd6457cfa388c9\` ON \`notifications\` (\`recipient_id\`, \`resource_type\`, \`resource_id\`)`);
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryRunner.query(`DROP INDEX \`IDX_de962608d1d6cd6457cfa388c9\` ON \`notifications\``);
    await queryRunner.query(`DROP INDEX \`idx_conv_shop_support_sla\` ON \`conversations\``);
    await queryRunner.query(`DROP INDEX \`idx_conv_shop_channel_assigned\` ON \`conversations\``);
    await queryRunner.query(`ALTER TABLE \`notifications\` CHANGE \`resource_type\` \`resource_type\` enum ('CONVERSATION', 'MESSAGE', 'CONTACT', 'CALL', 'USER', 'SYSTEM') NOT NULL DEFAULT 'SYSTEM'`);
    await queryRunner.query(`ALTER TABLE \`notifications\` CHANGE \`type\` \`type\` enum ('NEW_MESSAGE', 'MESSAGE_REPLY', 'MESSAGE_MENTION', 'MESSAGE_REACTION', 'MESSAGE_PINNED', 'FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'GROUP_INVITE', 'GROUP_MEMBER_ADDED', 'MISSED_CALL', 'SYSTEM') NOT NULL DEFAULT 'SYSTEM'`);
    await queryRunner.query(`CREATE INDEX \`IDX_de962608d1d6cd6457cfa388c9\` ON \`notifications\` (\`recipient_id\`, \`resource_type\`, \`resource_id\`)`);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`snoozed_until_at\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`active_tag_ids_json\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`ctwa_click_id\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`source_ad_id\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`source_post_id\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`has_order_created\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`has_phone_collected\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`first_seen_at\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`first_seen_by_agent_id\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`last_agent_reply_at\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`last_customer_message_at\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`sla_deadline_at\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`ai_handling_mode\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`support_status\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`assigned_agent_id\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`customer_id\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`external_thread_id\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`channel_integration_id\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`channel_type\``);
    await queryRunner.query(`ALTER TABLE \`conversations\` DROP COLUMN \`shop_id\``);
    await queryRunner.query(`DROP INDEX \`idx_channel_webhook_logs_id_lookup\` ON \`channel_webhook_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_webhook_dedupe_lookup\` ON \`channel_webhook_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_webhook_status_created\` ON \`channel_webhook_logs\``);
    await queryRunner.query(`DROP INDEX \`IDX_fc7348516f050a7e9ee44d12b8\` ON \`channel_webhook_logs\``);
    await queryRunner.query(`DROP TABLE \`channel_webhook_logs\``);
    await queryRunner.query(`DROP INDEX \`uq_channel_ext_page\` ON \`channel_integrations\``);
    await queryRunner.query(`DROP INDEX \`idx_channel_webhook_lookup\` ON \`channel_integrations\``);
    await queryRunner.query(`DROP INDEX \`IDX_1266d2ff6085ec3f38ddb35605\` ON \`channel_integrations\``);
    await queryRunner.query(`DROP TABLE \`channel_integrations\``);
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}
