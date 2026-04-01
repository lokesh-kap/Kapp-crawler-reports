import { BadRequestException, Injectable } from '@nestjs/common';
import { ProviderConfigService } from '../provider-config/provider-config.service';
import { ClientWiseService } from '../client-wise/client-wise.service';
import { CreateClientWiseFromProviderDto } from '../client-wise/dto/create-from-provider.dto';
import { BulkUploadRowDto, BulkUploadRequestDto } from './dto/bulk-upload.dto';
import { parseBulkUploadRow } from './bulk-upload-row.parser';
import {
  ProviderCredential,
  ProviderFilter,
} from '../provider-config/entitites/provider-config.entity';
import { ProviderStepEntity } from '../provider-config/entitites/provider-step.entity';
import { UpsertClientWiseScraperConfigDto } from '../client-wise/dto/upsert-client-wise-scraper-config.dto';
import { StepItemDto } from '../client-wise/dto/step.dto';

export type BulkUploadRowResult = {
  rowIndex: number;
  ok: boolean;
  message?: string;
  client_wise_id?: number;
};

function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '_');
}

/** Map filter `name` (normalized) to CSV row fields. */
const FILTER_ALIASES: Record<string, keyof BulkUploadRowDto> = {
  'client name': 'client_name',
  clientname: 'client_name',
  source: 'client_source',
};

function rowToFilterLookup(row: BulkUploadRowDto): Record<string, string> {
  const flat: Record<string, string> = {
    client_name: row.client_name,
    client_source: row.client_source ?? '',
    source: row.client_source ?? '',
    login_url: row.login_url ?? '',
    login_id: row.login_id,
    date_from: row.date_from,
    date_to: row.date_to ?? '',
    lead_url: row.lead_url,
    medium_url: row.medium_url,
  };
  return flat;
}

function applyRowToFilters(
  filters: ProviderFilter[],
  row: BulkUploadRowDto,
): ProviderFilter[] {
  const lookup = rowToFilterLookup(row);
  return filters.map((f) => {
    const fname = (f.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    let value: string | undefined;

    const aliasKey =
      FILTER_ALIASES[fname.replace(/\s+/g, '')] ?? FILTER_ALIASES[fname];
    if (aliasKey) {
      const v = row[aliasKey];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        value = String(v).trim();
      }
    }

    if (!value && fname) {
      const nk = normKey(f.name || '');
      for (const [k, v] of Object.entries(lookup)) {
        if (normKey(k) === nk && String(v).trim() !== '') {
          value = String(v).trim();
          break;
        }
      }
    }

    if (!value) return { ...f };
    return { ...f, value_to_apply: value };
  });
}

function providerStepToDto(s: ProviderStepEntity): StepItemDto {
  const meta =
    s.meta_data && typeof s.meta_data === 'object' && !Array.isArray(s.meta_data)
      ? { ...s.meta_data }
      : {};
  return {
    step_type: s.step_type,
    xpath: s.xpath,
    name: s.name ?? undefined,
    sequence: s.sequence,
    meta_data: meta,
    is_active: s.is_active,
  };
}

function applyDateRangeToExtraSteps(
  steps: StepItemDto[],
  dateFrom: string,
  dateTo: string,
): StepItemDto[] {
  const start = dateFrom.trim();
  const end = dateTo.trim();
  if (!start) return steps;
  const combined = `${start}|${end}`;
  return steps.map((s) => {
    if (s.step_type !== 'date_range') {
      return { ...s, meta_data: { ...(s.meta_data || {}) } };
    }
    return {
      ...s,
      meta_data: {
        ...(s.meta_data || {}),
        value_to_apply: combined,
      },
    };
  });
}

function mergeCredentials(
  base: ProviderCredential | null | undefined,
  row: BulkUploadRowDto,
): ProviderCredential {
  return {
    ...(base || {}),
    login_url: row.login_url?.trim() || base?.login_url,
    login: row.login_id.trim(),
    password: row.password,
  };
}

@Injectable()
export class BulkUploadService {
  constructor(
    private readonly providerConfigService: ProviderConfigService,
    private readonly clientWiseService: ClientWiseService,
  ) {}

  async upsertClientWiseFromBulk(
    body: BulkUploadRequestDto,
  ): Promise<{ results: BulkUploadRowResult[] }> {
    const { config_id, user_id, rows } = body;
    if (!rows?.length) {
      throw new BadRequestException('rows must be a non-empty array');
    }

    const providerEntity =
      await this.providerConfigService.requireEntityByConfigId(config_id);
    const provider_config_id = providerEntity.id;

    const leadsTpl = await this.providerConfigService.getLeadsConfigByConfigId(config_id);
    const summaryTpl = await this.providerConfigService.getSummaryConfigByConfigId(config_id);
    if (!leadsTpl?.url) {
      throw new BadRequestException(
        `Provider leads template missing for config_id=${config_id}. Save Scraper Config (Leads) first.`,
      );
    }
    if (!summaryTpl?.url) {
      throw new BadRequestException(
        `Provider summary template missing for config_id=${config_id}. Save Scraper Config (Summary) first.`,
      );
    }

    const baseCreds = providerEntity.credentials;

    const results: BulkUploadRowResult[] = [];

    for (let i = 0; i < rows.length; i++) {
      const parsed = parseBulkUploadRow(rows[i]);
      if (!parsed.ok) {
        results.push({ rowIndex: i, ok: false, message: parsed.message });
        continue;
      }
      try {
        const id = await this.processOneRow(
          config_id,
          user_id,
          provider_config_id,
          providerEntity.name,
          parsed.row,
          baseCreds,
          leadsTpl,
          summaryTpl,
        );
        results.push({ rowIndex: i, ok: true, client_wise_id: id });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ rowIndex: i, ok: false, message: msg });
      }
    }

    return { results };
  }

  private async processOneRow(
    config_id: number,
    user_id: number,
    provider_config_id: number,
    providerName: string,
    row: BulkUploadRowDto,
    baseCreds: ProviderCredential | null | undefined,
    leadsTpl: Record<string, unknown>,
    summaryTpl: Record<string, unknown>,
  ): Promise<number> {
    const dateTo =
      row.date_to?.trim() ||
      new Date().toISOString().slice(0, 10);

    const credentials = mergeCredentials(baseCreds, row);

    const existing = await this.clientWiseService.findByClientYearAndConfigId(
      row.client_id,
      row.year,
      config_id,
    );

    const clientWiseName = providerName.trim() || 'Provider';

    if (existing) {
      await this.clientWiseService.update(existing.id, {
        name: clientWiseName,
        credentials: credentials as CreateClientWiseFromProviderDto['credentials'],
        is_active: true,
      });
    } else {
      const createDto: CreateClientWiseFromProviderDto = {
        provider_config_id,
        config_id,
        client_id: row.client_id,
        year: row.year,
        user_id,
        name: clientWiseName,
        credentials: credentials as CreateClientWiseFromProviderDto['credentials'],
        is_active: true,
      };
      await this.clientWiseService.createFromProvider(createDto);
    }

    const common = await this.clientWiseService.findByClientYearAndConfigId(
      row.client_id,
      row.year,
      config_id,
    );
    if (!common) {
      throw new Error('client_wise row missing after create/update');
    }

    const leadsPayload = this.buildTabPayload(
      row,
      user_id,
      config_id,
      row.lead_url.trim(),
      leadsTpl,
      row.date_from,
      dateTo,
    );
    await this.clientWiseService.upsertLeadsConfig(leadsPayload);

    const summaryPayload = this.buildTabPayload(
      row,
      user_id,
      config_id,
      row.medium_url.trim(),
      summaryTpl,
      row.date_from,
      dateTo,
    );
    await this.clientWiseService.upsertSummaryConfig(summaryPayload);

    return common.id;
  }

  private buildTabPayload(
    row: BulkUploadRowDto,
    user_id: number,
    config_id: number,
    url: string,
    tpl: Record<string, unknown>,
    dateFrom: string,
    dateTo: string,
  ): UpsertClientWiseScraperConfigDto {
    const filtersRaw = tpl.filters as ProviderFilter[] | undefined;
    const filters = applyRowToFilters(
      Array.isArray(filtersRaw) ? JSON.parse(JSON.stringify(filtersRaw)) : [],
      row,
    );

    const normal_steps = ((tpl.normal_steps as ProviderStepEntity[]) || []).map(
      providerStepToDto,
    );
    const advanced_steps = ((tpl.advanced_steps as ProviderStepEntity[]) || []).map(
      providerStepToDto,
    );
    const extra_steps = applyDateRangeToExtraSteps(
      ((tpl.extra_steps as ProviderStepEntity[]) || []).map(providerStepToDto),
      dateFrom,
      dateTo,
    );

    return {
      client_id: row.client_id,
      year: row.year,
      user_id,
      config_id,
      url,
      filters,
      is_advance_filters: Boolean(tpl.is_advance_filters),
      has_extra_steps: Boolean(tpl.has_extra_steps),
      is_active: tpl.is_active !== false,
      normal_steps,
      advanced_steps,
      extra_steps,
    };
  }
}
