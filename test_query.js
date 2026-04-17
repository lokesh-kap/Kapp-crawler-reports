const { DataSource } = require('typeorm');
const myDataSource = new DataSource({
    type: "postgres",
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT || 5432,
    username: process.env.DB_USER || "postgres",
    password: process.env.DB_PASS || "postgres",
    database: process.env.DB_NAME || "postgres",
    ssl: false
});

async function run() {
    await myDataSource.initialize();
    const rows = await myDataSource.query(`
WITH ranked_none AS (
  SELECT client_id, primary_leads, verified_leads,
         ROW_NUMBER() OVER(PARTITION BY client_id ORDER BY created_at DESC) as rn
  FROM npf_funnel_summary
  WHERE funnel_source = 'lead_view' AND filter_applied = 'None'
),
ranked_paid AS (
  SELECT client_id, primary_leads,
         ROW_NUMBER() OVER(PARTITION BY client_id ORDER BY created_at DESC) as rn
  FROM npf_funnel_summary
  WHERE funnel_source = 'lead_view' AND filter_applied = 'Paid Apps'
),
ranked_form_init AS (
  SELECT client_id, primary_leads,
         ROW_NUMBER() OVER(PARTITION BY client_id ORDER BY created_at DESC) as rn
  FROM npf_funnel_summary
  WHERE funnel_source = 'lead_view' AND filter_applied = 'Form Initiated'
)
SELECT 
  c.client_id,
  COALESCE(NULLIF(REPLACE(rp1.primary_leads, ',', ''), '')::numeric, 0) AS total_paid_apps,
  (COALESCE(NULLIF(REPLACE(rp1.primary_leads, ',', ''), '')::numeric, 0) - COALESCE(NULLIF(REPLACE(rp2.primary_leads, ',', ''), '')::numeric, 0)) AS yesterday_application,
  
  (COALESCE(NULLIF(REPLACE(rn1.primary_leads, ',', ''), '')::numeric, 0) - COALESCE(NULLIF(REPLACE(rn2.primary_leads, ',', ''), '')::numeric, 0)) AS yesterday_primary_leads,
  COALESCE(NULLIF(REPLACE(rn1.primary_leads, ',', ''), '')::numeric, 0) AS total_primary_leads,
  COALESCE(NULLIF(REPLACE(rn1.verified_leads, ',', ''), '')::numeric, 0) AS prim_verified_leads,
  
  COALESCE(NULLIF(REPLACE(rfi1.primary_leads, ',', ''), '')::numeric, 0) AS primary_form_initiated
FROM (SELECT DISTINCT client_id FROM npf_funnel_summary WHERE funnel_source = 'lead_view') c
LEFT JOIN ranked_none rn1 ON rn1.client_id = c.client_id AND rn1.rn = 1
LEFT JOIN ranked_none rn2 ON rn2.client_id = c.client_id AND rn2.rn = 2
LEFT JOIN ranked_paid rp1 ON rp1.client_id = c.client_id AND rp1.rn = 1
LEFT JOIN ranked_paid rp2 ON rp2.client_id = c.client_id AND rp2.rn = 2
LEFT JOIN ranked_form_init rfi1 ON rfi1.client_id = c.client_id AND rfi1.rn = 1
    `);
    console.log(rows);
    await myDataSource.destroy();
}
run().catch(console.error);
