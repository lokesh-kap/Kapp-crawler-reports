import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('client_wise_leads_data')
export class ClientWiseLeadsDataEntity {
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

  // Lead columns (stored as text to tolerate varying formats)
  @Column({ type: 'text', nullable: true })
  name: string;

  @Column({ type: 'text', nullable: true })
  email: string;

  @Column({ type: 'text', nullable: true })
  mobile: string;

  @Column({ type: 'text', nullable: true })
  lead_origin: string;

  @Column({ type: 'text', nullable: true })
  country: string;

  @Column({ type: 'text', nullable: true })
  state: string;

  @Column({ type: 'text', nullable: true })
  city: string;

  @Column({ type: 'text', nullable: true })
  instance: string;

  @Column({ type: 'text', nullable: true })
  instance_date: string;

  @Column({ type: 'text', nullable: true })
  campaign: string;

  @Column({ type: 'text', nullable: true })
  lead_stage: string;

  @Column({ type: 'text', nullable: true })
  lead_status: string;

  @Column({ type: 'text', nullable: true })
  email_verification_status: string;

  @Column({ type: 'text', nullable: true })
  mobile_verification_status: string;

  @Column({ type: 'text', nullable: true })
  lead_score: string;

  @Column({ type: 'text', nullable: true })
  registration_device: string;

  @Column({ type: 'text', nullable: true })
  course_specialization: string;

  @Column({ type: 'text', nullable: true })
  campus: string;

  @Column({ type: 'text', nullable: true })
  last_lead_activity_date: string;

  @Column({ type: 'text', nullable: true })
  form_initiated: string;

  @Column({ type: 'text', nullable: true })
  paid_applications: string;

  @Column({ type: 'text', nullable: true })
  submitted_applications: string;

  @Column({ type: 'text', nullable: true })
  enrolment_status: string;

  @Column({ type: 'text', nullable: true })
  qualification_level: string;

  @Column({ type: 'text', nullable: true })
  program: string;

  @Column({ type: 'text', nullable: true })
  degree: string;

  @Column({ type: 'text', nullable: true })
  discipline: string;

  @Column({ type: 'jsonb', nullable: true })
  raw_data: Record<string, unknown>;
}

