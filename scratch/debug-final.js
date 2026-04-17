const { Client } = require('pg');

async function checkClients() {
  const client = new Client({
    host: '65.0.8.138',
    port: 5432,
    user: 'postgres',
    password: 'kapp@2025',
    database: 'lms_test_db',
    ssl: false,
  });

  try {
    await client.connect();
    console.log('--- LMS CLIENT DATA SNAPSHOT ---');
    const res = await client.query('SELECT client_id, client_name, is_active, year FROM client WHERE client_id IN (7051189, 7050982, 7042725)');
    console.table(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}

checkClients();
