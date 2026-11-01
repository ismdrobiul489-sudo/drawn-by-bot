// Style discovery: names come LIVE from core/styles/ folders (never
// hardcoded); our own metadata adds status + GPU warnings for the buttons.
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/env.mjs';

const META = {
  'paper-cutout': { status: 'approved', gpu: false },
  '70s-poster': { status: 'approved', gpu: false },
  'liquid-light': { status: 'approved', gpu: false },
  'kaleidoscope': { status: 'approved', gpu: false },
  'line': { status: 'approved', gpu: false },
  'risograph': { status: 'approved', gpu: false },
  'clay': { status: 'testing', gpu: false },
  'pixel-art': { status: 'testing', gpu: false },
  'engraving': { status: 'testing', gpu: true },
  'clay3d': { status: 'testing', gpu: true },
  'felt3d': { status: 'testing', gpu: true },
};

export function listStyles() {
  const dir = join(ROOT, 'core', 'styles');
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  const rank = s => (META[s]?.status === 'approved' ? 0 : 1);
  return names
    .map(name => ({ name, ...(META[name] || { status: 'testing', gpu: false }) }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

export function styleLabel(s) {
  return `${s.name}${s.status === 'approved' ? ' ✅' : ' 🧪'}${s.gpu ? ' ⚠️GPU' : ''}`;
}
