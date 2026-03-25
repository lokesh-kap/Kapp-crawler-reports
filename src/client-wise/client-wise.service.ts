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

  getLeadsConfig(client_id: number, year: number, config_id: number) {
    return this.clientWiseLeadsConfigRepository.findOne({
      where: { client_id, year, config_id },
    });
  }

  getSummaryConfig(client_id: number, year: number, config_id: number) {
    return this.clientWiseSummaryConfigRepository.findOne({
      where: { client_id, year, config_id },
    });
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
      });
      return this.clientWiseLeadsConfigRepository.save(merged);
    }
    const created = this.clientWiseLeadsConfigRepository.create({
      ...payload,
      client_wise_id: commonConfig.id,
      filters: payload.filters ?? [],
      advance_filters: payload.advance_filters ?? [],
      is_advance_filters: payload.is_advance_filters ?? false,
      is_active: payload.is_active ?? true,
    });
    return this.clientWiseLeadsConfigRepository.save(created);
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
      });
      return this.clientWiseSummaryConfigRepository.save(merged);
    }
    const created = this.clientWiseSummaryConfigRepository.create({
      ...payload,
      client_wise_id: commonConfig.id,
      filters: payload.filters ?? [],
      advance_filters: payload.advance_filters ?? [],
      is_advance_filters: payload.is_advance_filters ?? false,
      is_active: payload.is_active ?? true,
    });
    return this.clientWiseSummaryConfigRepository.save(created);
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
