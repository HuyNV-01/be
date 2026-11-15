import { MigrationInterface, QueryRunner } from 'typeorm';

export class AutoMigration1794714283067 implements MigrationInterface {
  name = 'AutoMigration1794714283067';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryRunner.query(`ALTER TABLE \`customer_profiles\` ADD \`default_hamlet_code\` varchar(48) NULL`);
    await queryRunner.query(`ALTER TABLE \`customer_profiles\` ADD \`default_hamlet_name\` varchar(150) NULL`);
    await queryRunner.query(`DROP INDEX \`idx_sec_audit_shop_action\` ON \`security_audit_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_sec_audit_shop_actor\` ON \`security_audit_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_sec_audit_shop_created\` ON \`security_audit_logs\``);
    await queryRunner.query(`ALTER TABLE \`security_audit_logs\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`security_audit_logs\` ADD PRIMARY KEY (\`id\`)`);
    await queryRunner.query(`ALTER TABLE \`security_audit_logs\` CHANGE \`action_code\` \`action_code\` enum ('UNMASK_PHONE', 'EXPORT_CUSTOMERS', 'OVERRIDE_DISCOUNT', 'MERGE_CUSTOMER', 'BLACKLIST_TOGGLE', 'TRUST_SCORE_OVERRIDE', 'PHONE_ABUSE_REPORT', 'CRM_SETTINGS_UPDATE', 'WALLET_MANUAL_ADJUST', 'CAPI_CONFIG_UPDATE', 'MODIFY_CONFIRMED_ORDER', 'ADJUST_STOCK', 'UPDATE_IAM_PERMISSIONS') NOT NULL`);
    await queryRunner.query(`DROP INDEX \`IDX_5d512d651fc003ea089e125e5a\` ON \`messages\``);
    await queryRunner.query(`DROP INDEX \`idx_msg_shop_conv_created\` ON \`messages\``);
    await queryRunner.query(`DROP INDEX \`idx_webhook_status_created\` ON \`channel_webhook_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_call_part_conv_user\` ON \`call_participants\``);
    await queryRunner.query(`CREATE INDEX \`idx_sec_audit_shop_actor\` ON \`security_audit_logs\` (\`shop_id\`, \`actor_user_id\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_sec_audit_shop_action\` ON \`security_audit_logs\` (\`shop_id\`, \`action_code\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_sec_audit_shop_created\` ON \`security_audit_logs\` (\`shop_id\`, \`created_at\`)`);
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
    await queryRunner.query(`DROP INDEX \`idx_sec_audit_shop_created\` ON \`security_audit_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_sec_audit_shop_action\` ON \`security_audit_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_sec_audit_shop_actor\` ON \`security_audit_logs\``);
    await queryRunner.query(`CREATE INDEX \`idx_call_part_conv_user\` ON \`call_participants\` (\`conversation_id\`, \`user_id\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_webhook_status_created\` ON \`channel_webhook_logs\` (\`shop_id\`, \`processing_status\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_msg_shop_conv_created\` ON \`messages\` (\`shop_id\`, \`conversationId\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`IDX_5d512d651fc003ea089e125e5a\` ON \`messages\` (\`conversationId\`, \`created_at\`)`);
    await queryRunner.query(`ALTER TABLE \`security_audit_logs\` CHANGE \`action_code\` \`action_code\` enum ('UNMASK_PHONE', 'EXPORT_CUSTOMERS', 'OVERRIDE_DISCOUNT', 'MERGE_CUSTOMER', 'BLACKLIST_TOGGLE', 'TRUST_SCORE_OVERRIDE', 'PHONE_ABUSE_REPORT', 'CRM_SETTINGS_UPDATE', 'WALLET_MANUAL_ADJUST', 'CAPI_CONFIG_UPDATE', 'MODIFY_CONFIRMED_ORDER', 'ADJUST_STOCK', 'UPDATE_IAM_PERMISSIONS') NOT NULL DEFAULT 'UNMASK_PHONE'`);
    await queryRunner.query(`ALTER TABLE \`security_audit_logs\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`security_audit_logs\` ADD PRIMARY KEY (\`created_at\`, \`id\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_sec_audit_shop_created\` ON \`security_audit_logs\` (\`shop_id\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_sec_audit_shop_actor\` ON \`security_audit_logs\` (\`shop_id\`, \`actor_user_id\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_sec_audit_shop_action\` ON \`security_audit_logs\` (\`shop_id\`, \`action_code\`, \`created_at\`)`);
    await queryRunner.query(`ALTER TABLE \`customer_profiles\` DROP COLUMN \`default_hamlet_name\``);
    await queryRunner.query(`ALTER TABLE \`customer_profiles\` DROP COLUMN \`default_hamlet_code\``);
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}
