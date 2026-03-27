import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ConfigTableFieldEntity } from './config-table-field.entity';

export type ExtractionConfigType = 'leads' | 'summary';

@Entity('config_tables')
export class ConfigTableEntity {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'varchar', length: 20 })
  config_type: ExtractionConfigType;

  @Column({ type: 'int' })
  config_id: number;

  @Column({ type: 'text' })
  row_selector: string;

  @Column({ type: 'text', nullable: true })
  next_selector: string | null;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @CreateDateColumn({ type: 'timestamp', default: () => 'NOW()' })
  created_at: Date;

  @OneToMany(() => ConfigTableFieldEntity, (field) => field.table, {
    cascade: ['remove'],
  })
  fields: ConfigTableFieldEntity[];
}

