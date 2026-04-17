const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Manually parse .env
const envPath = path.join(__dirname, '..', '.env');
const envConfig = fs.readFileSync(envPath, 'utf8').split('\n').reduce((acc, line) => {
  const [key, value] = line.split('=');
  if (key && value) acc[key.trim()] = value.trim();
  return acc;
}, {});

async function checkClients() {
  console.log('DB Config:', {
    host: envConfig.LMS_DB_HOST,
    user: envConfig.LMS_DB_USER,
    database: envConfig.LMS_DB_NAME,
  });
  const client = new Client({
    host: envConfig.LMS_DB_HOST,
    port: Number(envConfig.LMS_DB_PORT),
    user: envConfig.LMS_DB_USER,
    password: envConfig.LMS_DB_PASS,
    database: envConfig.LMS_DB_NAME,
    ssl: false,
  });

  try {
    await client.connect();
    console.log('--- LMS CLIENT STATUS CHECK ---');
    const res = await client.query('SELECT client_id, client_name, is_active, year FROM client LIMIT 20');
    console.table(res.rows);
    
    const activeCount = res.rows.filter(r => r.is_active).length;
    console.log(`Summary: Found ${res.rows.length} total, ${activeCount} are active.`);
    
    const configRes = await client.query('SELECT count(*) FROM client_connections');
    console.log(`Total Connections in DB: ${configRes.rows[0].count}`);
    
  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}

checkClients();
