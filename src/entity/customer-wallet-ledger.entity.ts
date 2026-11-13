import { CustomerWalletLedgerTypeEnum, CustomerWalletTransactionTypeEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

@Entity('customer_wallet_ledgers')
@Index('idx_wallet_ledger_shop_customer', ['shopId', 'customerId', 'createdAt'])
@Index('idx_wallet_ledger_shop_type', ['shopId', 'ledgerType', 'transactionType'])
export class CustomerWalletLedgerEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'customer_id', type: 'varchar', length: 36 })
  customerId: string;

  @Column({
    name: 'ledger_type',
    type: 'enum',
    enum: CustomerWalletLedgerTypeEnum,
    default: CustomerWalletLedgerTypeEnum.LOYALTY_POINT,
  })
  ledgerType: CustomerWalletLedgerTypeEnum;

  @Column({
    name: 'transaction_type',
    type: 'enum',
    enum: CustomerWalletTransactionTypeEnum,
    default: CustomerWalletTransactionTypeEnum.EARN_FROM_ORDER,
  })
  transactionType: CustomerWalletTransactionTypeEnum;

  @Column({
    name: 'delta_amount',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  deltaAmount: number;

  @Column({
    name: 'balance_after',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  balanceAfter: number;

  @Column({
    name: 'reference_order_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    default: null,
  })
  referenceOrderId: string | null;

  @Column({ name: 'note', type: 'text', nullable: true, default: null })
  note: string | null;

  @Column({ name: 'actor_user_id', type: 'varchar', length: 36, nullable: true, default: null })
  actorUserId: string | null;
}
