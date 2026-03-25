import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProviderConfigEntity } from './entitites/provider-config.entity';
import { CreateProviderConfigDto } from './dto/create-provider-config.dto';
import { UpdateProviderConfigDto } from './dto/update-provider-config.dto';
import { ProviderLeadsConfigEntity } from './entitites/provider-leads-config.entity';
import { ProviderSummaryConfigEntity } from './entitites/provider-summary-config.entity';
import { UpsertProviderScraperConfigDto } from './dto/upsert-provider-scraper-config.dto';

@Injectable()
export class ProviderConfigService {
  constructor(
    @InjectRepository(ProviderConfigEntity)
    private readonly providerConfigRepository: Repository<ProviderConfigEntity>,
    @InjectRepository(ProviderLeadsConfigEntity)
    private readonly providerLeadsConfigRepository: Repository<ProviderLeadsConfigEntity>,
    @InjectRepository(ProviderSummaryConfigEntity)
    private readonly providerSummaryConfigRepository: Repository<ProviderSummaryConfigEntity>,
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
    return this.providerLeadsConfigRepository.findOne({ where: { config_id } });
  }

  async getSummaryConfigByConfigId(config_id: number) {
    return this.providerSummaryConfigRepository.findOne({ where: { config_id } });
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
      });
      return this.providerLeadsConfigRepository.save(merged);
    }
    const created = this.providerLeadsConfigRepository.create({
      ...payload,
      provider_config_id: commonConfig.id,
      filters: payload.filters ?? [],
      advance_filters: payload.advance_filters ?? [],
      is_advance_filters: payload.is_advance_filters ?? false,
      is_active: payload.is_active ?? true,
    });
    return this.providerLeadsConfigRepository.save(created);
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
      });
      return this.providerSummaryConfigRepository.save(merged);
    }
    const created = this.providerSummaryConfigRepository.create({
      ...payload,
      provider_config_id: commonConfig.id,
      filters: payload.filters ?? [],
      advance_filters: payload.advance_filters ?? [],
      is_advance_filters: payload.is_advance_filters ?? false,
      is_active: payload.is_active ?? true,
    });
    return this.providerSummaryConfigRepository.save(created);
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