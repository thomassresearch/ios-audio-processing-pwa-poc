import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import wabtFactory from 'wabt';
const wabt = await wabtFactory();
const wat = await fs.readFile('dsp/reverb.wat', 'utf8');
const module = wabt.parseWat('reverb.wat', wat);
module.validate();
const { buffer } = module.toBinary({ write_debug_names: true });
module.destroy();
await fs.rm('dist', { recursive: true, force: true });
await fs.mkdir('dist', { recursive: true });
await fs.cp('public', 'dist', { recursive: true });
await fs.cp('src', 'dist/src', { recursive: true });
await fs.writeFile('dist/reverb.wasm', buffer);
let revision = 'dev';
try { revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
const version = `${JSON.parse(await fs.readFile('package.json', 'utf8')).version}-${revision}`;
const assets = ['version.json', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'reverb.wasm',
  ...((await fs.readdir('src')).map(f => `src/${f}`))];
let sw = await fs.readFile('public/sw.js', 'utf8');
sw = sw.replace('__VERSION__', version).replace('__ASSETS__', JSON.stringify(assets));
await fs.writeFile('dist/sw.js', sw);
await fs.writeFile('dist/version.json', JSON.stringify({ version }));
console.log(`Built ${version}; WASM ${buffer.length} bytes`);
