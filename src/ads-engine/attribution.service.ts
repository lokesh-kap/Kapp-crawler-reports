import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class AttributionService {
  private readonly logger = new Logger(AttributionService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Pushes scraper lead counts into campaign_metrics.
   * Adapted from nest-scraper.
   * Matches on campaign code format: kollegeapply/{mediumCode}/{year}
   */
  async syncAttribution() {
    this.logger.log('Starting Lead Attribution Sync...');

    const sql = `
      WITH lead_attribution AS (
        SELECT DISTINCT ON (l.id)
          l.id,
          am."campaignInfoId",
          (l.created_at AT TIME ZONE 'Asia/Kolkata')::date AS lead_date,
          l.paid_applications
        FROM client_wise_leads_data l
        INNER JOIN ads_mapping am
           ON (
             l.campaign ILIKE '%/' || am."mediumCode" || '/%'
             OR l.campaign = am."mediumCode"
           )
          AND am."clientId" = l.client_id
        WHERE am."campaignInfoId" IS NOT NULL
          AND am."isActive" = true
        ORDER BY l.id,
          (l.campaign ILIKE '%/' || am."mediumCode" || '/%') DESC,
          length(am."mediumCode") DESC
      ),
      lead_stats AS (
        SELECT
          "campaignInfoId",
          lead_date,
          COUNT(id) AS total_leads,
          SUM(
            CASE
              WHEN paid_applications ~ '^[0-9]+$' THEN CAST(paid_applications AS INTEGER)
              WHEN paid_applications = 'Yes' THEN 1
              ELSE 0
            END
          ) AS total_apps
        FROM lead_attribution
        GROUP BY "campaignInfoId", lead_date
      )
      UPDATE campaign_metrics cm
      SET
        leads = ls.total_leads,
        applications = ls.total_apps,
        cpl = CASE WHEN ls.total_leads > 0
                    THEN (CAST(cm.spend AS DECIMAL) / ls.total_leads)
                    ELSE 0 END,
        "updatedAt" = NOW()
      FROM lead_stats ls
      WHERE cm."campaignInfoId" = ls."campaignInfoId"
        AND cm.date = ls.lead_date;
    `;

    try {
      await this.dataSource.query(sql);
      this.logger.log('Lead Attribution Sync successful.');
      return { success: true };
    } catch (err: any) {
      this.logger.error(`Lead Attribution Sync failed: ${err.message}`);
      throw err;
    }
  }
}
