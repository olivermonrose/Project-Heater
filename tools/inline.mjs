// Builds dist/ProjectHeater.html: one self-contained file that opens by double-click (no server needed).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const html = readFileSync('dist/index.html', 'utf8');
const js = readdirSync('dist/assets').find((f) => f.endsWith('.js'));
const code = readFileSync(`dist/assets/${js}`, 'utf8').replace(/<\/script/g, '<\\/script');
const out = html.replace(/<script type="module" crossorigin src="[^"]+"><\/script>/, () => `<script type="module">${code}</script>`);
if (out === html) throw new Error('script tag not found');
writeFileSync('dist/ProjectHeater.html', out);
console.log('wrote dist/ProjectHeater.html', (out.length / 1024).toFixed(0), 'KB');
