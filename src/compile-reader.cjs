// Recompiles PoolReader.sol into PoolReader.hex (init code embedded by build.mjs).
// Usage: npm i solc@0.8.26 && node src/compile-reader.cjs
const solc = require('solc'), fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'PoolReader.sol'), 'utf8');
const input = { language: 'Solidity', sources: { 'PoolReader.sol': { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['evm.bytecode.object'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors || []) { console.error(e.formattedMessage); if (e.severity === 'error') process.exit(1); }
const hex = out.contracts['PoolReader.sol'].PoolReader.evm.bytecode.object;
fs.writeFileSync(path.join(__dirname, 'PoolReader.hex'), hex);
console.log('solc', solc.version(), '→ PoolReader.hex', hex.length / 2, 'bytes');
