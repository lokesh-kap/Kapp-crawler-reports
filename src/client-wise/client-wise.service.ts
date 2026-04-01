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
   * Persist `has_extra_steps` from the UI checkbox and/or saved steps.
   * If we only derived from non-empty `extra_steps`, checking "Enable extra steps" with empty
   * placeholder rows would save `has_extra_steps: false` and the LMS checkbox would clear after create.
   */
  /** Read checkbox from payload after DTO transform; tolerate odd JSON shapes. */
  private payloadWantsExtraSteps(payload: UpsertClientWiseScraperConfigDto): boolean | undefined {
    const v = payload.has_extra_steps as unknown;
    if (v === true || v === 'true' || v === 1 || v === '1') return true;
    if (v === false || v === 'false' || v === 0 || v === '0') return false;
    return undefined;
  }

  private resolveHasExtraStepsFlag(
    payload: UpsertClientWiseScraperConfigDto,
    existingFlag?: boolean,
  ): boolean {
    const hasValidExtraStep =
      Array.isArray(payload.extra_steps) &&
      payload.extra_steps.some(
        (s) => String(s.step_type ?? '').trim().length > 0 && String(s.xpath ?? '').trim().length > 0,
      );
    if (hasValidExtraStep) return true;

    const explicit = this.payloadWantsExtraSteps(payload);
    if (explicit !== undefined) return explicit;

    if (Array.isArray(payload.extra_steps)) {
      return false;
    }

    return existingFlag ?? false;
  }

  /** Fields stored on leads/summary row only (not step arrays). */
  private pickTabConfigPayload(
    payload: UpsertClientWiseScraperConfigDto,
  ): Omit<
    UpsertClientWiseScraperConfigDto,
    'normal_steps' | 'advanced_steps' | 'extra_steps'
  > {
    const {
      normal_steps: _n,
      advanced_steps: _a,
      extra_steps: _e,
      ...rest
    } = payload;
    return rest;
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

    const existingRow = await this.clientWiseLeadsConfigRepository.findOne({
      where: {
        client_id: payload.client_id,
        year: payload.year,
        config_id: payload.config_id,
      },
    });
    if (existingRow) {
      const tabFields = this.pickTabConfigPayload(payload);
      const merged = this.clientWiseLeadsConfigRepository.merge(existingRow, {
        ...tabFields,
        client_wise_id: commonConfig.id,
      });
      merged.has_extra_steps = this.resolveHasExtraStepsFlag(
        payload,
        existingRow.has_extra_steps,
      );
      const saved = await this.clientWiseLeadsConfigRepository.save(merged);
      await this.replaceStepGroup(commonConfig.id, 'leads', 'normal', payload.normal_steps);
      await this.replaceStepGroup(commonConfig.id, 'leads', 'advanced', payload.advanced_steps);
      await this.replaceStepGroup(commonConfig.id, 'leads', 'extra', payload.extra_steps);
      return saved;
    }
    const tabFields = this.pickTabConfigPayload(payload);
    const created = this.clientWiseLeadsConfigRepository.create({
      ...tabFields,
      client_wise_id: commonConfig.id,
      filters: payload.filters ?? [],
      is_advance_filters: payload.is_advance_filters ?? false,
      is_active: payload.is_active ?? true,
    });
    created.has_extra_steps = this.resolveHasExtraStepsFlag(payload, false);
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

    const existingRow = await this.clientWiseSummaryConfigRepository.findOne({
      where: {
        client_id: payload.client_id,
        year: payload.year,
        config_id: payload.config_id,
      },
    });
    if (existingRow) {
      const tabFields = this.pickTabConfigPayload(payload);
      const merged = this.clientWiseSummaryConfigRepository.merge(existingRow, {
        ...tabFields,
        client_wise_id: commonConfig.id,
      });
      merged.has_extra_steps = this.resolveHasExtraStepsFlag(
        payload,
        existingRow.has_extra_steps,
      );
      const saved = await this.clientWiseSummaryConfigRepository.save(merged);
      await this.replaceStepGroup(commonConfig.id, 'summary', 'normal', payload.normal_steps);
      await this.replaceStepGroup(commonConfig.id, 'summary', 'advanced', payload.advanced_steps);
      await this.replaceStepGroup(commonConfig.id, 'summary', 'extra', payload.extra_steps);
      return saved;
    }
    const tabFields = this.pickTabConfigPayload(payload);
    const created = this.clientWiseSummaryConfigRepository.create({
      ...tabFields,
      client_wise_id: commonConfig.id,
      filters: payload.filters ?? [],
      is_advance_filters: payload.is_advance_filters ?? false,
      is_active: payload.is_active ?? true,
    });
    created.has_extra_steps = this.resolveHasExtraStepsFlag(payload, false);
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
