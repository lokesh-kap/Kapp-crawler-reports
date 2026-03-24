import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  ProviderCredential,
  ProviderFilter,
} from '../../provider-config/entitites/provider-config.entity';

@Entity('client_wise')
export class ClientWiseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @Column({ type: 'varchar', length: 255 })
  name: string;

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

  @Column({ type: 'int' })
  client_id: number;

  @Column({ type: 'int' })
  year: number;

  @Column({ type: 'int' })
  user_id: number;

  @Column({ type: 'int', nullable: true })
  config_id: number | null;
}
