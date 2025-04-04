const crypto = require('crypto');

function generateApiKey() {
  // Generate a random 32-byte buffer
  const buffer = crypto.randomBytes(32);
  // Convert to base64 and remove any special characters
  const apiKey = buffer.toString('base64')
    .replace(/[+/]/g, '')
    .substring(0, 32);
  
  console.log('Generated API Key:', apiKey);
  console.log('\nAdd this to your .env file:');
  console.log(`API_KEY=${apiKey}`);
  console.log('\nOr to your Kubernetes secret:');
  console.log(`kubectl create secret generic kafka-replicator-secrets --from-literal=api-key=${apiKey}`);
}

generateApiKey(); 