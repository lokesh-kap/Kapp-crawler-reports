import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { CampaignInfo } from './campaign-info.entity';

@Entity('campaign_metrics')
@Index(['campaignInfoId', 'date'], { unique: true })
export class CampaignMetrics {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'date' })
  date: string; // YYYY-MM-DD

  @Column({ type: 'bigint', default: 0, transformer: { to: (v) => v, from: (v) => Number(v) } })
  impressions: number;

  @Column({ type: 'bigint', default: 0, transformer: { to: (v) => v, from: (v) => Number(v) } })
  clicks: number;

  @Column({ type: 'decimal', precision: 6, scale: 4, default: 0, transformer: { to: (v) => v, from: (v) => Number(v) } })
  ctr: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0, transformer: { to: (v) => v, from: (v) => Number(v) } })
  avgCpc: number;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0, transformer: { to: (v) => v, from: (v) => Number(v) } })
  spend: number;

  @Column({ type: 'decimal', precision: 6, scale: 4, nullable: true, transformer: { to: (v) => v, from: (v) => Number(v) } })
  searchImpressionShare: number;

  @Column()
  campaignInfoId: number;

  @ManyToOne(() => CampaignInfo, (info) => info.metrics, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaignInfoId' })
  campaignInfo: CampaignInfo;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
