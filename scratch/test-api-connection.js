const axios = require('axios');

async function testApi() {
  const url = 'http://localhost:9001/clients/reporting-metadata';
  console.log(`📡 Testing LMS API at: ${url}`);
  try {
    const response = await axios.get(url, { timeout: 5000 });
    console.log('✅ SUCCESS! Connection established.');
    console.log(`📊 Received ${response.data.data.length} clients.`);
    console.log('First 2 clients:', response.data.data.slice(0, 2));
  } catch (error) {
    console.error('❌ FAILED to connect to LMS API.');
    if (error.code === 'ECONNREFUSED') {
      console.error('The LMS backend is NOT running on port 9001.');
    } else {
      console.error(error.message);
    }
  }
}

testApi();
