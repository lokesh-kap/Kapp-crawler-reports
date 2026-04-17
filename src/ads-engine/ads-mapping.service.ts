import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdsMapping } from './entities/ads-mapping.entity';

export interface CreateMappingDto {
  mediumCode: string;
  clientId: number;
  campaignInfoId?: number;
  notes?: string;
}

@Injectable()
export class AdsMappingService {
  constructor(
    @InjectRepository(AdsMapping)
    private readonly repo: Repository<AdsMapping>,
  ) {}

  async findOne(mediumCode: string, clientId: number): Promise<AdsMapping | null> {
    return this.repo.findOne({ where: { mediumCode, clientId, isActive: true } });
  }

  async upsert(dto: CreateMappingDto): Promise<AdsMapping> {
    const existing = await this.findOne(dto.mediumCode, dto.clientId);
    if (existing) {
      Object.assign(existing, dto);
      return this.repo.save(existing);
    }
    return this.repo.save(this.repo.create(dto));
  }

  async bulkUpsert(rows: CreateMappingDto[]): Promise<{ created: number; updated: number }> {
    let created = 0, updated = 0;
    for (const row of rows) {
      const existing = await this.repo.findOne({
        where: { mediumCode: row.mediumCode, clientId: row.clientId },
      });
      if (existing) {
        Object.assign(existing, row);
        await this.repo.save(existing);
        updated++;
      } else {
        await this.repo.save(this.repo.create(row));
        created++;
      }
    }
    return { created, updated };
  }

  /**
   * Resolves campaignInfoId from a lead's campaign code.
   * Example code: 'kollegeapply/kcll/2026'
   * The mediumCode in our mapping table would be 'kcll'.
   */
  async resolveFromCampaignCode(campaignCode: string, clientId: number): Promise<number | null> {
    if (!campaignCode || !clientId) return null;
    
    // Extract middle part: 'kollegeapply/kcll/2026' -> 'kcll'
    const parts = campaignCode.split('/');
    if (parts.length < 2) return null;
    
    const mediumCode = parts[1]; // 'kcll'
    const mapping = await this.findOne(mediumCode, clientId);
    return mapping?.campaignInfoId ?? null;
  }
}
