import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ProviderFilter = {
  selector_type: string;
  name: string;
  delay?: number;
  xpath?: string;
};

export type ProviderCredential = {
  login: string;
  password: string;
  login_selector_type?: string;
  login_xpath?: string;
  password_selector_type?: string;
  password_xpath?: string;
  delay?: number;
};

@Entity('provider_config')
export class ProviderConfigEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'int', unique: true })
  config_id: number;

  @Column({ type: 'text' })
  url: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  filters: ProviderFilter[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  advance_filters: ProviderFilter[];

  @Column({ type: 'boolean', default: false })
  is_advance_filters: boolean;

  @Column({ type: 'jsonb', nullable: true })
  credentials: ProviderCredential | null;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;
}