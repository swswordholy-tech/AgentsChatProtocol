const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
(async () => {
  const mod = await jiti.import('./src/plugin.ts');
  console.log(mod && mod.agentChatPlugin ? 'ok' : 'missing');
})().catch((e) => { console.error(e); process.exit(1); });
