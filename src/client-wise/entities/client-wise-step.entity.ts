import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ClientWiseEntity } from './client-wise.entity';

export type StepConfigType = 'leads' | 'summary';
export type StepGroupType = 'normal' | 'advanced' | 'extra';
export type StepActionType =
  | 'click'
  | 'fill_text'
  | 'select'
  | 'searchable_dropdown'
  | 'checkbox'
  | 'radio'
  | 'submit'
  | 'wait_visible'
  | 'wait_hidden';

@Entity('client_wise_step')
export class ClientWiseStepEntity {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => ClientWiseEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_wise_id' })
  client_wise: ClientWiseEntity;

  @Column({ type: 'int' })
  client_wise_id: number;

  @Column({ type: 'varchar', length: 20 })
  config_type: StepConfigType;

  @Column({ type: 'varchar', length: 20, default: 'normal' })
  step_group: StepGroupType;

  @Column({ type: 'varchar', length: 30 })
  step_type: StepActionType;

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

