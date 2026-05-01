import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import axios from 'axios';
import * as ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as path from 'path';
import { MailerService } from '../common/mailer/mailer.service';
import { buildEmailTemplate } from '../common/mailer/email-template';

@Injectable()
export class OverallClientReportService {
  private readonly logger = new Logger(OverallClientReportService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailer: MailerService,
  ) { }

  async generateAndSendReport() {
    this.logger.log('📊 Generating Overall Client Report for configured clients...');
    const reportDate = this.getReportDateString();
    const reportDateObj = this.getReportDateObject(reportDate);
    const reportNote =
      'NOTE: This report is auto-generated. If you notice any incorrect data, please let us know so we can investigate and fix the issue at the source. LMS is being updated, upon which the null values in the report will also be updated with the correct fetched values.';

    // 1. Fetch active client IDs from local DB (same base used by scraper runs)
    const activeRows = await this.dataSource.query(`
      SELECT DISTINCT ON (cw.client_id) cw.client_id
      FROM client_wise cw
      WHERE cw.is_active = true
        AND cw.config_id IS NOT NULL
      ORDER BY cw.client_id, cw.id DESC
    `);
    const configuredIds = activeRows.map(r => Number(r.client_id));

    if (configuredIds.length === 0) {
      this.logger.warn('⚠️ No active clients found in client_wise. Report will be empty.');
      return { success: true, message: 'No active clients found.' };
    }

    // 2. Fetch client details from LMS only for those IDs
    const clients = await this.fetchClientsFromLms(configuredIds);
    const reportClients = clients
      .map((c) => ({
        ...c,
        effective_account_zone: this.normalizeLmsValue(c.account_zone),
      }))
      .filter((c) => this.isCampaignStatusActive(this.resolveCampaignStatusForReport(c)));
    this.logger.log(
      `📋 Report scope: ${reportClients.length} client(s) with active DB config and Active LMS campaign status (of ${clients.length} configured).`,
    );
    const leads = await this.fetchLeadTotals(reportDate);

    // Group by account_zone - FILTER OUT empty/null zones for dedicated emails
    const zones = [...new Set(
      reportClients
        .map(c => (c.effective_account_zone || '').trim())
        .filter(z => z !== '' && z.toLowerCase() !== 'null' && z.toLowerCase() !== 'undefined')
    )];

    this.logger.log(`🌍 Found ${zones.length} valid zones for dedicated emails: ${zones.join(', ')}`);

    for (const zone of zones) {
      this.logger.log(`📑 Generating report for zone: ${zone}`);
      const zoneClients = reportClients.filter(c => (c.effective_account_zone || '').trim() === zone);
      if (zoneClients.length === 0) continue;

      const { buffer, rowsData, columnsData } = await this.buildExcel(zoneClients, leads, reportDateObj);

      const emailHtml = buildEmailTemplate({
        title: `${zone} Zone - Client Report`,
        subtitle: `Daily Performance Summary | Zone Clients: ${zoneClients.length}`,
        date: reportDate,
        summaryCards: [],
        summaryTable: this.buildZoneWiseSummaryForTemplate(rowsData),
        mainTableHasTotalRow: true,
        columns: columnsData,
        rows: this.buildMainTableRowsWithTotal(rowsData, columnsData),
      footerNote: `Report generated for ${zoneClients.length} clients in ${zone} zone with active DB config and Active LMS campaign status. ${reportNote}`
      });

      // Normalize zone name for env variables (e.g. "North Zone" -> "NORTH_ZONE")
      const zoneKey = zone.toUpperCase().replace(/[^A-Z0-9]/g, '_');

      const zoneToEnv = process.env[`REPORT_${zoneKey}_TO`] || '';
      const zoneCcEnv = process.env[`REPORT_${zoneKey}_CC`] || '';

      const toList = zoneToEnv.split(',').map(s => s.trim()).filter(s => s);
      const ccList = zoneCcEnv.split(',').map(s => s.trim()).filter(s => s);

      if (toList.length === 0) {
        this.logger.warn(`⏭️ Skipping email for ${zone} Zone: No TO recipients configured.`);
        continue;
      }

      await this.mailer.sendMail({
        to: toList,
        cc: ccList.length > 0 ? ccList : undefined,
        subject: `📊 ${zone} Zone Client Report — ${reportDate}`,
        html: emailHtml,
        // attachments: [{
        //   filename: `${zone}_Zone_Report_${reportDate}.xlsx`,
        //   content: buffer,
        // }],
      });
    }

    // Also send the original overall report as before
    const { buffer: overallBuffer, rowsData: overallRows, columnsData: overallCols } = await this.buildExcel(reportClients, leads, reportDateObj);

    const overallEmailHtml = buildEmailTemplate({
      title: 'Overall Client Report',
      subtitle: `Daily Performance Summary | Total Clients: ${reportClients.length}`,
      date: reportDate,
      summaryCards: [],
      summaryTable: this.buildZoneSummaryForTemplate(overallRows, reportDateObj),
      mainTableHasTotalRow: true,
      columns: overallCols,
      rows: this.buildMainTableRowsWithTotal(overallRows, overallCols),
      footerNote: `Overall report generated for ${reportClients.length} client(s) with active DB config and Active LMS campaign status. ${reportNote}`
    });

    const overallToEnv = process.env.REPORT_OVERALL_TO || '';
    const overallCcEnv = process.env.REPORT_OVERALL_CC || '';

    const overallToList = overallToEnv.split(',').map((s) => s.trim()).filter(s => s);
    const overallCcList = overallCcEnv.split(',').map((s) => s.trim()).filter(s => s);

    if (overallToList.length === 0) {
      this.logger.warn(`⏭️ Skipping Overall Client Report email: No TO recipients configured.`);
      return { success: true, message: 'Skipped - no recipients' };
    }

    await this.mailer.sendMail({
      to: overallToList,
      cc: overallCcList.length > 0 ? overallCcList : undefined,
      subject: `📊 Overall Client Report — ${reportDate}`,
      html: overallEmailHtml,
      // attachments: [{
      //   filename: `Overall_Client_Report_${reportDate}.xlsx`,
      //   content: overallBuffer,
      // }],
    });

    return { success: true };
  }

  private async fetchClientsFromLms(clientIds: number[]): Promise<any[]> {
    const backendUrl = (process.env.LMS_BACKEND_URL || 'http://127.0.0.1:9001').replace(
      /\/+$/,
      '',
    );
    const apiKey = process.env.REPORTING_METADATA_API_SECRET_KEY || 'kapp-crawler-reports';
    try {
      this.logger.log(`📡 Fetching client metadata from LMS API: ${backendUrl}`);
      const response = await axios.get(`${backendUrl}/clients/reporting-metadata`, {
        headers: {
          'x-api-key': apiKey
        }
      });
      const allClients = response.data?.data || [];

      // Filter locally for the requested IDs and map keys
      const filtered = allClients
        .filter((c: any) => clientIds.includes(Number(c.client_id)))
        .map((c: any) => ({
          ...c,
          state: c.client_state, // Map client_state to state for Excel
        }));

      this.logger.log(`✅ Successfully fetched ${filtered.length} clients from LMS API.`);
      return filtered;
    } catch (error) {
      this.logger.error(`❌ Failed to fetch clients from LMS API: ${error.message}`);
      return [];
    }
  }

  private async fetchLeadTotals(reportDate: string): Promise<Record<number, any>> {
    const rows: any[] = await this.dataSource.query(`
      WITH daily_latest AS (
        SELECT 
          client_id, filter_applied, funnel_source, primary_leads, verified_leads, secondary_leads, tertiary_leads,
          ROW_NUMBER() OVER(
            PARTITION BY client_id, filter_applied, funnel_source, (created_at AT TIME ZONE 'Asia/Kolkata')::date
            ORDER BY created_at DESC
          ) as intra_day_rn,
          (created_at AT TIME ZONE 'Asia/Kolkata')::date as scrape_date
        FROM npf_funnel_summary
      ),
      today_latest AS (
        SELECT *
        FROM daily_latest
        WHERE intra_day_rn = 1
          AND scrape_date = $1::date
      ),
      yesterday_latest AS (
        SELECT *
        FROM daily_latest
        WHERE intra_day_rn = 1
          AND scrape_date = ($1::date - INTERVAL '1 day')
      ),
      ranked_filters AS (
        SELECT *,
               ROW_NUMBER() OVER(PARTITION BY client_id, filter_applied, funnel_source ORDER BY scrape_date DESC) as rn
        FROM daily_latest
        WHERE intra_day_rn = 1
      ),
      m0_start AS (
        SELECT DISTINCT ON (client_id, filter_applied, funnel_source) client_id, filter_applied, funnel_source, primary_leads
        FROM npf_funnel_summary
        WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date >= DATE_TRUNC('month', $1::date)::date
        ORDER BY client_id, filter_applied, funnel_source, created_at ASC
      ),
      m1_start AS (
        SELECT DISTINCT ON (client_id, filter_applied, funnel_source) client_id, filter_applied, funnel_source, primary_leads
        FROM npf_funnel_summary
        WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date >= DATE_TRUNC('month', $1::date - INTERVAL '1 month')::date
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date < DATE_TRUNC('month', $1::date)::date
        ORDER BY client_id, filter_applied, funnel_source, created_at ASC
      )
      SELECT 
        c.client_id,
        NULLIF(REGEXP_REPLACE(trp.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric AS primary_application,
        CASE WHEN trp.primary_leads IS NULL OR yrp.primary_leads IS NULL THEN NULL ELSE GREATEST(0, COALESCE(NULLIF(REGEXP_REPLACE(trp.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) - COALESCE(NULLIF(REGEXP_REPLACE(yrp.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS yesterday_application,
        CASE WHEN trn.primary_leads IS NULL OR yrn.primary_leads IS NULL THEN NULL ELSE GREATEST(0, COALESCE(NULLIF(REGEXP_REPLACE(trn.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) - COALESCE(NULLIF(REGEXP_REPLACE(yrn.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS yesterday_primary_leads,
        NULLIF(REGEXP_REPLACE(trn.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric AS total_primary_leads,
        NULLIF(REGEXP_REPLACE(trn.verified_leads, '[^0-9.-]', '', 'g'), '')::numeric AS prim_verified_leads,
        NULLIF(REGEXP_REPLACE(trfi.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric AS primary_form_initiated,
        NULLIF(REGEXP_REPLACE(tren.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric AS primary_admission,
        CASE WHEN tren.primary_leads IS NULL OR yren.primary_leads IS NULL THEN NULL ELSE GREATEST(0, COALESCE(NULLIF(REGEXP_REPLACE(tren.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) - COALESCE(NULLIF(REGEXP_REPLACE(yren.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS yesterday_admission,
        -- Month-1 Achievement (Start of M0 - Start of M1) e.g. (Apr 1st - Mar 1st)
        CASE WHEN ms0.primary_leads IS NULL OR ms1.primary_leads IS NULL THEN NULL ELSE GREATEST(0, COALESCE(NULLIF(REGEXP_REPLACE(ms0.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) - COALESCE(NULLIF(REGEXP_REPLACE(ms1.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS month_1_adm_achieved,
        CASE WHEN aps0.primary_leads IS NULL OR aps1.primary_leads IS NULL THEN NULL ELSE GREATEST(0, COALESCE(NULLIF(REGEXP_REPLACE(aps0.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) - COALESCE(NULLIF(REGEXP_REPLACE(aps1.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS month_1_app_achieved,
        CASE WHEN trn.secondary_leads IS NULL OR trn.tertiary_leads IS NULL THEN NULL ELSE (COALESCE(NULLIF(REGEXP_REPLACE(trn.secondary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) + COALESCE(NULLIF(REGEXP_REPLACE(trn.tertiary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS duplicate_lead,
        CASE WHEN trp.secondary_leads IS NULL OR trp.tertiary_leads IS NULL THEN NULL ELSE (COALESCE(NULLIF(REGEXP_REPLACE(trp.secondary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) + COALESCE(NULLIF(REGEXP_REPLACE(trp.tertiary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS duplicate_application,
        CASE WHEN tren.secondary_leads IS NULL OR tren.tertiary_leads IS NULL THEN NULL ELSE (COALESCE(NULLIF(REGEXP_REPLACE(tren.secondary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) + COALESCE(NULLIF(REGEXP_REPLACE(tren.tertiary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS duplicate_admission
      FROM (SELECT DISTINCT client_id FROM npf_funnel_summary) c
      LEFT JOIN yesterday_latest yrn ON yrn.client_id = c.client_id AND yrn.funnel_source = 'lead_view' AND yrn.filter_applied = 'None'
      LEFT JOIN yesterday_latest yrp ON yrp.client_id = c.client_id AND yrp.funnel_source = 'lead_view' AND yrp.filter_applied = 'Paid Apps'
      LEFT JOIN yesterday_latest yren ON yren.client_id = c.client_id AND yren.funnel_source = 'lead_view' AND yren.filter_applied = 'Enrolment Status'
      LEFT JOIN today_latest trn ON trn.client_id = c.client_id AND trn.funnel_source = 'lead_view' AND trn.filter_applied = 'None'
      LEFT JOIN today_latest trp ON trp.client_id = c.client_id AND trp.funnel_source = 'lead_view' AND trp.filter_applied = 'Paid Apps'
      LEFT JOIN today_latest trfi ON trfi.client_id = c.client_id AND trfi.funnel_source = 'lead_view' AND trfi.filter_applied = 'Form Initiated'
      LEFT JOIN today_latest tren ON tren.client_id = c.client_id AND tren.funnel_source = 'lead_view' AND tren.filter_applied = 'Enrolment Status'
      LEFT JOIN m0_start ms0 ON ms0.client_id = c.client_id AND ms0.funnel_source = 'lead_view' AND ms0.filter_applied = 'Enrolment Status'
      LEFT JOIN m1_start ms1 ON ms1.client_id = c.client_id AND ms1.funnel_source = 'lead_view' AND ms1.filter_applied = 'Enrolment Status'
      LEFT JOIN m0_start aps0 ON aps0.client_id = c.client_id AND aps0.funnel_source = 'lead_view' AND aps0.filter_applied = 'Paid Apps'
      LEFT JOIN m1_start aps1 ON aps1.client_id = c.client_id AND aps1.funnel_source = 'lead_view' AND aps1.filter_applied = 'Paid Apps'
    `, [reportDate]);
    const map: Record<number, any> = {};
    rows.forEach((r) => {
      map[Number(r.client_id)] = {
        primary_application: r.primary_application != null ? Number(r.primary_application) : null,
        yesterday_application: r.yesterday_application != null ? Number(r.yesterday_application) : null,
        yesterday_primary_leads: r.yesterday_primary_leads != null ? Number(r.yesterday_primary_leads) : null,
        total_primary_leads: r.total_primary_leads != null ? Number(r.total_primary_leads) : null,
        prim_verified_leads: r.prim_verified_leads != null ? Number(r.prim_verified_leads) : null,
        primary_form_initiated: r.primary_form_initiated != null ? Number(r.primary_form_initiated) : null,
        primary_admission: r.primary_admission != null ? Number(r.primary_admission) : null,
        yesterday_admission: r.yesterday_admission != null ? Number(r.yesterday_admission) : null,
        month_1_adm_achieved: r.month_1_adm_achieved != null ? Number(r.month_1_adm_achieved) : null,
        month_1_app_achieved: r.month_1_app_achieved != null ? Number(r.month_1_app_achieved) : null,
        duplicate_lead: r.duplicate_lead != null ? Number(r.duplicate_lead) : null,
        duplicate_application: r.duplicate_application != null ? Number(r.duplicate_application) : null,
        duplicate_admission: r.duplicate_admission != null ? Number(r.duplicate_admission) : null
      };
    });
    return map;
  }

  private async buildExcel(clients: any[], leads: Record<number, any>, reportDate: Date): Promise<{ buffer: Buffer; rowsData: any[]; columnsData: any[] }> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Overall Client Report');

    const now = reportDate;
    // Month-1 (e.g. March)
    const m1Date = new Date();
    m1Date.setDate(1);
    m1Date.setMonth(now.getMonth() - 1);
    const m1Name = m1Date.toLocaleString('default', { month: 'short' });

    const rawColumns = [
      { header: 'S.No', key: 'sno', width: 18 },
      { header: 'No. of Days', key: 'no_of_days', width: 12 },
      { header: 'Client Name', key: 'client_name', width: 20 },
      { header: 'Campaign Status', key: 'campaign_status', width: 12 },
      { header: 'Deal Type', key: 'deal_type', width: 15 },
      { header: 'OPS AM', key: 'ops_am', width: 18 },
      { header: 'CRM', key: 'crm', width: 15 },
      { header: 'Primary Application', key: 'primary_application', width: 20 },
      { header: 'Yesterday Application Achieved', key: 'yesterday_application', width: 25 },
      { header: `${m1Name} Application Achieved`, key: 'month_1_app_achieved', width: 25 },
      { header: 'Yesterday Primary Lead', key: 'yesterday_primary_leads', width: 22 },
      { header: 'Primary Lead', key: 'total_primary_leads', width: 22 },
      { header: 'Prim. Verified Leads', key: 'prim_verified_leads', width: 22 },
      { header: 'Primary Form Initiated', key: 'primary_form_initiated', width: 22 },
      { header: 'Primary Admission', key: 'primary_admission', width: 20 },
      { header: 'Yesterday Admission Achieved', key: 'yesterday_admission', width: 25 },
      { header: `${m1Name} Admission Achieved`, key: 'month_1_adm_achieved', width: 25 },
      { header: 'Duplicate Lead', key: 'duplicate_lead', width: 20 },
      { header: 'Duplicate Application', key: 'duplicate_application', width: 22 },
      { header: 'Duplicate Admission', key: 'duplicate_admission', width: 22 },
      { header: 'Target Lead', key: 'target_lead', width: 15 },
      { header: 'Target Application', key: 'target_application', width: 18 },
      { header: 'Target Admission', key: 'target_admission', width: 18 },
      { header: 'Sales TL', key: 'sales_tl', width: 22 },
      { header: 'OPS TL', key: 'ops_tl', width: 22 },
      { header: 'State', key: 'state', width: 20 },
    ];

    ws.columns = rawColumns;

    // Map Excel columns to the Email Template format { key, label }
    const columnsData = rawColumns.map(c => ({ key: c.key, label: c.header }));


    // ---------------------------------------------------------------------
    // LOAD HISTORICAL M1 DATA FROM CSV (Specifically for March data)
    // ---------------------------------------------------------------------
    const manualHistoricalData: Record<string, { app: number; adm: number }> = {};

    // Only inject manual March data when the report is generating in April (month index 3)
    // Once May starts, the DB will natively have full snapshots for April!
    if (now.getMonth() === 3) {
      const csvPath = path.join(process.cwd(), 'data', 'Mar-Adm-App.csv');
      if (fs.existsSync(csvPath)) {
        try {
          const fileContent = fs.readFileSync(csvPath, 'utf-8');
          const lines = fileContent.split('\n');

          for (let i = 2; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const parts = line.split(',');
            if (parts.length >= 4) {
              const clientName = parts[1].trim(); // Index 1 is Client Name
              const apps = parseInt(parts[2].trim(), 10) || 0;
              const adms = parseInt(parts[3].trim(), 10) || 0;
              manualHistoricalData[clientName] = { app: apps, adm: adms };
            }
          }
          this.logger.log(`📥 Successfully loaded manual March historical data for ${Object.keys(manualHistoricalData).length} clients from CSV.`);
        } catch (e) {
          this.logger.error(`Failed to read data/Mar-Adm-App.csv: ${(e as Error).message}`);
        }
      }
    }

    const rowsData: any[] = [];
    const sortedClients = [...clients].sort((a, b) => {
      const aPrimaryApplication = Number(leads[Number(a.client_id)]?.primary_application ?? 0);
      const bPrimaryApplication = Number(leads[Number(b.client_id)]?.primary_application ?? 0);
      return bPrimaryApplication - aPrimaryApplication;
    });

    sortedClients.forEach((c, idx) => {
      const m = leads[Number(c.client_id)] || {};
      let days = 0;
      if (this.hasValue(c.on_boarding_date)) {
        const onboard = new Date(String(c.on_boarding_date));
        if (!Number.isNaN(onboard.getTime())) {
          days = Math.ceil((now.getTime() - onboard.getTime()) / (1000 * 60 * 60 * 24));
        }
      }

      // Check for manual overrides from the CSV (if DB calculated null or wasn't tracking yet)
      const historicalM1Apps = manualHistoricalData[c.client_name]?.app ?? m.month_1_app_achieved ?? null;
      const historicalM1Adms = manualHistoricalData[c.client_name]?.adm ?? m.month_1_adm_achieved ?? null;

      const rowData = {
        sno: idx + 1,
        no_of_days: days > 0 ? days : '',
        // Always from LMS (per business rule)
        client_name: this.normalizeLmsValue(c.client_name),
        campaign_status: this.normalizeLmsValue(c.campaign_status ?? c.status),
        deal_type: this.normalizeLmsValue(c.deal_type),
        ops_am: this.normalizeLmsValue(c.ops_am),
        crm: this.normalizeLmsValue(c.crm),
        primary_application: m.primary_application ?? '',
        yesterday_application: m.yesterday_application ?? '',
        month_1_app_achieved: historicalM1Apps ?? '',
        yesterday_primary_leads: m.yesterday_primary_leads ?? '',
        total_primary_leads: m.total_primary_leads ?? '',
        prim_verified_leads: m.prim_verified_leads ?? '',
        primary_form_initiated: m.primary_form_initiated ?? '',
        primary_admission: m.primary_admission ?? '',
        yesterday_admission: m.yesterday_admission ?? '',
        month_1_adm_achieved: historicalM1Adms ?? '',
        duplicate_lead: m.duplicate_lead ?? '',
        duplicate_application: m.duplicate_application ?? '',
        duplicate_admission: m.duplicate_admission ?? '',
        target_lead: this.normalizeLmsValue(c.target_lead),
        target_application: this.normalizeLmsValue(c.target_application),
        target_admission: this.normalizeLmsValue(c.target_admission),
        sales_tl: this.normalizeLmsValue(c.sales_tl),
        ops_tl: this.normalizeLmsValue(c.ops_tl),
        state: this.normalizeLmsValue(c.client_state),
        zone: this.normalizeLmsValue(c.effective_account_zone ?? c.account_zone),
      };

      ws.addRow(rowData);
      rowsData.push(rowData);
    });

    const numericTotalKeys = new Set([
      'primary_application',
      'yesterday_application',
      'month_1_app_achieved',
      'yesterday_primary_leads',
      'total_primary_leads',
      'prim_verified_leads',
      'primary_form_initiated',
      'primary_admission',
      'yesterday_admission',
      'month_1_adm_achieved',
      'duplicate_lead',
      'duplicate_application',
      'duplicate_admission',
      'target_lead',
      'target_application',
      'target_admission',
    ]);
    const parseNum = (v: unknown): number => {
      if (v === null || v === undefined || v === '') return 0;
      const n = Number(String(v).replace(/,/g, '').trim());
      return Number.isFinite(n) ? n : 0;
    };
    const totalRowData: Record<string, number | string> = {};
    for (const col of rawColumns) {
      if (numericTotalKeys.has(col.key)) {
        totalRowData[col.key] = rowsData.reduce((acc, row) => acc + parseNum(row[col.key]), 0);
      } else {
        totalRowData[col.key] = '';
      }
    }
    const summaryColumns = [
      { header: 'Operation Manager', key: 'ops_am' },
      { header: 'Zone', key: 'zone' },
      { header: 'Accounts', key: 'accounts' },
      { header: 'Zero App Accounts', key: 'zero_app_accounts' },
      { header: 'Primary Application', key: 'primary_application' },
      { header: 'Yesterday Application Achieved', key: 'yesterday_application' },
      { header: `${m1Name} Application Achieved`, key: 'month_1_app_achieved' },
      { header: 'Yesterday Primary Leads', key: 'yesterday_primary_leads' },
      { header: 'Primary Lead', key: 'total_primary_leads' },
      { header: 'Primary Verified Lead', key: 'prim_verified_leads' },
      { header: 'Primary Form Initiated', key: 'primary_form_initiated' },
      { header: 'Primary Admission', key: 'primary_admission' },
      { header: 'Yesterday Admission Achieved', key: 'yesterday_admission' },
      { header: `${m1Name} Admission Achieved`, key: 'month_1_adm_achieved' },
      { header: 'Duplicate Lead', key: 'duplicate_lead' },
      { header: 'Duplicate Application', key: 'duplicate_application' },
      { header: 'Duplicate Admission', key: 'duplicate_admission' },
      { header: 'Target Lead', key: 'target_lead' },
      { header: 'Target Application', key: 'target_application' },
      { header: 'Target Admission', key: 'target_admission' },
    ];
    const staticOpsByZone: Record<string, string> = {
      west: 'Govind Mahara',
      east: 'Dinesh Singh',
      north: 'Dinesh Singh',
      south: 'Govind Mahara',
    };
    const summaryMap = new Map<string, Record<string, string | number>>();
    for (const row of rowsData) {
      const zone = String(row.zone ?? '').trim() || 'N/A';
      const opsAm = staticOpsByZone[zone.toLowerCase()] || 'N/A';
      const k = `${opsAm}__${zone}`;
      if (!summaryMap.has(k)) {
        summaryMap.set(k, {
          ops_am: opsAm,
          zone,
          accounts: 0,
          zero_app_accounts: 0,
          primary_application: 0,
          yesterday_application: 0,
          month_1_app_achieved: 0,
          yesterday_primary_leads: 0,
          total_primary_leads: 0,
          prim_verified_leads: 0,
          primary_form_initiated: 0,
          primary_admission: 0,
          yesterday_admission: 0,
          month_1_adm_achieved: 0,
          duplicate_lead: 0,
          duplicate_application: 0,
          duplicate_admission: 0,
          target_lead: 0,
          target_application: 0,
          target_admission: 0,
        });
      }
      const g = summaryMap.get(k)!;
      g.accounts = Number(g.accounts) + 1;
      const app = parseNum(row.primary_application);
      if (app === 0) g.zero_app_accounts = Number(g.zero_app_accounts) + 1;
      g.primary_application = Number(g.primary_application) + app;
      g.yesterday_application = Number(g.yesterday_application) + parseNum(row.yesterday_application);
      g.month_1_app_achieved = Number(g.month_1_app_achieved) + parseNum(row.month_1_app_achieved);
      g.yesterday_primary_leads = Number(g.yesterday_primary_leads) + parseNum(row.yesterday_primary_leads);
      g.total_primary_leads = Number(g.total_primary_leads) + parseNum(row.total_primary_leads);
      g.prim_verified_leads = Number(g.prim_verified_leads) + parseNum(row.prim_verified_leads);
      g.primary_form_initiated = Number(g.primary_form_initiated) + parseNum(row.primary_form_initiated);
      g.primary_admission = Number(g.primary_admission) + parseNum(row.primary_admission);
      g.yesterday_admission = Number(g.yesterday_admission) + parseNum(row.yesterday_admission);
      g.month_1_adm_achieved = Number(g.month_1_adm_achieved) + parseNum(row.month_1_adm_achieved);
      g.duplicate_lead = Number(g.duplicate_lead) + parseNum(row.duplicate_lead);
      g.duplicate_application = Number(g.duplicate_application) + parseNum(row.duplicate_application);
      g.duplicate_admission = Number(g.duplicate_admission) + parseNum(row.duplicate_admission);
      g.target_lead = Number(g.target_lead) + parseNum(row.target_lead);
      g.target_application = Number(g.target_application) + parseNum(row.target_application);
      g.target_admission = Number(g.target_admission) + parseNum(row.target_admission);
    }
    const summaryRows = Array.from(summaryMap.values()).sort((a, b) => {
      const x = String(a.ops_am).localeCompare(String(b.ops_am));
      return x !== 0 ? x : String(a.zone).localeCompare(String(b.zone));
    });
    const summaryTotals: Record<string, string | number> = { ops_am: '', zone: 'Total' };
    for (const col of summaryColumns.slice(2)) {
      summaryTotals[col.key] = summaryRows.reduce((acc, r) => acc + Number(r[col.key] ?? 0), 0);
    }
    const summaryBlockRows = 2 + summaryRows.length + 1;
    for (let i = 0; i < summaryBlockRows; i += 1) {
      ws.insertRow(1, {});
    }
    const writeSummaryRow = (rowNumber: number, rowData: Record<string, string | number>) => {
      summaryColumns.forEach((col, idx) => {
        ws.getCell(rowNumber, idx + 1).value = rowData[col.key] ?? '';
      });
    };
    writeSummaryRow(1, summaryTotals);
    summaryColumns.forEach((col, idx) => {
      ws.getCell(2, idx + 1).value = col.header;
    });
    summaryRows.forEach((sr, idx) => writeSummaryRow(3 + idx, sr));

    ws.getRow(1).height = 28;
    ws.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F3841' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    ws.getRow(2).height = 32;
    ws.getRow(2).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FF111827' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBFDFAF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF000000' } },
        left: { style: 'thin', color: { argb: 'FF000000' } },
        bottom: { style: 'thin', color: { argb: 'FF000000' } },
        right: { style: 'thin', color: { argb: 'FF000000' } },
      };
    });

    const mainTotalRow = summaryBlockRows + 1;
    ws.insertRow(mainTotalRow, totalRowData);

    ws.getRow(mainTotalRow).height = 30;
    ws.getRow(mainTotalRow).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F3841' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF2F3841' } },
        left: { style: 'thin', color: { argb: 'FF2F3841' } },
        bottom: { style: 'thin', color: { argb: 'FF2F3841' } },
        right: { style: 'thin', color: { argb: 'FF2F3841' } },
      };
    });
    ws.getRow(mainTotalRow + 1).height = 34;
    ws.getRow(mainTotalRow + 1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FF111827' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F5F1' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD1C7B8' } },
        left: { style: 'thin', color: { argb: 'FFD1C7B8' } },
        bottom: { style: 'thin', color: { argb: 'FFD1C7B8' } },
        right: { style: 'thin', color: { argb: 'FFD1C7B8' } },
      };
    });

    const buffer = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
    return { buffer, rowsData, columnsData };
  }

  private resolveCampaignStatusForReport(
    client: Record<string, unknown>,
  ): string {
    return this.normalizeLmsValue(client['campaign_status'] ?? client['status']);
  }

  private isCampaignStatusActive(status: string): boolean {
    return status.toUpperCase() === 'ACTIVE';
  }

  private normalizeLmsValue(v: unknown): string {
    if (!this.hasValue(v)) return '';
    return String(v).trim();
  }

  private hasValue(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    const s = String(v).trim();
    if (!s) return false;
    const lower = s.toLowerCase();
    return lower !== 'null' && lower !== 'undefined' && lower !== 'na' && lower !== 'n/a' && lower !== '-';
  }

  private getReportDateString(): string {
    const override = (process.env.REPORT_AS_OF_DATE || '').trim();
    if (override) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(override)) {
        this.logger.log(`📅 Using REPORT_AS_OF_DATE override: ${override}`);
        return override;
      }
      this.logger.warn(
        `⚠️ Invalid REPORT_AS_OF_DATE="${override}". Expected YYYY-MM-DD. Falling back to current IST date.`,
      );
    }

    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(new Date());
  }

  private getReportDateObject(reportDate: string): Date {
    const [year, month, day] = reportDate.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  private buildZoneSummaryForTemplate(rowsData: any[], reportDate: Date): {
    title: string;
    columns: Array<{ key: string; label: string; align?: 'left' | 'center' | 'right' }>;
    rows: Record<string, any>[];
  } {
    const staticOpsByZone: Record<string, string> = {
      west: 'Govind Mahara',
      east: 'Dinesh Singh',
      north: 'Dinesh Singh',
      south: 'Govind Mahara',
    };
    const m1Date = new Date(reportDate);
    m1Date.setDate(1);
    m1Date.setMonth(reportDate.getMonth() - 1);
    const m1Name = m1Date.toLocaleString('default', { month: 'short' });
    const cols = [
      { key: 'ops_am', label: 'Operation Manager' },
      { key: 'zone', label: 'Zone' },
      { key: 'accounts', label: 'Accounts', align: 'right' as const },
      { key: 'zero_app_accounts', label: 'Zero App Accounts', align: 'right' as const },
      { key: 'primary_application', label: 'Primary Application', align: 'right' as const },
      { key: 'yesterday_application', label: 'Yesterday Application Achieved', align: 'right' as const },
      { key: 'month_1_app_achieved', label: `${m1Name} Application Achieved`, align: 'right' as const },
      { key: 'yesterday_primary_leads', label: 'Yesterday Primary Leads', align: 'right' as const },
      { key: 'total_primary_leads', label: 'Primary Lead', align: 'right' as const },
      { key: 'prim_verified_leads', label: 'Primary Verified Lead', align: 'right' as const },
      { key: 'primary_form_initiated', label: 'Primary Form Initiated', align: 'right' as const },
      { key: 'primary_admission', label: 'Primary Admission', align: 'right' as const },
      { key: 'yesterday_admission', label: 'Yesterday Admission Achieved', align: 'right' as const },
      { key: 'month_1_adm_achieved', label: `${m1Name} Admission Achieved`, align: 'right' as const },
      { key: 'duplicate_lead', label: 'Duplicate Lead', align: 'right' as const },
      { key: 'duplicate_application', label: 'Duplicate Application', align: 'right' as const },
      { key: 'duplicate_admission', label: 'Duplicate Admission', align: 'right' as const },
      { key: 'target_lead', label: 'Target Lead', align: 'right' as const },
      { key: 'target_application', label: 'Target Application', align: 'right' as const },
      { key: 'target_admission', label: 'Target Admission', align: 'right' as const },
    ];
    const parseNum = (v: unknown): number => {
      if (v === null || v === undefined || v === '') return 0;
      const n = Number(String(v).replace(/,/g, '').trim());
      return Number.isFinite(n) ? n : 0;
    };
    const grouped = new Map<string, Record<string, any>>();
    for (const row of rowsData) {
      const rawZone = String(row.zone ?? row.effective_account_zone ?? row.account_zone ?? '').trim();
      const isZoneMissing = !rawZone || rawZone === '-' || /^n\/?a$/i.test(rawZone);
      const zone = isZoneMissing ? 'Not Available' : rawZone;
      const opsAm = isZoneMissing ? '-' : (staticOpsByZone[zone.toLowerCase()] || '-');
      const key = `${opsAm}__${zone}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          ops_am: opsAm,
          zone,
          accounts: 0,
          zero_app_accounts: 0,
          primary_application: 0,
          yesterday_application: 0,
          month_1_app_achieved: 0,
          yesterday_primary_leads: 0,
          total_primary_leads: 0,
          prim_verified_leads: 0,
          primary_form_initiated: 0,
          primary_admission: 0,
          yesterday_admission: 0,
          month_1_adm_achieved: 0,
          duplicate_lead: 0,
          duplicate_application: 0,
          duplicate_admission: 0,
          target_lead: 0,
          target_application: 0,
          target_admission: 0,
        });
      }
      const g = grouped.get(key)!;
      g.accounts += 1;
      const primaryApp = parseNum(row.primary_application);
      if (primaryApp === 0) g.zero_app_accounts += 1;
      g.primary_application += primaryApp;
      g.yesterday_application += parseNum(row.yesterday_application);
      g.month_1_app_achieved += parseNum(row.month_1_app_achieved);
      g.yesterday_primary_leads += parseNum(row.yesterday_primary_leads);
      g.total_primary_leads += parseNum(row.total_primary_leads);
      g.prim_verified_leads += parseNum(row.prim_verified_leads);
      g.primary_form_initiated += parseNum(row.primary_form_initiated);
      g.primary_admission += parseNum(row.primary_admission);
      g.yesterday_admission += parseNum(row.yesterday_admission);
      g.month_1_adm_achieved += parseNum(row.month_1_adm_achieved);
      g.duplicate_lead += parseNum(row.duplicate_lead);
      g.duplicate_application += parseNum(row.duplicate_application);
      g.duplicate_admission += parseNum(row.duplicate_admission);
      g.target_lead += parseNum(row.target_lead);
      g.target_application += parseNum(row.target_application);
      g.target_admission += parseNum(row.target_admission);
    }
    const rows = Array.from(grouped.values()).sort((a, b) => {
      const aIsNAZone = String(a.zone) === 'Not Available';
      const bIsNAZone = String(b.zone) === 'Not Available';
      if (aIsNAZone !== bIsNAZone) return aIsNAZone ? 1 : -1;
      const x = String(a.ops_am).localeCompare(String(b.ops_am));
      return x !== 0 ? x : String(a.zone).localeCompare(String(b.zone));
    });
    const total: Record<string, any> = {
      ops_am: '',
      zone: 'Total',
    };
    cols.slice(2).forEach((c) => {
      total[c.key] = rows.reduce((acc, r) => acc + Number(r[c.key] ?? 0), 0);
    });
    return {
      title: '',
      columns: cols,
      rows: [total, ...rows],
    };
  }

  private buildZoneWiseSummaryForTemplate(rowsData: any[]): {
    title: string;
    layout?: 'horizontal' | 'vertical';
    position?: 'beforeHeader' | 'afterHeader';
    columns: Array<{ key: string; label: string; align?: 'left' | 'center' | 'right' }>;
    rows: Record<string, any>[];
  } {
    const cols = [
      { key: 'total_accounts', label: 'Total Accounts', align: 'right' as const },
      { key: 'active_accounts', label: 'Active Accounts', align: 'right' as const },
      { key: 'yesterday_primary_leads', label: 'Yesterday Primary Leads', align: 'right' as const },
      { key: 'yesterday_applications', label: 'Yesterday Applications', align: 'right' as const },
      { key: 'total_applications', label: 'Total Applications', align: 'right' as const },
    ];
    const parseNum = (v: unknown): number => {
      if (v === null || v === undefined || v === '') return 0;
      const n = Number(String(v).replace(/,/g, '').trim());
      return Number.isFinite(n) ? n : 0;
    };
    const totalAccounts = rowsData.length;
    const activeAccounts = rowsData.filter(
      (row) => String(row.campaign_status ?? '').trim().toUpperCase() === 'ACTIVE',
    ).length;
    const summary = {
      total_accounts: totalAccounts,
      active_accounts: activeAccounts,
      yesterday_primary_leads: rowsData.reduce(
        (acc, row) => acc + parseNum(row.yesterday_primary_leads),
        0,
      ),
      yesterday_applications: rowsData.reduce(
        (acc, row) => acc + parseNum(row.yesterday_application),
        0,
      ),
      total_applications: rowsData.reduce((acc, row) => acc + parseNum(row.primary_application), 0),
    };
    return {
      title: '',
      layout: 'vertical',
      position: 'afterHeader',
      columns: cols,
      rows: [summary],
    };
  }

  private buildMainTableRowsWithTotal(
    rowsData: Record<string, any>[],
    columnsData: Array<{ key: string; label: string }>,
  ): Record<string, any>[] {
    const parseNum = (v: unknown): number => {
      if (v === null || v === undefined || v === '') return 0;
      const n = Number(String(v).replace(/,/g, '').trim());
      return Number.isFinite(n) ? n : 0;
    };
    const total: Record<string, any> = {};
    columnsData.forEach((c) => {
      total[c.key] = '';
    });
    if (columnsData.some((c) => c.key === 'client_name')) total.client_name = 'Total';
    const numericKeys = new Set([
      'primary_application',
      'yesterday_application',
      'month_1_app_achieved',
      'yesterday_primary_leads',
      'total_primary_leads',
      'prim_verified_leads',
      'primary_form_initiated',
      'primary_admission',
      'yesterday_admission',
      'month_1_adm_achieved',
      'duplicate_lead',
      'duplicate_application',
      'duplicate_admission',
      'target_lead',
      'target_application',
      'target_admission',
    ]);
    numericKeys.forEach((k) => {
      if (!columnsData.some((c) => c.key === k)) return;
      total[k] = rowsData.reduce((acc, row) => acc + parseNum(row[k]), 0);
    });
    return [total, ...rowsData];
  }

}


