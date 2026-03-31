import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClientWiseEntity } from './entities/client-wise.entity';
import { CreateClientWiseDto } from './dto/create-client-wise.dto';
import { UpdateClientWiseDto } from './dto/update-client-wise.dto';
import { CreateClientWiseFromProviderDto } from './dto/create-from-provider.dto';
import { ProviderConfigEntity } from '../provider-config/entitites/provider-config.entity';
import { ClientWiseLeadsConfigEntity } from './entities/client-wise-leads-config.entity';
import { ClientWiseSummaryConfigEntity } from './entities/client-wise-summary-config.entity';
import { UpsertClientWiseScraperConfigDto } from './dto/upsert-client-wise-scraper-config.dto';
import { ClientWiseStepEntity, StepConfigType, StepGroupType } from './entities/client-wise-step.entity';

@Injectable()
export class ClientWiseService {
  constructor(
    @InjectRepository(ClientWiseEntity)
    private readonly clientWiseRepository: Repository<ClientWiseEntity>,
    @InjectRepository(ProviderConfigEntity)
    private readonly providerConfigRepository: Repository<ProviderConfigEntity>,
    @InjectRepository(ClientWiseLeadsConfigEntity)
    private readonly clientWiseLeadsConfigRepository: Repository<ClientWiseLeadsConfigEntity>,
    @InjectRepository(ClientWiseSummaryConfigEntity)
    private readonly clientWiseSummaryConfigRepository: Repository<ClientWiseSummaryConfigEntity>,
    @InjectRepository(ClientWiseStepEntity)
    private readonly clientWiseStepRepository: Repository<ClientWiseStepEntity>,
  ) {}

  create(createClientWiseDto: CreateClientWiseDto) {
    const payload = this.clientWiseRepository.create({
      ...createClientWiseDto,
      credentials: createClientWiseDto.credentials ?? null,
      is_active: createClientWiseDto.is_active ?? true,
      config_id: createClientWiseDto.config_id ?? null,
    });

    return this.clientWiseRepository.save(payload);
  }

  async createFromProvider(payload: CreateClientWiseFromProviderDto) {
    const providerConfig = await this.providerConfigRepository.findOne({
      where: { id: payload.provider_config_id },
    });

    if (!providerConfig) {
      throw new NotFoundException(
        `Provider config with id ${payload.provider_config_id} not found`,
      );
    }

    const clientWisePayload = this.clientWiseRepository.create({
      name: payload.name ?? providerConfig.name,
      credentials: payload.credentials ?? providerConfig.credentials ?? null,
      is_active: payload.is_active ?? providerConfig.is_active,
      client_id: payload.client_id,
      year: payload.year,
      user_id: payload.user_id,
      config_id: payload.config_id ?? providerConfig.config_id ?? null,
    });

    return this.clientWiseRepository.save(clientWisePayload);
  }

  findAll() {
    return this.clientWiseRepository.find({
      order: { created_at: 'DESC' },
    });
  }

  findByClientAndYear(client_id: number, year: number) {
    return this.clientWiseRepository.find({
      where: { client_id, year },
      order: { updated_at: 'DESC' },
    });
  }

  async findByClientYearAndConfigId(
    client_id: number,
    year: number,
    config_id: number,
  ) {
    const row = await this.clientWiseRepository.findOne({
      where: { client_id, year, config_id },
    });
    if (!row) return null;
    return row;
  }

  async getLeadsConfig(client_id: number, year: number, config_id: number) {
    const config = await this.clientWiseLeadsConfigRepository.findOne({
      where: { client_id, year, config_id },
    });
    if (!config) return null;
    const steps = await this.getStepGroups(config.client_wise_id, 'leads');
    return { ...config, ...steps };
  }

  async getSummaryConfig(client_id: number, year: number, config_id: number) {
    const config = await this.clientWiseSummaryConfigRepository.findOne({
      where: { client_id, year, config_id },
    });
    if (!config) return null;
    const steps = await this.getStepGroups(config.client_wise_id, 'summary');
    return { ...config, ...steps };
  }

  private async getStepGroups(clientWiseId: number, configType: StepConfigType) {
    const rows = await this.clientWiseStepRepository.find({
      where: { client_wise_id: clientWiseId, config_type: configType, is_active: true },
      order: { sequence: 'ASC', id: 'ASC' },
    });
    return {
      normal_steps: rows.filter((x) => x.step_group === 'normal'),
      advanced_steps: rows.filter((x) => x.step_group === 'advanced'),
      extra_steps: rows.filter((x) => x.step_group === 'extra'),
    };
  }

  private async replaceStepGroup(
    clientWiseId: number,
    configType: StepConfigType,
    stepGroup: StepGroupType,
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
    await this.clientWiseStepRepository.delete({
      client_wise_id: clientWiseId,
      config_type: configType,
      step_group: stepGroup,
    });
    if (!steps.length) return;
    const toSave = steps.map((s, idx) =>
      this.clientWiseStepRepository.create({
        client_wise_id: clientWiseId,
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
    await this.clientWiseStepRepository.save(toSave);
  }

  /**
   * When `extra_steps` is present in the payload, derive `has_extra_steps` from non-empty steps
   * so the DB flag cannot stay false while date/extra steps are saved (scraper used to skip extras).
   */
  private resolveHasExtraStepsFlag(
    payload: UpsertClientWiseScraperConfigDto,
    existingFlag?: boolean,
  ): boolean {
    if (Array.isArray(payload.extra_steps)) {
      return payload.extra_steps.some(
        (s) => String(s.step_type ?? '').trim().length > 0 && String(s.xpath ?? '').trim().length > 0,
      );
    }
    return payload.has_extra_steps ?? existingFlag ?? false;
  }

  async upsertLeadsConfig(payload: UpsertClientWiseScraperConfigDto) {
    const commonConfig = await this.findByClientYearAndConfigId(
      payload.client_id,
      payload.year,
      payload.config_id,
    );
    if (!commonConfig) {
      throw new NotFoundException(
        `Client wise common config not found for client_id ${payload.client_id}, year ${payload.year}, config_id ${payload.config_id}`,
      );
    }

    const existing = await this.getLeadsConfig(
      payload.client_id,
      payload.year,
      payload.config_id,
    );
    if (existing) {
      const merged = this.clientWiseLeadsConfigRepository.merge(existing, {
        ...payload,
        client_wise_id: commonConfig.id,
        has_extra_steps: this.resolveHasExtraStepsFlag(payload, existing.has_extra_steps),
      });
      const saved = await this.clientWiseLeadsConfigRepository.save(merged);
      await this.replaceStepGroup(commonConfig.id, 'leads', 'normal', payload.normal_steps);
      await this.replaceStepGroup(commonConfig.id, 'leads', 'advanced', payload.advanced_steps);
      await this.replaceStepGroup(commonConfig.id, 'leads', 'extra', payload.extra_steps);
      return saved;
    }
    const created = this.clientWiseLeadsConfigRepository.create({
      ...payload,
      client_wise_id: commonConfig.id,
      filters: payload.filters ?? [],
      is_advance_filters: payload.is_advance_filters ?? false,
      has_extra_steps: this.resolveHasExtraStepsFlag(payload, false),
      is_active: payload.is_active ?? true,
    });
    const saved = await this.clientWiseLeadsConfigRepository.save(created);
    await this.replaceStepGroup(commonConfig.id, 'leads', 'normal', payload.normal_steps);
    await this.replaceStepGroup(commonConfig.id, 'leads', 'advanced', payload.advanced_steps);
    await this.replaceStepGroup(commonConfig.id, 'leads', 'extra', payload.extra_steps);
    return saved;
  }

  async upsertSummaryConfig(payload: UpsertClientWiseScraperConfigDto) {
    const commonConfig = await this.findByClientYearAndConfigId(
      payload.client_id,
      payload.year,
      payload.config_id,
    );
    if (!commonConfig) {
      throw new NotFoundException(
        `Client wise common config not found for client_id ${payload.client_id}, year ${payload.year}, config_id ${payload.config_id}`,
      );
    }

    const existing = await this.getSummaryConfig(
      payload.client_id,
      payload.year,
      payload.config_id,
    );
    if (existing) {
      const merged = this.clientWiseSummaryConfigRepository.merge(existing, {
        ...payload,
        client_wise_id: commonConfig.id,
        has_extra_steps: this.resolveHasExtraStepsFlag(payload, existing.has_extra_steps),
      });
      const saved = await this.clientWiseSummaryConfigRepository.save(merged);
      await this.replaceStepGroup(commonConfig.id, 'summary', 'normal', payload.normal_steps);
      await this.replaceStepGroup(commonConfig.id, 'summary', 'advanced', payload.advanced_steps);
      await this.replaceStepGroup(commonConfig.id, 'summary', 'extra', payload.extra_steps);
      return saved;
    }
    const created = this.clientWiseSummaryConfigRepository.create({
      ...payload,
      client_wise_id: commonConfig.id,
      filters: payload.filters ?? [],
      is_advance_filters: payload.is_advance_filters ?? false,
      has_extra_steps: this.resolveHasExtraStepsFlag(payload, false),
      is_active: payload.is_active ?? true,
    });
    const saved = await this.clientWiseSummaryConfigRepository.save(created);
    await this.replaceStepGroup(commonConfig.id, 'summary', 'normal', payload.normal_steps);
    await this.replaceStepGroup(commonConfig.id, 'summary', 'advanced', payload.advanced_steps);
    await this.replaceStepGroup(commonConfig.id, 'summary', 'extra', payload.extra_steps);
    return saved;
  }

  async findOne(id: number) {
    const clientWise = await this.clientWiseRepository.findOne({
      where: { id },
    });

    if (!clientWise) {
      throw new NotFoundException(`Client wise config with id ${id} not found`);
    }

    return clientWise;
  }

  async update(id: number, updateClientWiseDto: UpdateClientWiseDto) {
    const existing = await this.findOne(id);
    const merged = this.clientWiseRepository.merge(existing, updateClientWiseDto);
    return this.clientWiseRepository.save(merged);
  }

  async remove(id: number) {
    const existing = await this.findOne(id);
    await this.clientWiseRepository.remove(existing);
    return { message: `Client wise config ${id} deleted successfully` };
  }
}
