const axios = require('axios');
require('dotenv').config();

async function triggerCheck() {
  const backendUrl = process.env.LMS_BACKEND_URL || 'http://127.0.0.1:9001';
  console.log(`📡 Sending test request to LMS Backend at: ${backendUrl}`);
  
  try {
    const start = Date.now();
    const res = await axios.get(`${backendUrl}/clients/reporting-metadata`, { timeout: 10000 });
    const end = Date.now();
    
    console.log(`✅ SUCCESS! Response received in ${end - start}ms`);
    console.log(`📊 Number of clients found in LMS: ${res.data.data.length}`);
    
    // Check first client details
    if (res.data.data.length > 0) {
        console.log('Sample Data Key/Value pairs:');
        Object.entries(res.data.data[0]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
    }
  } catch (err) {
    console.error('❌ FAILED to connect to LMS Backend.');
    console.error(`Error Code: ${err.code}`);
    console.error(`Message: ${err.message}`);
    if (err.response) {
        console.error('Backend replied with status:', err.response.status);
    }
  }
}

triggerCheck();
