import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProviderConfigEntity } from './entitites/provider-config.entity';
import { CreateProviderConfigDto } from './dto/create-provider-config.dto';
import { UpdateProviderConfigDto } from './dto/update-provider-config.dto';
import { ProviderLeadsConfigEntity } from './entitites/provider-leads-config.entity';
import { ProviderSummaryConfigEntity } from './entitites/provider-summary-config.entity';
import { UpsertProviderScraperConfigDto } from './dto/upsert-provider-scraper-config.dto';
import { ProviderStepEntity } from './entitites/provider-step.entity';

@Injectable()
export class ProviderConfigService {
  constructor(
    @InjectRepository(ProviderConfigEntity)
    private readonly providerConfigRepository: Repository<ProviderConfigEntity>,
    @InjectRepository(ProviderLeadsConfigEntity)
    private readonly providerLeadsConfigRepository: Repository<ProviderLeadsConfigEntity>,
    @InjectRepository(ProviderSummaryConfigEntity)
    private readonly providerSummaryConfigRepository: Repository<ProviderSummaryConfigEntity>,
    @InjectRepository(ProviderStepEntity)
    private readonly providerStepRepository: Repository<ProviderStepEntity>,
  ) {}

  create(createProviderConfigDto: CreateProviderConfigDto) {
    const payload = this.providerConfigRepository.create({
      ...createProviderConfigDto,
      is_active: createProviderConfigDto.is_active ?? true,
      credentials: createProviderConfigDto.credentials ?? null,
    });
    return this.providerConfigRepository.save(payload);
  }

  findAll() {
    return this.providerConfigRepository.find({
      order: { created_at: 'DESC' },
    });
  }

  async providerOptions() {
    const rows = await this.providerConfigRepository.find({
      select: {
        id: true,
        name: true,
        config_id: true,
        is_active: true,
      },
      order: { name: 'ASC' },
    });
    return rows;
  }

  async getLeadsConfigByConfigId(config_id: number) {
    const config = await this.providerLeadsConfigRepository.findOne({ where: { config_id } });
    if (!config) return null;
    const steps = await this.getStepGroups(config.provider_config_id, config_id, 'leads');
    return { ...config, ...steps };
  }

  async getSummaryConfigByConfigId(config_id: number) {
    const config = await this.providerSummaryConfigRepository.findOne({ where: { config_id } });
    if (!config) return null;
    const steps = await this.getStepGroups(config.provider_config_id, config_id, 'summary');
    return { ...config, ...steps };
  }

  private async getStepGroups(providerConfigId: number, configId: number, configType: 'leads' | 'summary') {
    const rows = await this.providerStepRepository.find({
      where: { provider_config_id: providerConfigId, config_id: configId, config_type: configType, is_active: true },
      order: { sequence: 'ASC', id: 'ASC' },
    });
    return {
      normal_steps: rows.filter((x) => x.step_group === 'normal'),
      advanced_steps: rows.filter((x) => x.step_group === 'advanced'),
      extra_steps: rows.filter((x) => x.step_group === 'extra'),
    };
  }

  private async replaceStepGroup(
    providerConfigId: number,
    configId: number,
    configType: 'leads' | 'summary',
    stepGroup: 'normal' | 'advanced' | 'extra',
    steps: Array<{
      step_type: string;
      xpath: string;
      name?: string;
      sequence?: number;
      meta_data?: Record<string, unknown>;
      is_active?: boolean;
    }> | undefined,
  ) {
    if (!steps) return;
    await this.providerStepRepository.delete({
      provider_config_id: providerConfigId,
      config_id: configId,
      config_type: configType,
      step_group: stepGroup,
    });
    if (!steps.length) return;
    const toSave = steps.map((s, idx) =>
      this.providerStepRepository.create({
        provider_config_id: providerConfigId,
        config_id: configId,
        config_type: configType,
        step_group: stepGroup,
        step_type: s.step_type as any,
        xpath: s.xpath,
        name: s.name ?? null,
        sequence: s.sequence ?? idx,
        meta_data: s.meta_data ?? {},
        is_active: s.is_active ?? true,
      }),
    );
    await this.providerStepRepository.save(toSave);
  }

  async upsertLeadsConfig(payload: UpsertProviderScraperConfigDto) {
    const commonConfig = await this.providerConfigRepository.findOne({
      where: { config_id: payload.config_id },
    });
    if (!commonConfig) {
      throw new NotFoundException(
        `Provider config with config_id ${payload.config_id} not found`,
      );
    }

    const existing = await this.getLeadsConfigByConfigId(payload.config_id);
    if (existing) {
      const merged = this.providerLeadsConfigRepository.merge(existing, {
        ...payload,
        provider_config_id: commonConfig.id,
        has_extra_steps: payload.has_extra_steps ?? existing.has_extra_steps ?? false,
      });
      const saved = await this.providerLeadsConfigRepository.save(merged);
      await this.replaceStepGroup(commonConfig.id, payload.config_id, 'leads', 'normal', payload.normal_steps);
      await this.replaceStepGroup(commonConfig.id, payload.config_id, 'leads', 'advanced', payload.advanced_steps);
      await this.replaceStepGroup(commonConfig.id, payload.config_id, 'leads', 'extra', payload.extra_steps);
      return saved;
    }
    const created = this.providerLeadsConfigRepository.create({
      ...payload,
      provider_config_id: commonConfig.id,
      filters: payload.filters ?? [],
      is_advance_filters: payload.is_advance_filters ?? false,
      has_extra_steps: payload.has_extra_steps ?? false,
      is_active: payload.is_active ?? true,
    });
    const saved = await this.providerLeadsConfigRepository.save(created);
    await this.replaceStepGroup(commonConfig.id, payload.config_id, 'leads', 'normal', payload.normal_steps);
    await this.replaceStepGroup(commonConfig.id, payload.config_id, 'leads', 'advanced', payload.advanced_steps);
    await this.replaceStepGroup(commonConfig.id, payload.config_id, 'leads', 'extra', payload.extra_steps);
    return saved;
  }

  async upsertSummaryConfig(payload: UpsertProviderScraperConfigDto) {
    const commonConfig = await this.providerConfigRepository.findOne({
      where: { config_id: payload.config_id },
    });
    if (!commonConfig) {
      throw new NotFoundException(
        `Provider config with config_id ${payload.config_id} not found`,
      );
    }

    const existing = await this.getSummaryConfigByConfigId(payload.config_id);
    if (existing) {
      const merged = this.providerSummaryConfigRepository.merge(existing, {
        ...payload,
        provider_config_id: commonConfig.id,
        has_extra_steps: payload.has_extra_steps ?? existing.has_extra_steps ?? false,
      });
      const saved = await this.providerSummaryConfigRepository.save(merged);
      await this.replaceStepGroup(commonConfig.id, payload.config_id, 'summary', 'normal', payload.normal_steps);
      await this.replaceStepGroup(commonConfig.id, payload.config_id, 'summary', 'advanced', payload.advanced_steps);
      await this.replaceStepGroup(commonConfig.id, payload.config_id, 'summary', 'extra', payload.extra_steps);
      return saved;
    }
    const created = this.providerSummaryConfigRepository.create({
      ...payload,
      provider_config_id: commonConfig.id,
      filters: payload.filters ?? [],
      is_advance_filters: payload.is_advance_filters ?? false,
      has_extra_steps: payload.has_extra_steps ?? false,
      is_active: payload.is_active ?? true,
    });
    const saved = await this.providerSummaryConfigRepository.save(created);
    await this.replaceStepGroup(commonConfig.id, payload.config_id, 'summary', 'normal', payload.normal_steps);
    await this.replaceStepGroup(commonConfig.id, payload.config_id, 'summary', 'advanced', payload.advanced_steps);
    await this.replaceStepGroup(commonConfig.id, payload.config_id, 'summary', 'extra', payload.extra_steps);
    return saved;
  }

  async findOne(id: number) {
    const providerConfig = await this.providerConfigRepository.findOne({
      where: { id },
    });

    if (!providerConfig) {
      throw new NotFoundException(`Provider config with id ${id} not found`);
    }

    return providerConfig;
  }

  async findByConfigId(config_id: number) {
    const providerConfig = await this.providerConfigRepository.findOne({
      where: { config_id },
    });

    if (!providerConfig) {
      return {
        success: false,
        message: `Provider config with config_id ${config_id} not found`,
      }
    }

    return providerConfig;
  }

  async update(id: number, updateProviderConfigDto: UpdateProviderConfigDto) {
    const providerConfig = await this.findOne(id);
    const merged = this.providerConfigRepository.merge(
      providerConfig,
      updateProviderConfigDto,
    );
    return this.providerConfigRepository.save(merged);
  }

  async remove(id: number) {
    const providerConfig = await this.findOne(id);
    await this.providerConfigRepository.remove(providerConfig);
    return { message: `Provider config ${id} deleted successfully` };
  }
}