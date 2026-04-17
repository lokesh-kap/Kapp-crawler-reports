import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { AdsCredential } from './ads-credential.entity';
import { AccountStatus, AdsProvider } from '../enums';

@Entity('ads_accounts')
export class AdsAccount {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column()
  externalCustomerId: string; // googleCustomerId, metaAccountId, etc.

  @Column()
  name: string;

  @Column({ default: 'INR' })
  currencyCode: string;

  @Column({ default: 'Asia/Kolkata' })
  timeZone: string;

  @Column({ nullable: true })
  resourceName: string;

  @Column({ default: false })
  isManager: boolean;

  @Column({ type: 'enum', enum: AccountStatus, default: AccountStatus.ENABLED })
  status: AccountStatus;

  @Column({ type: 'enum', enum: AdsProvider })
  provider: AdsProvider;

  // Self-referencing (Parent/MCC)
  @Column({ nullable: true })
  parentId: number;

  @ManyToOne(() => AdsAccount, { nullable: true })
  @JoinColumn({ name: 'parentId' })
  parent: AdsAccount;

  // Relation to credentials
  @Column()
  credentialId: number;

  @ManyToOne(() => AdsCredential)
  @JoinColumn({ name: 'credentialId' })
  credential: AdsCredential;

  @Column({ type: 'timestamp', nullable: true })
  lastSyncedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
