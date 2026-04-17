import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index, OneToMany } from 'typeorm';
import { AdsAccount } from './ads-account.entity';
import { CampaignMetrics } from './campaign-metrics.entity';
import { CampaignStatus, CampaignType, BiddingStrategy, AdsProvider } from '../enums';
import { AdsMapping } from './ads-mapping.entity';

@Entity('campaign_info')
export class CampaignInfo {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column()
  externalCampaignId: string; // googleCampaignId, metaCampaignId, etc.

  @Column()
  name: string;

  @Column({ type: 'enum', enum: AdsProvider })
  provider: AdsProvider;

  @Column({ type: 'enum', enum: CampaignStatus, default: CampaignStatus.UNKNOWN })
  status: CampaignStatus;

  @Column({ type: 'enum', enum: CampaignType, nullable: true })
  campaignType: CampaignType;

  @Column({ type: 'enum', enum: BiddingStrategy, nullable: true })
  biddingStrategy: BiddingStrategy;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  optimizationScore: number;

  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  dailyBudget: number;

  @Column()
  adsAccountId: number;

  @ManyToOne(() => AdsAccount, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'adsAccountId' })
  adsAccount: AdsAccount;

  // Relation back to core Client/Institute
  @Column({ nullable: true })
  clientId: number;

  @OneToMany(() => AdsMapping, (mapping) => mapping.campaignInfo)
  mappings: AdsMapping[];

  @OneToMany(() => CampaignMetrics, (metrics) => metrics.campaignInfo)
  metrics: CampaignMetrics[];

  @Column({ type: 'timestamp', nullable: true })
  lastSyncedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
