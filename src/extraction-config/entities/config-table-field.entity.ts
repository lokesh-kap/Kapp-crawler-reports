import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ConfigTableEntity } from './config-table.entity';

export type ExtractionFieldDataType = 'text' | 'attr';

@Entity('config_table_fields')
export class ConfigTableFieldEntity {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @ManyToOne(() => ConfigTableEntity, (table) => table.fields, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'table_id' })
  table: ConfigTableEntity;

  @Column({ type: 'int' })
  table_id: number;

  @Column({ type: 'varchar', length: 100 })
  field_key: string;

  @Column({ type: 'varchar', length: 100 })
  db_column: string;

  @Column({ type: 'text' })
  selector: string;

  @Column({ type: 'varchar', length: 20, default: 'text' })
  data_type: ExtractionFieldDataType;

  @Column({ type: 'varchar', length: 50, nullable: true })
  attribute: string | null;

  @Column({ type: 'int', default: 0 })
  sequence: number;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;
}

