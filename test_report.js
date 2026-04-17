require('dotenv').config();
const { DataSource } = require('typeorm');
const myDataSource = new DataSource({
    type: "postgres",
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: false
});
const pg = require('pg');

async function testSQL() {
  await myDataSource.initialize();
  const rows = await myDataSource.query(`
      daily_latest AS (
        SELECT 
          client_id, filter_applied, funnel_source, primary_leads, verified_leads, secondary_leads, tertiary_leads,
          ROW_NUMBER() OVER(PARTITION BY client_id, filter_applied, funnel_source, created_at::date ORDER BY created_at DESC) as intra_day_rn,
          created_at::date as scrape_date
        FROM npf_funnel_summary
      ),
      ranked_filters AS (
        SELECT *,
               ROW_NUMBER() OVER(PARTITION BY client_id, filter_applied, funnel_source ORDER BY scrape_date DESC) as rn
        FROM daily_latest
        WHERE intra_day_rn = 1
      )
      SELECT 
        c.client_id,
        COALESCE(NULLIF(REPLACE(rp1.primary_leads, ',', ''), '')::numeric, 0) AS primary_application,
        GREATEST(0, COALESCE(NULLIF(REPLACE(rp1.primary_leads, ',', ''), '')::numeric, 0) - COALESCE(NULLIF(REPLACE(rp2.primary_leads, ',', ''), '')::numeric, 0)) AS yesterday_application,
        GREATEST(0, COALESCE(NULLIF(REPLACE(rn1.primary_leads, ',', ''), '')::numeric, 0) - COALESCE(NULLIF(REPLACE(rn2.primary_leads, ',', ''), '')::numeric, 0)) AS yesterday_primary_leads,
        COALESCE(NULLIF(REPLACE(rn1.primary_leads, ',', ''), '')::numeric, 0) AS total_primary_leads,
        COALESCE(NULLIF(REPLACE(rn1.verified_leads, ',', ''), '')::numeric, 0) AS prim_verified_leads,
        COALESCE(NULLIF(REPLACE(rfi1.primary_leads, ',', ''), '')::numeric, 0) AS primary_form_initiated,
        COALESCE(NULLIF(REPLACE(ren1.primary_leads, ',', ''), '')::numeric, 0) AS primary_admission,
        (COALESCE(NULLIF(REPLACE(crn.secondary_leads, ',', ''), '')::numeric, 0) + COALESCE(NULLIF(REPLACE(crn.tertiary_leads, ',', ''), '')::numeric, 0)) AS duplicate_lead,
        (COALESCE(NULLIF(REPLACE(crp.secondary_leads, ',', ''), '')::numeric, 0) + COALESCE(NULLIF(REPLACE(crp.tertiary_leads, ',', ''), '')::numeric, 0)) AS duplicate_application,
        (COALESCE(NULLIF(REPLACE(cre.secondary_leads, ',', ''), '')::numeric, 0) + COALESCE(NULLIF(REPLACE(cre.tertiary_leads, ',', ''), '')::numeric, 0)) AS duplicate_admission
      FROM (SELECT DISTINCT client_id FROM npf_funnel_summary) c
      LEFT JOIN ranked_filters rn1 ON rn1.client_id = c.client_id AND rn1.funnel_source = 'lead_view' AND rn1.filter_applied = 'None' AND rn1.rn = 1
      LEFT JOIN ranked_filters rn2 ON rn2.client_id = c.client_id AND rn2.funnel_source = 'lead_view' AND rn2.filter_applied = 'None' AND rn2.rn = 2
      LEFT JOIN ranked_filters rp1 ON rp1.client_id = c.client_id AND rp1.funnel_source = 'lead_view' AND rp1.filter_applied = 'Paid Apps' AND rp1.rn = 1
      LEFT JOIN ranked_filters rp2 ON rp2.client_id = c.client_id AND rp2.funnel_source = 'lead_view' AND rp2.filter_applied = 'Paid Apps' AND rp2.rn = 2
      LEFT JOIN ranked_filters rfi1 ON rfi1.client_id = c.client_id AND rfi1.funnel_source = 'lead_view' AND rfi1.filter_applied = 'Form Initiated' AND rfi1.rn = 1
      LEFT JOIN ranked_filters ren1 ON ren1.client_id = c.client_id AND ren1.funnel_source = 'lead_view' AND ren1.filter_applied = 'Enrolment Status' AND ren1.rn = 1
      LEFT JOIN ranked_filters crn ON crn.client_id = c.client_id AND crn.funnel_source = 'campaign_view' AND crn.filter_applied = 'None' AND crn.rn = 1
      LEFT JOIN ranked_filters crp ON crp.client_id = c.client_id AND crp.funnel_source = 'campaign_view' AND crp.filter_applied = 'Paid Apps' AND crp.rn = 1
      LEFT JOIN ranked_filters cre ON cre.client_id = c.client_id AND cre.funnel_source = 'campaign_view' AND cre.filter_applied = 'Enrolment Status' AND cre.rn = 1
  `);
  console.log("SQL DONE", rows.length);
}
testSQL().catch(e => console.error("TEST ERROR:", e.message)).finally(() => process.exit(0));

