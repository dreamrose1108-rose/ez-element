import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
if (process.argv.includes('--production')) {
  const config = await readFile('miniprogram/config.ts', 'utf8');
  const project = JSON.parse(await readFile('project.config.json', 'utf8'));
  if (!/mode:\s*'cloud'/.test(config) || !/envId:\s*'[^']+'/.test(config) || !/loginUrl:\s*'https:\/\/[^'\s]+'/.test(config) || !/^wx[0-9a-f]{16}$/.test(project.appid) || project.setting.urlCheck !== true) throw new Error('正式构建要求真实 AppID、cloud 模式、环境 ID、HTTPS 登录地址和开启域名校验');
}
for (const path of ['app', 'pages/workspace/index']) await build({ entryPoints: [`miniprogram/${path}.ts`], outfile: `miniprogram/${path}.js`, platform: 'neutral', mainFields: ['main', 'module'], target: 'es2020', format: 'cjs', bundle: true, minify: true });
const root = JSON.parse(await readFile('package.json', 'utf8'));
for (const [name, entry, dependencies] of [
  ['api', 'server/entry.ts', root.dependencies],
  ['getLoginTicket', 'server/login-entry.ts', root.dependencies],
]) {
  await mkdir(`cloudfunctions/${name}`, { recursive: true });
  await build({ entryPoints: [entry], outfile: `cloudfunctions/${name}/index.js`, platform: 'node', target: 'node18', format: 'cjs', bundle: true, packages: 'external' });
  await writeFile(`cloudfunctions/${name}/package.json`, JSON.stringify({ name: `ez-element-${name.toLowerCase()}`, version: '0.1.0', main: 'index.js', dependencies }, null, 2) + '\n');
}
console.log('Built api + getLoginTicket cloud functions (not deployed)');
