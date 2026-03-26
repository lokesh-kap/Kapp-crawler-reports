import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ProviderConfigEntity } from './provider-config.entity';

export type ProviderStepConfigType = 'leads' | 'summary';
export type ProviderStepGroupType = 'normal' | 'advanced' | 'extra';
export type ProviderStepActionType =
  | 'click'
  | 'fill_text'
  | 'select'
  | 'searchable_dropdown'
  | 'checkbox'
  | 'radio'
  | 'submit'
  | 'wait_visible'
  | 'wait_hidden';

@Entity('provider_step')
export class ProviderStepEntity {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => ProviderConfigEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'provider_config_id' })
  provider_config: ProviderConfigEntity;

  @Column({ type: 'int' })
  provider_config_id: number;

  @Column({ type: 'int' })
  config_id: number;

  @Column({ type: 'varchar', length: 20 })
  config_type: ProviderStepConfigType;

  @Column({ type: 'varchar', length: 20, default: 'normal' })
  step_group: ProviderStepGroupType;

  @Column({ type: 'varchar', length: 30 })
  step_type: ProviderStepActionType;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string | null;

  @Column({ type: 'text' })
  xpath: string;

  @Column({ type: 'int', default: 0 })
  sequence: number;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  meta_data: Record<string, unknown>;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;
}

