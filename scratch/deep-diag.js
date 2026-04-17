const axios = require('axios');
const { Client } = require('pg');
require('dotenv').config();

async function deepDiag() {
  const backendUrl = process.env.LMS_BACKEND_URL || 'http://127.0.0.1:9001';
  console.log(`--- DEEP DIAGNOSTIC ---`);
  console.log(`📡 Hitting API: ${backendUrl}/clients/reporting-metadata`);
  
  try {
    const apiResp = await axios.get(`${backendUrl}/clients/reporting-metadata`);
    const allClients = apiResp.data?.data || [];
    console.log(`✅ API returned ${allClients.length} clients.`);
    
    if (allClients.length > 0) {
        console.log('Sample Data from API (ID, Name, is_active):');
        allClients.slice(0, 5).forEach(c => console.log(` - ${c.client_id} | ${c.client_name} | ${c.is_active}`));
    }

    // Check Local Config
    const dbClient = new Client({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      ssl: { rejectUnauthorized: false }
    });
    
    await dbClient.connect();
    const configRes = await dbClient.query('SELECT client_id FROM client_wise_summary_config');
    const configuredIds = configRes.rows.map(r => Number(r.client_id));
    console.log(`📋 Local Config has ${configuredIds.length} client IDs: ${configuredIds.join(', ')}`);
    
    const matches = allClients.filter(c => configuredIds.includes(Number(c.client_id)));
    console.log(`🔍 Matches found: ${matches.length}`);
    
    if (matches.length > 0) {
        console.log('Match Example:', matches[0]);
    } else {
        console.log('❌ NO MATCHES. The IDs in your config do not exist in the LMS or are not listed by the API.');
    }
    
    await dbClient.end();
  } catch (error) {
    console.error(`❌ ERROR: ${error.message}`);
    if (error.response) console.error('Response:', error.response.data);
  }
}

deepDiag();
