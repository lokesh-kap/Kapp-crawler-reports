import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ProviderFilter } from '../../provider-config/entitites/provider-config.entity';
import { ClientWiseEntity } from './client-wise.entity';

@Entity('client_wise_leads_config')
export class ClientWiseLeadsConfigEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @Column({ type: 'int' })
  client_id: number;

  @Column({ type: 'int' })
  year: number;

  @Column({ type: 'int' })
  user_id: number;

  @Column({ type: 'int' })
  config_id: number;

  @ManyToOne(() => ClientWiseEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_wise_id' })
  client_wise: ClientWiseEntity;

  @Column({ type: 'int' })
  client_wise_id: number;

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
