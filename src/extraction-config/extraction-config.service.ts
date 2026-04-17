import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { ConfigTableEntity } from './entities/config-table.entity';
import { ConfigTableFieldEntity } from './entities/config-table-field.entity';
import { CreateConfigTableDto } from './dto/create-config-table.dto';
import { CreateConfigTableFieldDto } from './dto/create-config-table-field.dto';

@Injectable()
export class ExtractionConfigService {
  constructor(
    @InjectRepository(ConfigTableEntity)
    private readonly configTableRepository: Repository<ConfigTableEntity>,
    @InjectRepository(ConfigTableFieldEntity)
    private readonly configTableFieldRepository: Repository<ConfigTableFieldEntity>,
  ) {}

  async createTable(payload: CreateConfigTableDto) {
    const row = this.configTableRepository.create({
      ...payload,
      is_active: payload.is_active ?? true,
      next_selector: payload.next_selector ?? null,
    });
    return this.configTableRepository.save(row);
  }

  async updateTable(id: number, payload: Partial<CreateConfigTableDto>) {
    const existing = await this.configTableRepository.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`config_table with id=${id} not found`);
    }
    const merged = this.configTableRepository.merge(existing, payload);
    return this.configTableRepository.save(merged);
  }

  async createTableField(payload: CreateConfigTableFieldDto) {
    const table = await this.configTableRepository.findOne({
      where: { id: payload.table_id },
    });
    if (!table) {
      throw new NotFoundException(`config_table with id=${payload.table_id} not found`);
    }
    const field = this.configTableFieldRepository.create({
      ...payload,
      data_type: payload.data_type ?? 'text',
      attribute: payload.attribute ?? null,
      sequence: payload.sequence ?? 0,
      is_active: payload.is_active ?? true,
    });
    return this.configTableFieldRepository.save(field);
  }

  async upsertTableFields(
    tableId: number,
    fields: Array<{
      field_key?: unknown;
      db_column?: unknown;
      selector?: unknown;
      data_type?: unknown;
      attribute?: unknown;
      sequence?: unknown;
      is_active?: unknown;
    }>,
  ) {
    const table = await this.configTableRepository.findOne({ where: { id: tableId } });
    if (!table) {
      throw new NotFoundException(`config_table with id=${tableId} not found`);
    }

    await this.configTableFieldRepository.delete({ table_id: tableId });
    const toSave: DeepPartial<ConfigTableFieldEntity>[] = fields
      .filter(
        (item) =>
          String(item?.field_key ?? '').trim().length > 0 &&
          String(item?.db_column ?? '').trim().length > 0 &&
          String(item?.selector ?? '').trim().length > 0,
      )
      .map((item, idx) => ({
        field_key: String(item.field_key).trim(),
        db_column: String(item.db_column).trim(),
        selector: String(item.selector).trim(),
        table_id: tableId,
        data_type: item.data_type === 'attr' ? 'attr' : 'text',
        attribute:
          item.data_type === 'attr' && String(item.attribute ?? '').trim().length > 0
            ? String(item.attribute).trim()
            : null,
        sequence:
          Number.isFinite(Number(item.sequence)) && Number(item.sequence) >= 0
            ? Number(item.sequence)
            : idx,
        is_active: typeof item.is_active === 'boolean' ? item.is_active : true,
      }));
    return this.configTableFieldRepository.save(toSave);
  }

  getTableById(id: number) {
    return this.configTableRepository.findOne({ where: { id } });
  }

  getTableByConfigId(configId: number, configType?: 'leads' | 'summary' | 'npf_funnel') {
    return this.configTableRepository.findOne({
      where: {
        config_id: configId,
        ...(configType ? { config_type: configType } : {}),
      },
      order: { id: 'DESC' },
    });
  }

  getFieldsByTableId(tableId: number) {
    return this.configTableFieldRepository.find({
      where: { table_id: tableId },
      order: { sequence: 'ASC', id: 'ASC' },
    });
  }

  async getActiveTableByConfig(configType: 'leads' | 'summary' | 'npf_funnel', configId: number) {
    return this.configTableRepository.findOne({
      where: {
        config_type: configType,
        config_id: configId,
        is_active: true,
      },
      order: { id: 'DESC' },
    });
  }

  getActiveFieldsByTableId(tableId: number) {
    return this.configTableFieldRepository.find({
      where: { table_id: tableId, is_active: true },
      order: { sequence: 'ASC', id: 'ASC' },
    });
  }
}

