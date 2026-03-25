import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ProviderConfigEntity, ProviderFilter } from './provider-config.entity';

@Entity('provider_leads_config')
export class ProviderLeadsConfigEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @Column({ type: 'int', unique: true })
  config_id: number;

  @ManyToOne(() => ProviderConfigEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'provider_config_id' })
  provider_config: ProviderConfigEntity;

  @Column({ type: 'int' })
  provider_config_id: number;

  @Column({ type: 'text' })
  url: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  filters: ProviderFilter[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  advance_filters: ProviderFilter[];

  @Column({ type: 'boolean', default: false })
  is_advance_filters: boolean;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;
}
