const fs = require('fs');
const path = require('path');

const root = __dirname;
const out = path.join(root, 'www');
const skipDirs = new Set(['node_modules', 'www', '.git', '.github', '.vscode']);
const skipFiles = new Set(['build.js', 'package.json', 'package-lock.json', 'capacitor.config.json', 'capacitor.config.ts']);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);

for (const e of fs.readdirSync(root, { withFileTypes: true })) {
  const n = e.name;
  if (n.startsWith('.') || skipDirs.has(n) || skipFiles.has(n)) continue;
  const from = path.join(root, n);
  const to = path.join(out, n);
  if (e.isDirectory()) fs.cpSync(from, to, { recursive: true });
  else fs.copyFileSync(from, to);
}

console.log('www/ staged');