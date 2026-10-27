import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
if (process.argv.includes('--production')) {
  const config = await readFile('miniprogram/config.ts', 'utf8');
  const project = JSON.parse(await readFile('project.config.json', 'utf8'));
  if (!/mode:\s*'cloud'/.test(config) || !/envId:\s*'[^']+'/.test(config) || !/^wx[0-9a-f]{16}$/.test(project.appid) || project.setting.urlCheck !== true) throw new Error('正式构建要求真实 AppID、cloud 模式、环境 ID 和开启域名校验');
}
for (const path of ['app', 'pages/workspace/index']) await build({ entryPoints: [`miniprogram/${path}.ts`], outfile: `miniprogram/${path}.js`, platform: 'neutral', target: 'es2020', format: 'cjs', bundle: true });
await mkdir('cloudfunctions/api', { recursive: true });
await build({ entryPoints: ['server/entry.ts'], outfile: 'cloudfunctions/api/index.js', platform: 'node', target: 'node18', format: 'cjs', bundle: true, packages: 'external' });
const root = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile('cloudfunctions/api/package.json', JSON.stringify({ name: 'ez-element-api', version: '0.1.0', main: 'index.js', dependencies: root.dependencies }, null, 2) + '\n');
console.log('Cloud function built: cloudfunctions/api (not deployed)');
