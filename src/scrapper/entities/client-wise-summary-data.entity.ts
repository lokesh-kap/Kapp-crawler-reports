import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('client_wise_summary_data')
export class ClientWiseSummaryDataEntity {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'int' })
  client_id: number;

  @Column({ type: 'int' })
  year: number;

  @Column({ type: 'int' })
  user_id: number;

  @Column({ type: 'int' })
  config_id: number;

  // Summary columns (stored as text to tolerate varying formats)
  @Column({ type: 'text', nullable: true })
  source: string;

  @Column({ type: 'text', nullable: true })
  medium: string;

  @Column({ type: 'text', nullable: true })
  campaign_name: string;

  @Column({ type: 'text', nullable: true })
  primary_leads: string;

  @Column({ type: 'text', nullable: true })
  secondary_leads: string;

  @Column({ type: 'text', nullable: true })
  tertiary_leads: string;

  @Column({ type: 'text', nullable: true })
  total_instances: string;

  @Column({ type: 'text', nullable: true })
  verified_leads: string;

  @Column({ type: 'text', nullable: true })
  unverified_leads: string;

  @Column({ type: 'text', nullable: true })
  form_initiated: string;

  @Column({ type: 'text', nullable: true })
  payment_approved: string;

  @Column({ type: 'text', nullable: true })
  enrolments: string;

  @Column({ type: 'jsonb', nullable: true })
  raw_data: Record<string, unknown>;
}

