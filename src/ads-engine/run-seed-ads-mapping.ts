import * as fs from 'fs/promises';
import { parse } from 'csv-parse/sync';
import { AppDataSource } from '../data-source';
import { CampaignInfo } from './entities/campaign-info.entity';
import { AdsMapping } from './entities/ads-mapping.entity';
import { AdsProvider } from './enums';

type CliOptions = {
  csvPath: string;
};

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function parseOptions(): CliOptions {
  const csvPath = argValue('--csv');
  if (!csvPath) {
    throw new Error(
      'Missing --csv.\nExample: npx ts-node -r tsconfig-paths/register src/ads-engine/run-seed-ads-mapping.ts --csv "../Google brand mediums NPF - Copy of Sheet1.csv"',
    );
  }
  return { csvPath };
}

function firstNonEmpty(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return undefined;
}

function splitMediums(raw: string): string[] {
  return raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.toLowerCase());
}

function parseMandatoryCodesFromHeaderNote(headerNote: string): string[] {
  if (!headerNote) return [];
  const afterColon = headerNote.split(':').slice(1).join(':').trim();
  if (!afterColon) return [];
  return afterColon
    .split(',')
    .map((x) => x.trim())
    .map((x) => x.replace(/\s+to\s+be\s+added.*$/i, '').trim())
    .filter(Boolean)
    .map((x) => x.toLowerCase());
}

async function run(): Promise<void> {
  const { csvPath } = parseOptions();
  const csvContent = await fs.readFile(csvPath, 'utf8');
  const rows = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  }) as Record<string, unknown>[];

  if (!rows.length) {
    console.log('No rows found in CSV.');
    return;
  }

  const headers = Object.keys(rows[0]);
  const noteHeader = headers.find((h) => h.toLowerCase().includes('note'));
  const headerNote = noteHeader && /note\s*:/i.test(noteHeader) ? noteHeader.trim() : '';
  const mandatoryCodes = parseMandatoryCodesFromHeaderNote(headerNote);

  await AppDataSource.initialize();
  try {
    const campaignRepo = AppDataSource.getRepository(CampaignInfo);
    const mappingRepo = AppDataSource.getRepository(AdsMapping);

    let created = 0;
    let updated = 0;
    let skippedMissingClientId = 0;
    let skippedMissingCampaignId = 0;
    let skippedMissingMediums = 0;
    let skippedCampaignNotFound = 0;
    let skippedProviderMismatch = 0;
    let overwrittenCampaignBinding = 0;
    const seenMediumClientInRun = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const lineNo = i + 2;

      const googleCampaignId = firstNonEmpty(row, ['googleCampaignId', 'Google Campaign Id', 'Campaign ID']);
      if (!googleCampaignId) {
        skippedMissingCampaignId++;
        continue;
      }

      const rawClientId = firstNonEmpty(row, ['Client ID', 'clientId', 'client_id']);
      const clientId = Number(rawClientId);
      if (!rawClientId || !Number.isFinite(clientId) || clientId <= 0) {
        skippedMissingClientId++;
        continue;
      }

      const provider = (firstNonEmpty(row, ['provider', 'Provider']) ?? 'google').toLowerCase();
      if (provider !== AdsProvider.GOOGLE) {
        skippedProviderMismatch++;
        continue;
      }

      const mediumsRaw = firstNonEmpty(row, ['Mediums', 'mediums', 'mediumCode']);
      const rowMediums = mediumsRaw ? splitMediums(mediumsRaw) : [];
      const allMediums = Array.from(new Set([...rowMediums, ...mandatoryCodes]));
      if (!allMediums.length) {
        skippedMissingMediums++;
        continue;
      }

      const campaign = await campaignRepo.findOne({
        where: { externalCampaignId: googleCampaignId, provider: AdsProvider.GOOGLE },
      });
      if (!campaign) {
        skippedCampaignNotFound++;
        console.log(`line ${lineNo}: campaign not found for externalCampaignId=${googleCampaignId}`);
        continue;
      }

      const rowNote = firstNonEmpty(row, ['notes', 'note', noteHeader ?? '']) ?? '';
      const note = rowNote || headerNote || '';
      const uniqueMediums = allMediums;

      for (const mediumCode of uniqueMediums) {
        const runKey = `${clientId}::${mediumCode}`;
        if (seenMediumClientInRun.has(runKey)) {
          console.log(
            `line ${lineNo}: duplicate CSV mapping for clientId=${clientId}, mediumCode=${mediumCode}. Later row will overwrite earlier campaign binding.`,
          );
        }
        seenMediumClientInRun.add(runKey);

        const noteWithMedium = note
          ? `${note} | mediumCode=${mediumCode}`
          : `mediumCode=${mediumCode}`;

        const existing = await mappingRepo.findOne({
          where: { mediumCode, clientId },
        });
        if (existing) {
          if (existing.campaignInfoId && existing.campaignInfoId !== campaign.id) {
            const existingCampaign = await campaignRepo.findOne({
              where: { id: existing.campaignInfoId },
            });
            console.log(
              `line ${lineNo}: overwriting mapping clientId=${clientId}, mediumCode=${mediumCode} from campaignInfoId=${existing.campaignInfoId} (${existingCampaign?.externalCampaignId ?? 'unknown'}) to campaignInfoId=${campaign.id} (${campaign.externalCampaignId}).`,
            );
            overwrittenCampaignBinding++;
          }
          existing.campaignInfoId = campaign.id;
          existing.notes = noteWithMedium;
          existing.isActive = true;
          await mappingRepo.save(existing);
          updated++;
        } else {
          await mappingRepo.save(
            mappingRepo.create({
              mediumCode,
              clientId,
              campaignInfoId: campaign.id,
              notes: noteWithMedium,
              isActive: true,
            }),
          );
          created++;
        }
      }
    }

    console.log('--- ads_mapping seed complete ---');
    console.log(`Rows read: ${rows.length}`);
    console.log(`Created mappings: ${created}`);
    console.log(`Updated mappings: ${updated}`);
    console.log(`Skipped rows (missing client_id): ${skippedMissingClientId}`);
    console.log(`Skipped rows (missing campaign id): ${skippedMissingCampaignId}`);
    console.log(`Skipped rows (missing mediums): ${skippedMissingMediums}`);
    console.log(`Skipped rows (campaign not found): ${skippedCampaignNotFound}`);
    console.log(`Skipped rows (provider != google): ${skippedProviderMismatch}`);
    console.log(`Overwritten existing medium-client campaign bindings: ${overwrittenCampaignBinding}`);
    if (headerNote) {
      console.log(`Applied default note from header: "${headerNote}"`);
      if (mandatoryCodes.length) {
        console.log(`Added mandatory medium codes from header note: ${mandatoryCodes.join(', ')}`);
      }
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

