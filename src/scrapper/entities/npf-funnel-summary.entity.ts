import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('npf_funnel_summary')
@Index(['client_id', 'source', 'instance_filter', 'filter_applied', 'funnel_source'])
export class NpfFunnelSummaryEntity {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'int' })
  client_id: number;

  @Column({ type: 'int' })
  year: number;

  @Column({ type: 'text', nullable: true })
  source: string | null;

  @Column({ type: 'text', nullable: true })
  primary_leads: string | null;

  @Column({ type: 'text', nullable: true })
  secondary_leads: string | null;

  @Column({ type: 'text', nullable: true })
  tertiary_leads: string | null;

  @Column({ type: 'text', nullable: true })
  total_instances: string | null;

  @Column({ type: 'text', nullable: true })
  verified_leads: string | null;

  @Column({ type: 'text', nullable: true })
  unverified_leads: string | null;

  @Column({ type: 'text', nullable: true })
  form_initiated: string | null;

  @Column({ type: 'text', nullable: true })
  paid_applications: string | null;

  @Column({ type: 'text', nullable: true })
  submit_applications: string | null;

  @Column({ type: 'text', nullable: true })
  enrolments: string | null;

  @Column({ type: 'text', default: 'Instance' })
  instance_filter: string;

  @Column({ type: 'text', default: 'None' })
  filter_applied: string; // 'None', 'Paid Apps', 'Form Initiated'

  @Column({ type: 'text', default: 'campaign_view' })
  funnel_source: string; // 'lead_view', 'campaign_view'

  @Column({ type: 'jsonb', nullable: true })
  raw_data: Record<string, unknown>;
}
