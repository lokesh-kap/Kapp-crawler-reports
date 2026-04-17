import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { CampaignInfo } from './campaign-info.entity';

@Entity('ads_mapping')
export class AdsMapping {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  mediumCode: string; // e.g. 'kcll', 'kapp02'

  @Column()
  clientId: number;

  @Column({ nullable: true })
  campaignInfoId: number;

  @ManyToOne(() => CampaignInfo, (info) => info.mappings, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'campaignInfoId' })
  campaignInfo: CampaignInfo;

  @Column({ type: 'text', nullable: true })
  notes: string;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
