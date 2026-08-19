const path = require('path');
const kcPath = path.resolve(__dirname, '..', 'upstream', 'arduino-ide-2.3.9', 'arduino-ide-extension', 'lib', 'node', 'auth', 'keychain.js');
let Keychain;
try {
  Keychain = require(kcPath).Keychain;
} catch (e) {
  console.error('ERR_REQUIRE', e && e.message);
  process.exit(2);
}
let input = '';
process.stdin.on('data', d => input += d.toString());
process.stdin.on('end', async () => {
  const token = input.trim();
  if (!token) {
    console.error('ERR_NO_TOKEN');
    process.exit(3);
  }
  try {
    const kc = new Keychain({ credentialsSection: 'secureota.github', account: 'token' });
    const ok = await kc.storeCredentials(token);
    console.log('STORE_OK:' + (ok ? 'true' : 'false'));
    process.exit(ok ? 0 : 4);
  } catch (e) {
    console.error('ERR_STORE', e && e.message);
    process.exit(5);
  }
});
