import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProviderConfigEntity } from './entitites/provider-config.entity';
import { CreateProviderConfigDto } from './dto/create-provider-config.dto';
import { UpdateProviderConfigDto } from './dto/update-provider-config.dto';

@Injectable()
export class ProviderConfigService {
  constructor(
    @InjectRepository(ProviderConfigEntity)
    private readonly providerConfigRepository: Repository<ProviderConfigEntity>,
  ) {}

  create(createProviderConfigDto: CreateProviderConfigDto) {
    const payload = this.providerConfigRepository.create({
      ...createProviderConfigDto,
      advance_filters: createProviderConfigDto.advance_filters ?? [],
      is_advance_filters: createProviderConfigDto.is_advance_filters ?? false,
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