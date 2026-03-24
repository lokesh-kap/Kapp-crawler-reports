import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClientWiseEntity } from './entities/client-wise.entity';
import { CreateClientWiseDto } from './dto/create-client-wise.dto';
import { UpdateClientWiseDto } from './dto/update-client-wise.dto';
import { CreateClientWiseFromProviderDto } from './dto/create-from-provider.dto';
import { ProviderConfigEntity } from '../provider-config/entitites/provider-config.entity';

@Injectable()
export class ClientWiseService {
  constructor(
    @InjectRepository(ClientWiseEntity)
    private readonly clientWiseRepository: Repository<ClientWiseEntity>,
    @InjectRepository(ProviderConfigEntity)
    private readonly providerConfigRepository: Repository<ProviderConfigEntity>,
  ) {}

  create(createClientWiseDto: CreateClientWiseDto) {
    const payload = this.clientWiseRepository.create({
      ...createClientWiseDto,
      advance_filters: createClientWiseDto.advance_filters ?? [],
      is_advance_filters: createClientWiseDto.is_advance_filters ?? false,
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
      url: payload.url ?? providerConfig.url,
      filters: payload.filters ?? providerConfig.filters,
      advance_filters: payload.advance_filters ?? providerConfig.advance_filters,
      is_advance_filters:
        payload.is_advance_filters ?? providerConfig.is_advance_filters ?? false,
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
