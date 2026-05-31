/**
 * Test script: uploads a small test image to Bitrix24 storage
 * and verifies the DOWNLOAD_URL is returned.
 * 
 * Usage: node scripts/test-image-upload.js <bitrix_url> <auth_token>
 * Example: node scripts/test-image-upload.js https://manda4.bitrix24.com.br abc123token
 */

// Small 1x1 red pixel PNG in base64
const TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

const bitrixUrl = process.argv[2];
const authToken = process.argv[3];

if (!bitrixUrl || !authToken) {
  console.log('Usage: node scripts/test-image-upload.js <bitrix_url> <auth_token>');
  console.log('Example: node scripts/test-image-upload.js https://manda4.bitrix24.com.br abc123token');
  process.exit(1);
}

async function callBitrix(method, params = {}) {
  const url = `${bitrixUrl.replace(/\/$/, '')}/rest/${method}?auth=${authToken}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`${data.error}: ${data.error_description || ''}`);
  }
  return data.result;
}

async function main() {
  console.log('=== Test: Upload image to Bitrix24 ===');
  console.log(`URL: ${bitrixUrl}`);
  console.log(`Auth: ${authToken.substring(0, 10)}...\n`);

  // Test 1: List available storages
  console.log('--- Test 1: List storages ---');
  try {
    const storages = await callBitrix('disk.storage.getlist', {});
    console.log(`Found ${storages.length} storage(s):`);
    storages.forEach(s => {
      console.log(`  ID=${s.ID} name="${s.NAME}" type=${s.ENTITY_TYPE}`);
    });
  } catch (err) {
    console.error(`Failed: ${err.message}`);
  }

  // Test 2: Get app storage
  console.log('\n--- Test 2: Get app storage ---');
  let appStorageId = null;
  try {
    const appStorage = await callBitrix('disk.storage.getforapp', {});
    console.log('App storage:', JSON.stringify(appStorage, null, 2));
    appStorageId = appStorage?.ID;
  } catch (err) {
    console.error(`Failed: ${err.message}`);
  }

  // Test 3: Upload to app storage (if available)
  if (appStorageId) {
    console.log(`\n--- Test 3: Upload to app storage (ID=${appStorageId}) ---`);
    try {
      const result = await callBitrix('disk.storage.uploadfile', {
        id: appStorageId,
        data: { NAME: 'test_pixel.png' },
        fileContent: ['test_pixel.png', TEST_IMAGE_BASE64],
        generateUniqueName: true,
      });
      console.log('Result:', JSON.stringify(result, null, 2));
      if (result?.DOWNLOAD_URL) {
        console.log(`\n✅ DOWNLOAD_URL: ${result.DOWNLOAD_URL}`);
      }
    } catch (err) {
      console.error(`Failed: ${err.message}`);
    }
  }

  // Test 4: Upload to storage ID 1
  console.log('\n--- Test 4: Upload to storage ID 1 ---');
  try {
    const result = await callBitrix('disk.storage.uploadfile', {
      id: 1,
      data: { NAME: 'test_pixel_s1.png' },
      fileContent: ['test_pixel_s1.png', TEST_IMAGE_BASE64],
      generateUniqueName: true,
    });
    console.log('Result:', JSON.stringify(result, null, 2));
    if (result?.DOWNLOAD_URL) {
      console.log(`\n✅ DOWNLOAD_URL: ${result.DOWNLOAD_URL}`);
    }
  } catch (err) {
    console.error(`Failed: ${err.message}`);
  }

  // Test 5: Upload to storage ID 3
  console.log('\n--- Test 5: Upload to storage ID 3 ---');
  try {
    const result = await callBitrix('disk.storage.uploadfile', {
      id: 3,
      data: { NAME: 'test_pixel_s3.png' },
      fileContent: ['test_pixel_s3.png', TEST_IMAGE_BASE64],
      generateUniqueName: true,
    });
    console.log('Result:', JSON.stringify(result, null, 2));
    if (result?.DOWNLOAD_URL) {
      console.log(`\n✅ DOWNLOAD_URL: ${result.DOWNLOAD_URL}`);
    }
  } catch (err) {
    console.error(`Failed: ${err.message}`);
  }

  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
