import { MigrationInterface, QueryRunner } from 'typeorm';

export class AutoMigration1795244282508 implements MigrationInterface {
  name = 'AutoMigration1795244282508';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryRunner.query(`CREATE TABLE \`phone_reputation_ledgers\` (\`id\` varchar(36) NOT NULL, \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`created_by\` varchar(36) NULL, \`updated_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`updated_by\` varchar(36) NULL, \`deleted_at\` timestamp(6) NULL, \`deleted_by\` varchar(36) NULL, \`version\` int NOT NULL DEFAULT '1', \`phone_global_hash\` varchar(64) NOT NULL, \`phone_masked_hint\` varchar(32) NULL, \`total_delivered_count\` int NOT NULL DEFAULT '0', \`total_returned_count\` int NOT NULL DEFAULT '0', \`total_failed_attempt_count\` int NOT NULL DEFAULT '0', \`active_abuse_reports_count\` int NOT NULL DEFAULT '0', \`verified_abuse_reports_count\` int NOT NULL DEFAULT '0', \`unique_shops_delivered_json\` json NULL, \`unique_shops_returned_json\` json NULL, \`unique_shops_reported_json\` json NULL, \`carrier_breakdown_json\` json NULL, \`processed_orders_json\` json NULL, \`last_order_event_at\` datetime NULL, \`last_report_at\` datetime NULL, INDEX \`IDX_739187978aa3abaf39a6e1e37d\` (\`created_at\`), INDEX \`idx_phone_reputation_risk\` (\`total_returned_count\`, \`active_abuse_reports_count\`), UNIQUE INDEX \`uq_phone_reputation_global_hash\` (\`phone_global_hash\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    await queryRunner.query(`CREATE TABLE \`community_phone_abuse_reports\` (\`id\` varchar(36) NOT NULL, \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`created_by\` varchar(36) NULL, \`updated_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`updated_by\` varchar(36) NULL, \`deleted_at\` timestamp(6) NULL, \`deleted_by\` varchar(36) NULL, \`version\` int NOT NULL DEFAULT '1', \`phone_global_hash\` varchar(64) NOT NULL, \`phone_masked_hint\` varchar(32) NULL, \`reporter_shop_id\` varchar(36) NOT NULL, \`reporter_shop_alias\` varchar(120) NOT NULL, \`reporter_user_id\` varchar(36) NOT NULL, \`customer_id\` varchar(36) NULL, \`dedupe_key\` varchar(96) NOT NULL, \`reason_code\` varchar(48) NOT NULL DEFAULT 'BOM_HANG', \`reason_note\` text NOT NULL, \`source_code\` varchar(48) NOT NULL DEFAULT 'SHOP_INTERNAL', \`carrier_code\` varchar(32) NULL, \`order_code\` varchar(64) NULL, \`tracking_number\` varchar(64) NULL, \`verification_level\` varchar(32) NOT NULL DEFAULT 'SHOP_DECLARED', \`severity\` varchar(16) NOT NULL DEFAULT 'HIGH', \`status\` varchar(16) NOT NULL DEFAULT 'ACTIVE', \`retracted_by_user_id\` varchar(36) NULL, \`retracted_reason\` text NULL, \`retracted_at\` datetime NULL, INDEX \`IDX_4d4fbd8c10f111693ad8ea839f\` (\`created_at\`), UNIQUE INDEX \`uq_comm_abuse_dedupe\` (\`phone_global_hash\`, \`reporter_shop_id\`, \`dedupe_key\`), INDEX \`idx_comm_abuse_shop_hash\` (\`reporter_shop_id\`, \`phone_global_hash\`), INDEX \`idx_comm_abuse_global_hash_status\` (\`phone_global_hash\`, \`status\`, \`created_at\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    await queryRunner.query(`ALTER TABLE \`security_audit_logs\` ADD PRIMARY KEY (\`id\`)`);
    await queryRunner.query(`DROP INDEX \`IDX_5d512d651fc003ea089e125e5a\` ON \`messages\``);
    await queryRunner.query(`DROP INDEX \`idx_msg_shop_conv_created\` ON \`messages\``);
    await queryRunner.query(`ALTER TABLE \`inventory_movement_ledgers\` ADD PRIMARY KEY (\`id\`)`);
    await queryRunner.query(`DROP INDEX \`idx_webhook_status_created\` ON \`channel_webhook_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_call_part_conv_user\` ON \`call_participants\``);
    await queryRunner.query(`CREATE INDEX \`idx_msg_shop_conv_created\` ON \`messages\` (\`shop_id\`, \`conversationId\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`IDX_5d512d651fc003ea089e125e5a\` ON \`messages\` (\`conversationId\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_webhook_status_created\` ON \`channel_webhook_logs\` (\`shop_id\`, \`processing_status\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_call_part_conv_user\` ON \`call_participants\` (\`conversation_id\`, \`user_id\`, \`created_at\`)`);
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryRunner.query(`DROP INDEX \`idx_call_part_conv_user\` ON \`call_participants\``);
    await queryRunner.query(`DROP INDEX \`idx_webhook_status_created\` ON \`channel_webhook_logs\``);
    await queryRunner.query(`DROP INDEX \`IDX_5d512d651fc003ea089e125e5a\` ON \`messages\``);
    await queryRunner.query(`DROP INDEX \`idx_msg_shop_conv_created\` ON \`messages\``);
    await queryRunner.query(`CREATE INDEX \`idx_call_part_conv_user\` ON \`call_participants\` (\`conversation_id\`, \`user_id\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_webhook_status_created\` ON \`channel_webhook_logs\` (\`shop_id\`, \`processing_status\`, \`created_at\`)`);
    await queryRunner.query(`ALTER TABLE \`inventory_movement_ledgers\` DROP PRIMARY KEY`);
    await queryRunner.query(`CREATE INDEX \`idx_msg_shop_conv_created\` ON \`messages\` (\`shop_id\`, \`conversationId\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`IDX_5d512d651fc003ea089e125e5a\` ON \`messages\` (\`conversationId\`, \`created_at\`)`);
    await queryRunner.query(`ALTER TABLE \`security_audit_logs\` DROP PRIMARY KEY`);
    await queryRunner.query(`DROP INDEX \`idx_comm_abuse_global_hash_status\` ON \`community_phone_abuse_reports\``);
    await queryRunner.query(`DROP INDEX \`idx_comm_abuse_shop_hash\` ON \`community_phone_abuse_reports\``);
    await queryRunner.query(`DROP INDEX \`uq_comm_abuse_dedupe\` ON \`community_phone_abuse_reports\``);
    await queryRunner.query(`DROP INDEX \`IDX_4d4fbd8c10f111693ad8ea839f\` ON \`community_phone_abuse_reports\``);
    await queryRunner.query(`DROP TABLE \`community_phone_abuse_reports\``);
    await queryRunner.query(`DROP INDEX \`uq_phone_reputation_global_hash\` ON \`phone_reputation_ledgers\``);
    await queryRunner.query(`DROP INDEX \`idx_phone_reputation_risk\` ON \`phone_reputation_ledgers\``);
    await queryRunner.query(`DROP INDEX \`IDX_739187978aa3abaf39a6e1e37d\` ON \`phone_reputation_ledgers\``);
    await queryRunner.query(`DROP TABLE \`phone_reputation_ledgers\``);
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}
