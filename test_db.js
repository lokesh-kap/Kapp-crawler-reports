const { DataSource } = require('typeorm');
const myDataSource = new DataSource({
    type: "postgres",
    host: process.env.LMS_DB_HOST || "localhost",
    port: process.env.LMS_DB_PORT || 5432,
    username: process.env.LMS_DB_USER || "postgres",
    password: process.env.LMS_DB_PASS || "postgres",
    database: process.env.LMS_DB_NAME || "postgres",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    await myDataSource.initialize();
    const rows = await myDataSource.query(`
        SELECT client_id, created_at, filter_applied, primary_leads, verified_leads, form_initiated
        FROM npf_funnel_summary
        WHERE funnel_source = 'lead_view'
        ORDER BY created_at DESC
        LIMIT 10
    `);
    console.log(rows);
    await myDataSource.destroy();
}
run().catch(console.error);
