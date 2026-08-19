const path = require('path');
const fs = require('fs');
const upstream = path.resolve(__dirname, '..', 'upstream', 'arduino-ide-2.3.9', 'arduino-ide-extension', 'lib', 'node');
const implPath = path.join(upstream, 'github-service-impl.js');
let GitHubServiceImpl;
try {
  GitHubServiceImpl = require(implPath).GitHubServiceImpl;
} catch (e) {
  console.error('ERR_REQUIRE_IMPL', e && e.message);
  process.exit(2);
}
(async () => {
  try {
    const svc = new GitHubServiceImpl();
    const sampleDir = path.resolve(__dirname, '..', 'upstream', 'arduino-ide-2.3.9', 'tmp');
    if (!fs.existsSync(sampleDir)) fs.mkdirSync(sampleDir, { recursive: true });
    const sampleBin = path.join(sampleDir, 'secureota-sample.bin');
    // create small binary content
    fs.writeFileSync(sampleBin, Buffer.from('SECUREOTATEST'));
    console.log('Uploading sample:', sampleBin);
    const uniqueName = 'secureota-e2e-' + Date.now();
    const record = await svc.triggerRelease({ sketchName: uniqueName, binPath: sampleBin });
    console.log('RECORD', JSON.stringify(record, null, 2));
  } catch (e) {
    console.error('ERR_RUN', e && e.message);
    console.error(e && e.stack);
    process.exit(3);
  }
})();
