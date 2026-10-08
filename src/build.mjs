// Builds fwa-odds-panel.zh.user.js and fwa-odds-panel.en.user.js from panel.js + strings.<lang>.js.
// Usage: node src/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const panel = readFileSync(join(here, 'panel.js'), 'utf8');

const META = {
  zh: {
    name: 'FWA V2 抽奖赔率实时面板',
    description: '在 fwa.fun V2 页面内实时计算：真实花费、两种结算的期望回报、七档结果分布与不亏概率、连抽模拟。全池从链上合约逐条读取，并与合约合计逐位对账。'
  },
  en: {
    name: 'FWA V2 Odds Panel',
    description: 'Live odds inside fwa.fun V2: true cost per pull, expected return on both settlement routes, seven-tier outcome distribution with chance of not losing, and multi-pull simulation. The full pool is read from the contract and reconciled exactly against its totals.'
  }
};

for (const lang of ['zh', 'en']) {
  const strings = readFileSync(join(here, `strings.${lang}.js`), 'utf8').trim();
  const header = [
    '// ==UserScript==',
    `// @name         ${META[lang].name}`,
    '// @namespace    fwa.monitor',
    '// @version      5.0',
    `// @description  ${META[lang].description}`,
    '// @match        https://www.fwa.fun/*',
    '// @match        https://fwa.fun/*',
    '// @run-at       document-idle',
    '// @grant        none',
    '// ==/UserScript=='
  ].join('\n');
  const out = panel.replace('/*@HEADER@*/', header).replace('/*@STRINGS@*/null', strings);
  if (out.includes('/*@')) throw new Error('unreplaced placeholder in ' + lang);
  writeFileSync(join(root, `fwa-odds-panel.${lang}.user.js`), out);
  console.log('wrote', `fwa-odds-panel.${lang}.user.js`, out.length, 'bytes');
}
