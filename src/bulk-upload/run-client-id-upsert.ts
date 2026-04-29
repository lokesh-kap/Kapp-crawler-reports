import * as fs from 'fs/promises';
import { parse } from 'csv-parse/sync';
import { Repository } from 'typeorm';
import { AppDataSource } from '../data-source';
import {
  ProviderCredential,
  ProviderFilter,
} from '../provider-config/entitites/provider-config.entity';
import { ProviderConfigEntity } from '../provider-config/entitites/provider-config.entity';
import { ProviderLeadsConfigEntity } from '../provider-config/entitites/provider-leads-config.entity';
import { ProviderStepEntity } from '../provider-config/entitites/provider-step.entity';
import { ProviderSummaryConfigEntity } from '../provider-config/entitites/provider-summary-config.entity';
import { parseBulkUploadRow } from './bulk-upload-row.parser';
import { BulkUploadRowDto } from './dto/bulk-upload.dto';
import { ClientWiseEntity } from '../client-wise/entities/client-wise.entity';
import { ClientWiseLeadsConfigEntity } from '../client-wise/entities/client-wise-leads-config.entity';
import { ClientWiseSummaryConfigEntity } from '../client-wise/entities/client-wise-summary-config.entity';
import { ClientWiseStepEntity, StepConfigType, StepGroupType } from '../client-wise/entities/client-wise-step.entity';

type StepItem = {
  step_type: string;
  xpath: string;
  name?: string;
  sequence?: number;
  meta_data?: Record<string, unknown>;
  is_active?: boolean;
};

type CliOptions = {
  csvPath: string;
  configId: number;
  userId: number;
};

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function parseOptions(): CliOptions {
  const csvPath = argValue('--csv');
  const configIdRaw = argValue('--config_id') ?? '2';
  const userIdRaw = argValue('--user_id') ?? '1';

  if (!csvPath) {
    throw new Error(
      'Missing --csv.\nExample: npx ts-node -r tsconfig-paths/register src/bulk-upload/run-client-id-upsert.ts --csv "../trackind id update-15Apr - Main.csv" --config_id 2 --user_id 1',
    );
  }

  const configId = Number(configIdRaw);
  const userId = Number(userIdRaw);
  if (!Number.isInteger(configId) || configId < 1) {
    throw new Error(`Invalid --config_id "${configIdRaw}"`);
  }
  if (!Number.isInteger(userId) || userId < 1) {
    throw new Error(`Invalid --user_id "${userIdRaw}"`);
  }

  return { csvPath, configId, userId };
}

function firstNonEmpty(
  row: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        const text = String(item).trim();
        if (text) return text;
      }
      continue;
    }
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return undefined;
}

function allNonEmpty(
  row: Record<string, unknown>,
  keys: string[],
): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = row[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        const text = String(item).trim();
        if (text) out.push(text);
      }
      continue;
    }
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) out.push(text);
  }
  return out;
}

function normalizeCsvRow(raw: Record<string, unknown>): Record<string, unknown> {
  const dateToCandidate = firstNonEmpty(raw, ['date_to', 'Date To', 'End Date', 'end_date']);
  const dateTo =
    dateToCandidate && !/^till\s*today$/i.test(dateToCandidate)
      ? dateToCandidate
      : undefined;
  const year = firstNonEmpty(raw, ['year', 'Year']) ?? String(new Date().getFullYear());
  const mediumUrlCandidates = allNonEmpty(raw, ['medium_url', 'Medium URL']);
  const mediumUrl = mediumUrlCandidates[0];
  const leadUrl =
    firstNonEmpty(raw, ['lead_url', 'Lead URL']) ??
    mediumUrlCandidates[1] ??
    mediumUrlCandidates[0];

  return {
    client_id: firstNonEmpty(raw, ['client_id', 'Client ID', 'Client IDS', 'Client Id']),
    login_url: firstNonEmpty(raw, ['login_url', 'Login URL']),
    login_id: firstNonEmpty(raw, ['login_id', 'Login ID', 'Login Id', 'email']),
    password: firstNonEmpty(raw, ['password', 'Password']),
    client_source: firstNonEmpty(raw, ['client_source', 'Client Source', 'source', 'Source']),
    client_name: firstNonEmpty(raw, ['client_name', 'Client Name', 'Client CRM Name']),
    date_from: firstNonEmpty(raw, ['date_from', 'Date From', 'Start Date', 'start_date']),
    date_to: dateTo,
    medium_url: mediumUrl,
    lead_url: leadUrl,
    year,
  };
}

function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '_');
}

const FILTER_ALIASES: Record<string, keyof BulkUploadRowDto> = {
  'client name': 'client_name',
  clientname: 'client_name',
  source: 'client_source',
};

function rowToFilterLookup(row: BulkUploadRowDto): Record<string, string> {
  return {
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

function providerStepToItem(s: ProviderStepEntity): StepItem {
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
  steps: StepItem[],
  dateFrom: string,
  dateTo: string,
): StepItem[] {
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

async function replaceStepGroup(
  clientWiseStepRepo: Repository<ClientWiseStepEntity>,
  clientWiseId: number,
  configType: StepConfigType,
  stepGroup: StepGroupType,
  steps: StepItem[],
): Promise<void> {
  await clientWiseStepRepo.delete({
    client_wise_id: clientWiseId,
    config_type: configType,
    step_group: stepGroup,
  });

  if (!steps.length) return;

  const toSave = steps.map((s, idx) =>
    clientWiseStepRepo.create({
      client_wise_id: clientWiseId,
      config_type: configType,
      step_group: stepGroup,
      step_type: s.step_type as ClientWiseStepEntity['step_type'],
      xpath: s.xpath,
      name: s.name ?? null,
      sequence: s.sequence ?? idx,
      meta_data: s.meta_data ?? {},
      is_active: s.is_active ?? true,
    }),
  );
  await clientWiseStepRepo.save(toSave);
}

async function run(): Promise<void> {
  const options = parseOptions();

  const csvContent = await fs.readFile(options.csvPath, 'utf8');
  const rawRows = parse(csvContent, {
    columns: true,
    group_columns_by_name: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, unknown>[];

  const validRows: BulkUploadRowDto[] = [];
  const invalidRows: Array<{ idx: number; reason: string }> = [];
  let skippedMissingClientId = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const normalized = normalizeCsvRow(rawRows[i]);
    const rawClientId = String(normalized.client_id ?? '').trim();
    if (!rawClientId) {
      skippedMissingClientId++;
      continue;
    }
    const parsed = parseBulkUploadRow(normalized);
    if (!parsed.ok) {
      invalidRows.push({ idx: i + 2, reason: parsed.message });
      continue;
    }
    validRows.push(parsed.row);
  }

  const latestByClientId = new Map<number, BulkUploadRowDto>();
  for (const row of validRows) {
    latestByClientId.set(row.client_id, row);
  }
  const dedupedRows = Array.from(latestByClientId.values());

  await AppDataSource.initialize();
  try {
    const providerConfigRepo = AppDataSource.getRepository(ProviderConfigEntity);
    const providerLeadsRepo = AppDataSource.getRepository(ProviderLeadsConfigEntity);
    const providerSummaryRepo = AppDataSource.getRepository(ProviderSummaryConfigEntity);
    const providerStepRepo = AppDataSource.getRepository(ProviderStepEntity);

    const clientWiseRepo = AppDataSource.getRepository(ClientWiseEntity);
    const clientWiseLeadsRepo = AppDataSource.getRepository(ClientWiseLeadsConfigEntity);
    const clientWiseSummaryRepo = AppDataSource.getRepository(ClientWiseSummaryConfigEntity);
    const clientWiseStepRepo = AppDataSource.getRepository(ClientWiseStepEntity);

    const provider = await providerConfigRepo.findOne({
      where: { config_id: options.configId },
    });
    if (!provider) {
      throw new Error(`Provider config not found for config_id=${options.configId}`);
    }

    const leadsTpl = await providerLeadsRepo.findOne({
      where: { config_id: options.configId },
    });
    const summaryTpl = await providerSummaryRepo.findOne({
      where: { config_id: options.configId },
    });
    if (!leadsTpl?.url) {
      throw new Error(`Provider leads template missing for config_id=${options.configId}`);
    }
    if (!summaryTpl?.url) {
      throw new Error(`Provider summary template missing for config_id=${options.configId}`);
    }

    const providerSteps = await providerStepRepo.find({
      where: {
        provider_config_id: provider.id,
        config_id: options.configId,
        is_active: true,
      },
      order: { sequence: 'ASC', id: 'ASC' },
    });

    const leadsNormalSteps = providerSteps
      .filter((x) => x.config_type === 'leads' && x.step_group === 'normal')
      .map(providerStepToItem);
    const leadsAdvancedSteps = providerSteps
      .filter((x) => x.config_type === 'leads' && x.step_group === 'advanced')
      .map(providerStepToItem);
    const leadsExtraTemplate = providerSteps
      .filter((x) => x.config_type === 'leads' && x.step_group === 'extra')
      .map(providerStepToItem);

    const summaryNormalSteps = providerSteps
      .filter((x) => x.config_type === 'summary' && x.step_group === 'normal')
      .map(providerStepToItem);
    const summaryAdvancedSteps = providerSteps
      .filter((x) => x.config_type === 'summary' && x.step_group === 'advanced')
      .map(providerStepToItem);
    const summaryExtraTemplate = providerSteps
      .filter((x) => x.config_type === 'summary' && x.step_group === 'extra')
      .map(providerStepToItem);

    let createdClientWise = 0;
    let updatedClientWise = 0;
    let updatedLeads = 0;
    let createdLeads = 0;
    let updatedSummary = 0;
    let createdSummary = 0;
    let deactivatedClientWise = 0;
    let deactivatedLeads = 0;
    let deactivatedSummary = 0;
    const errors: Array<{ client_id: number; reason: string }> = [];

    for (const row of dedupedRows) {
      try {
        const dateTo = row.date_to?.trim() || new Date().toISOString().slice(0, 10);
        const credentials = mergeCredentials(provider.credentials, row);
        const clientWiseName = provider.name?.trim() || 'Provider';

        let common = await clientWiseRepo.findOne({
          where: { client_id: row.client_id, config_id: options.configId },
          order: { updated_at: 'DESC', id: 'DESC' },
        });

        if (common) {
          common.name = clientWiseName;
          common.credentials = credentials;
          common.is_active = true;
          common.year = row.year;
          common.user_id = options.userId;
          common.config_id = options.configId;
          common = await clientWiseRepo.save(common);
          updatedClientWise++;
        } else {
          common = await clientWiseRepo.save(
            clientWiseRepo.create({
              name: clientWiseName,
              credentials,
              is_active: true,
              client_id: row.client_id,
              year: row.year,
              user_id: options.userId,
              config_id: options.configId,
            }),
          );
          createdClientWise++;
        }

        const leadsFilters = applyRowToFilters(
          Array.isArray(leadsTpl.filters)
            ? JSON.parse(JSON.stringify(leadsTpl.filters))
            : [],
          row,
        );
        const leadsExtraSteps = applyDateRangeToExtraSteps(
          leadsExtraTemplate.map((x) => ({ ...x, meta_data: { ...(x.meta_data || {}) } })),
          row.date_from,
          dateTo,
        );

        let leads = await clientWiseLeadsRepo.findOne({
          where: { client_id: row.client_id, config_id: options.configId },
          order: { updated_at: 'DESC', id: 'DESC' },
        });
        if (leads) {
          leads.client_wise_id = common.id;
          leads.client_id = row.client_id;
          leads.year = row.year;
          leads.user_id = options.userId;
          leads.config_id = options.configId;
          leads.url = row.lead_url.trim();
          leads.filters = leadsFilters;
          leads.is_advance_filters = Boolean(leadsTpl.is_advance_filters);
          leads.has_extra_steps = Boolean(leadsTpl.has_extra_steps);
          leads.is_active = leadsTpl.is_active !== false;
          await clientWiseLeadsRepo.save(leads);
          updatedLeads++;
        } else {
          leads = await clientWiseLeadsRepo.save(
            clientWiseLeadsRepo.create({
              client_wise_id: common.id,
              client_id: row.client_id,
              year: row.year,
              user_id: options.userId,
              config_id: options.configId,
              url: row.lead_url.trim(),
              filters: leadsFilters,
              is_advance_filters: Boolean(leadsTpl.is_advance_filters),
              has_extra_steps: Boolean(leadsTpl.has_extra_steps),
              is_active: leadsTpl.is_active !== false,
            }),
          );
          createdLeads++;
        }

        await replaceStepGroup(clientWiseStepRepo, common.id, 'leads', 'normal', leadsNormalSteps);
        await replaceStepGroup(
          clientWiseStepRepo,
          common.id,
          'leads',
          'advanced',
          leadsAdvancedSteps,
        );
        await replaceStepGroup(clientWiseStepRepo, common.id, 'leads', 'extra', leadsExtraSteps);

        const summaryFilters = applyRowToFilters(
          Array.isArray(summaryTpl.filters)
            ? JSON.parse(JSON.stringify(summaryTpl.filters))
            : [],
          row,
        );
        const summaryExtraSteps = applyDateRangeToExtraSteps(
          summaryExtraTemplate.map((x) => ({ ...x, meta_data: { ...(x.meta_data || {}) } })),
          row.date_from,
          dateTo,
        );

        let summary = await clientWiseSummaryRepo.findOne({
          where: { client_id: row.client_id, config_id: options.configId },
          order: { updated_at: 'DESC', id: 'DESC' },
        });
        if (summary) {
          summary.client_wise_id = common.id;
          summary.client_id = row.client_id;
          summary.year = row.year;
          summary.user_id = options.userId;
          summary.config_id = options.configId;
          summary.url = row.medium_url.trim();
          summary.filters = summaryFilters;
          summary.is_advance_filters = Boolean(summaryTpl.is_advance_filters);
          summary.has_extra_steps = Boolean(summaryTpl.has_extra_steps);
          summary.is_active = summaryTpl.is_active !== false;
          await clientWiseSummaryRepo.save(summary);
          updatedSummary++;
        } else {
          summary = await clientWiseSummaryRepo.save(
            clientWiseSummaryRepo.create({
              client_wise_id: common.id,
              client_id: row.client_id,
              year: row.year,
              user_id: options.userId,
              config_id: options.configId,
              url: row.medium_url.trim(),
              filters: summaryFilters,
              is_advance_filters: Boolean(summaryTpl.is_advance_filters),
              has_extra_steps: Boolean(summaryTpl.has_extra_steps),
              is_active: summaryTpl.is_active !== false,
            }),
          );
          createdSummary++;
        }

        await replaceStepGroup(
          clientWiseStepRepo,
          common.id,
          'summary',
          'normal',
          summaryNormalSteps,
        );
        await replaceStepGroup(
          clientWiseStepRepo,
          common.id,
          'summary',
          'advanced',
          summaryAdvancedSteps,
        );
        await replaceStepGroup(
          clientWiseStepRepo,
          common.id,
          'summary',
          'extra',
          summaryExtraSteps,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        errors.push({ client_id: row.client_id, reason });
      }
    }

    const incomingClientIds = new Set(dedupedRows.map((x) => x.client_id));
    const currentRowsForConfig = await clientWiseRepo.find({
      where: { config_id: options.configId },
    });
    const clientIdsToDeactivate = Array.from(
      new Set(
        currentRowsForConfig
          .filter((row) => row.is_active && !incomingClientIds.has(row.client_id))
          .map((row) => row.client_id),
      ),
    );

    if (clientIdsToDeactivate.length) {
      const deactivateClientWiseResult = await clientWiseRepo
        .createQueryBuilder()
        .update(ClientWiseEntity)
        .set({ is_active: false })
        .where('config_id = :configId', { configId: options.configId })
        .andWhere('client_id IN (:...clientIds)', { clientIds: clientIdsToDeactivate })
        .andWhere('is_active = true')
        .execute();
      deactivatedClientWise = deactivateClientWiseResult.affected ?? 0;

      const deactivateLeadsResult = await clientWiseLeadsRepo
        .createQueryBuilder()
        .update(ClientWiseLeadsConfigEntity)
        .set({ is_active: false })
        .where('config_id = :configId', { configId: options.configId })
        .andWhere('client_id IN (:...clientIds)', { clientIds: clientIdsToDeactivate })
        .andWhere('is_active = true')
        .execute();
      deactivatedLeads = deactivateLeadsResult.affected ?? 0;

      const deactivateSummaryResult = await clientWiseSummaryRepo
        .createQueryBuilder()
        .update(ClientWiseSummaryConfigEntity)
        .set({ is_active: false })
        .where('config_id = :configId', { configId: options.configId })
        .andWhere('client_id IN (:...clientIds)', { clientIds: clientIdsToDeactivate })
        .andWhere('is_active = true')
        .execute();
      deactivatedSummary = deactivateSummaryResult.affected ?? 0;
    }

    console.log('--- Client-ID upsert complete ---');
    console.log(`CSV rows: ${rawRows.length}`);
    console.log(`Valid rows: ${validRows.length}`);
    console.log(`Skipped rows (missing client_id): ${skippedMissingClientId}`);
    console.log(`Invalid rows: ${invalidRows.length}`);
    console.log(`Deduped client_ids: ${dedupedRows.length}`);
    console.log(`ClientWise -> created: ${createdClientWise}, updated: ${updatedClientWise}`);
    console.log(`LeadsConfig -> created: ${createdLeads}, updated: ${updatedLeads}`);
    console.log(`SummaryConfig -> created: ${createdSummary}, updated: ${updatedSummary}`);
    console.log(
      `Deactivated (missing in CSV) -> client_wise: ${deactivatedClientWise}, leads: ${deactivatedLeads}, summary: ${deactivatedSummary}`,
    );
    console.log(`Processing errors: ${errors.length}`);

    if (invalidRows.length) {
      console.log('Invalid rows (line, reason):');
      invalidRows.slice(0, 20).forEach((x) => {
        console.log(`  line ${x.idx}: ${x.reason}`);
      });
      if (invalidRows.length > 20) {
        console.log(`  ...and ${invalidRows.length - 20} more`);
      }
    }

    if (errors.length) {
      console.log('Row processing errors (client_id, reason):');
      errors.slice(0, 20).forEach((x) => {
        console.log(`  client_id ${x.client_id}: ${x.reason}`);
      });
      if (errors.length > 20) {
        console.log(`  ...and ${errors.length - 20} more`);
      }
      process.exitCode = 1;
    }
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
