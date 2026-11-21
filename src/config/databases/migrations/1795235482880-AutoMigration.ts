import { MigrationInterface, QueryRunner } from 'typeorm';

export class AutoMigration1795235482880 implements MigrationInterface {
  name = 'AutoMigration1795235482880';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryRunner.query(`CREATE TABLE \`carrier_handover_manifests\` (\`id\` varchar(36) NOT NULL, \`created_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`created_by\` varchar(36) NULL, \`updated_at\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`updated_by\` varchar(36) NULL, \`deleted_at\` timestamp(6) NULL, \`deleted_by\` varchar(36) NULL, \`version\` int NOT NULL DEFAULT '1', \`shop_id\` varchar(36) NOT NULL, \`manifest_code\` varchar(48) NOT NULL, \`warehouse_id\` varchar(36) NOT NULL, \`warehouse_name\` varchar(150) NOT NULL DEFAULT '', \`carrier_code\` varchar(24) NOT NULL, \`status\` enum ('DRAFT_SCANNING', 'SEALED_HANDED_OVER', 'CANCELLED') NOT NULL DEFAULT 'DRAFT_SCANNING', \`courier_driver_name\` varchar(120) NULL, \`courier_driver_phone\` varchar(32) NULL, \`courier_vehicle_plate\` varchar(32) NULL, \`scanned_orders_json\` json NOT NULL, \`total_parcels_count\` int NOT NULL DEFAULT '0', \`total_weight_grams\` int NOT NULL DEFAULT '0', \`total_cod_amount\` decimal(15,2) NOT NULL DEFAULT '0.00', \`sealed_by_user_id\` varchar(36) NULL, \`sealed_at\` timestamp NULL, \`note\` text NULL, INDEX \`IDX_a170a56e1e998bea4d875f0fc1\` (\`created_at\`), INDEX \`idx_handover_manifest_carrier\` (\`shop_id\`, \`carrier_code\`, \`created_at\`), INDEX \`idx_handover_manifest_shop_status\` (\`shop_id\`, \`status\`, \`created_at\`), UNIQUE INDEX \`uq_handover_manifest_shop_code\` (\`shop_id\`, \`manifest_code\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` ADD \`order_tags_json\` json NULL`);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` ADD \`sub_status\` varchar(64) NULL`);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` ADD \`call_later_at\` timestamp NULL`);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` ADD \`call_attempt_count\` int NOT NULL DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` ADD \`last_call_note\` text NULL`);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` ADD \`handover_manifest_id\` varchar(36) NULL`);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` ADD \`partial_delivery_info_json\` json NULL`);
    await queryRunner.query(`DROP INDEX \`idx_sec_audit_shop_action\` ON \`security_audit_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_sec_audit_shop_actor\` ON \`security_audit_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_sec_audit_shop_created\` ON \`security_audit_logs\``);
    await queryRunner.query(`ALTER TABLE \`security_audit_logs\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`security_audit_logs\` ADD PRIMARY KEY (\`id\`)`);
    await queryRunner.query(`DROP INDEX \`IDX_5d512d651fc003ea089e125e5a\` ON \`messages\``);
    await queryRunner.query(`DROP INDEX \`idx_msg_shop_conv_created\` ON \`messages\``);
    await queryRunner.query(`DROP INDEX \`idx_inv_ledger_shop_wh_var\` ON \`inventory_movement_ledgers\``);
    await queryRunner.query(`ALTER TABLE \`inventory_movement_ledgers\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`inventory_movement_ledgers\` ADD PRIMARY KEY (\`id\`)`);
    await queryRunner.query(`DROP INDEX \`idx_webhook_status_created\` ON \`channel_webhook_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_call_part_conv_user\` ON \`call_participants\``);
    await queryRunner.query(`CREATE INDEX \`idx_sec_audit_shop_actor\` ON \`security_audit_logs\` (\`shop_id\`, \`actor_user_id\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_sec_audit_shop_action\` ON \`security_audit_logs\` (\`shop_id\`, \`action_code\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_sec_audit_shop_created\` ON \`security_audit_logs\` (\`shop_id\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_msg_shop_conv_created\` ON \`messages\` (\`shop_id\`, \`conversationId\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`IDX_5d512d651fc003ea089e125e5a\` ON \`messages\` (\`conversationId\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_inv_ledger_shop_wh_var\` ON \`inventory_movement_ledgers\` (\`shop_id\`, \`warehouse_id\`, \`variant_id\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_webhook_status_created\` ON \`channel_webhook_logs\` (\`shop_id\`, \`processing_status\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_call_part_conv_user\` ON \`call_participants\` (\`conversation_id\`, \`user_id\`, \`created_at\`)`);
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    await queryRunner.query(`DROP INDEX \`idx_call_part_conv_user\` ON \`call_participants\``);
    await queryRunner.query(`DROP INDEX \`idx_webhook_status_created\` ON \`channel_webhook_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_inv_ledger_shop_wh_var\` ON \`inventory_movement_ledgers\``);
    await queryRunner.query(`DROP INDEX \`IDX_5d512d651fc003ea089e125e5a\` ON \`messages\``);
    await queryRunner.query(`DROP INDEX \`idx_msg_shop_conv_created\` ON \`messages\``);
    await queryRunner.query(`DROP INDEX \`idx_sec_audit_shop_created\` ON \`security_audit_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_sec_audit_shop_action\` ON \`security_audit_logs\``);
    await queryRunner.query(`DROP INDEX \`idx_sec_audit_shop_actor\` ON \`security_audit_logs\``);
    await queryRunner.query(`CREATE INDEX \`idx_call_part_conv_user\` ON \`call_participants\` (\`conversation_id\`, \`user_id\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_webhook_status_created\` ON \`channel_webhook_logs\` (\`shop_id\`, \`processing_status\`, \`created_at\`)`);
    await queryRunner.query(`ALTER TABLE \`inventory_movement_ledgers\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`inventory_movement_ledgers\` ADD PRIMARY KEY (\`created_at\`, \`id\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_inv_ledger_shop_wh_var\` ON \`inventory_movement_ledgers\` (\`shop_id\`, \`warehouse_id\`, \`variant_id\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_msg_shop_conv_created\` ON \`messages\` (\`shop_id\`, \`conversationId\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`IDX_5d512d651fc003ea089e125e5a\` ON \`messages\` (\`conversationId\`, \`created_at\`)`);
    await queryRunner.query(`ALTER TABLE \`security_audit_logs\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`security_audit_logs\` ADD PRIMARY KEY (\`created_at\`, \`id\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_sec_audit_shop_created\` ON \`security_audit_logs\` (\`shop_id\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_sec_audit_shop_actor\` ON \`security_audit_logs\` (\`shop_id\`, \`actor_user_id\`, \`created_at\`)`);
    await queryRunner.query(`CREATE INDEX \`idx_sec_audit_shop_action\` ON \`security_audit_logs\` (\`shop_id\`, \`action_code\`, \`created_at\`)`);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` DROP COLUMN \`partial_delivery_info_json\``);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` DROP COLUMN \`handover_manifest_id\``);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` DROP COLUMN \`last_call_note\``);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` DROP COLUMN \`call_attempt_count\``);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` DROP COLUMN \`call_later_at\``);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` DROP COLUMN \`sub_status\``);
    await queryRunner.query(`ALTER TABLE \`pos_orders\` DROP COLUMN \`order_tags_json\``);
    await queryRunner.query(`DROP INDEX \`uq_handover_manifest_shop_code\` ON \`carrier_handover_manifests\``);
    await queryRunner.query(`DROP INDEX \`idx_handover_manifest_shop_status\` ON \`carrier_handover_manifests\``);
    await queryRunner.query(`DROP INDEX \`idx_handover_manifest_carrier\` ON \`carrier_handover_manifests\``);
    await queryRunner.query(`DROP INDEX \`IDX_a170a56e1e998bea4d875f0fc1\` ON \`carrier_handover_manifests\``);
    await queryRunner.query(`DROP TABLE \`carrier_handover_manifests\``);
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}
