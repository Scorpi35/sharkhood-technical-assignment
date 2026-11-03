/**
 * The docs must match the code, in both directions (T13). If this fails, either
 * the code changed and the docs did not, or the docs promise something the code
 * does not do. Fix whichever is wrong.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { envSchema } from './config/env.schema';
import { BATCH_STATUSES, COUNTER_NAMES, QUARANTINE_REASONS, RUN_STATUSES } from './core';
import { AREA_INDEXES, AREAS } from './domain/area/area.indexes';
import { MENU_ITEM_INDEXES, MENU_ITEMS } from './domain/menu-item/menu-item.indexes';
import { MENU_INDEXES, MENUS } from './domain/menu/menu.indexes';
import { RESTAURANT_AREA_INDEXES, RESTAURANT_AREAS } from './domain/restaurant-area/restaurant-area.indexes';
import { RESTAURANT_INDEXES, RESTAURANTS } from './domain/restaurant/restaurant.indexes';
import { RUN_METADATA_INDEXES } from './domain/run-metadata/run-metadata.indexes';

const ROOT = resolve(__dirname, '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const DATA_ANALYSIS = read('docs/DATA_ANALYSIS.md');
const ARCHITECTURE = read('ARCHITECTURE.md');
const README = read('README.md');
const DOCS = { 'docs/DATA_ANALYSIS.md': DATA_ANALYSIS, 'ARCHITECTURE.md': ARCHITECTURE, 'README.md': README };

/** Rows of the markdown table whose header row starts with `| <header> |` (header and separator excluded). */
function tableAt(doc: string, header: string): string[][] {
  const lines = doc.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`| ${header} |`));
  if (at < 0) throw new Error(`table not found: | ${header} |`);
  const rows: string[][] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|').slice(1, -1).map((c) => c.trim()));
  }
  return rows;
}
const firstColumn = (doc: string, header: string) => tableAt(doc, header).map((r) => r[0].replace(/`/g, ''));

describe('docs match the code', () => {
  it('every index in DATA_ANALYSIS §5 exists in code, and every index in code is documented', () => {
    const code: Record<string, readonly { key: unknown; unique?: boolean }[]> = {
      [AREAS]: AREA_INDEXES,
      [RESTAURANTS]: RESTAURANT_INDEXES,
      [RESTAURANT_AREAS]: RESTAURANT_AREA_INDEXES,
      [MENUS]: MENU_INDEXES,
      [MENU_ITEMS]: MENU_ITEM_INDEXES,
      ...RUN_METADATA_INDEXES,
    };
    const fromCode = Object.entries(code)
      .flatMap(([c, list]) => list.map((i) => `${c} ${JSON.stringify(i.key)}${i.unique ? ' unique' : ''}`))
      .sort();
    const fromDocs = tableAt(DATA_ANALYSIS, 'Collection | Index')
      .filter(([, index]) => index.startsWith('`{')) // the "no separate index" row documents an absence
      .map(([collection, index]) => {
        const spec = /`(\{[^`]+\})`/.exec(index)![1];
        const key = JSON.parse(spec.replace(/(\w+)\s*:/g, '"$1":'));
        return `${collection.replace(/`/g, '')} ${JSON.stringify(key)}${/\*\*unique\*\*/.test(index) ? ' unique' : ''}`;
      })
      .sort();
    expect(fromDocs).toEqual(fromCode);
  });

  it('the quarantine reasons table lists exactly the reasons in code, and no doc invents one', () => {
    expect(firstColumn(ARCHITECTURE, 'Reason').sort()).toEqual([...QUARANTINE_REASONS].sort());
    for (const [file, doc] of Object.entries(DOCS)) {
      const mentioned = [...new Set(doc.match(/\b[A-Z]+(?:_[A-Z]+)*_(?:ERROR|INVALID|PAYLOAD|CONFLICT)\b/g) ?? [])];
      expect({ file, unknown: mentioned.filter((r) => !(QUARANTINE_REASONS as readonly string[]).includes(r)) }).toEqual({ file, unknown: [] });
    }
  });

  it('the counter table lists exactly the run counters in code', () => {
    expect(firstColumn(ARCHITECTURE, 'Counter').sort()).toEqual([...COUNTER_NAMES].sort());
  });

  it('the run and batch status tables (and the state diagram) match the code', () => {
    expect(firstColumn(ARCHITECTURE, 'Run status').sort()).toEqual([...RUN_STATUSES].sort());
    expect(firstColumn(ARCHITECTURE, 'Batch status').sort()).toEqual([...BATCH_STATUSES].sort());
    const diagram = /```mermaid\nstateDiagram-v2\n([\s\S]*?)```/.exec(ARCHITECTURE)![1];
    const states = new Set([...diagram.matchAll(/([a-z_]+)\s*-->\s*([a-z_]+)/g)].flatMap((m) => [m[1], m[2]]));
    expect([...states].sort()).toEqual([...RUN_STATUSES].sort());
  });

  it('every UPPER_SNAKE name in the docs is a real env var or exported constant, and every env var is in .env.example', () => {
    const envVars = Object.keys(envSchema.shape);
    const exported = new Set<string>();
    (function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) for (const m of readFileSync(p, 'utf8').matchAll(/export const ([A-Z][A-Z0-9_]+)/g)) exported.add(m[1]);
      }
    })(join(ROOT, 'src'));
    const known = new Set([...envVars, ...exported, ...QUARANTINE_REASONS, 'DATA_ANALYSIS']);
    for (const [file, doc] of Object.entries(DOCS)) {
      const names = [...new Set(doc.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])];
      expect({ file, unknown: names.filter((n) => !known.has(n)) }).toEqual({ file, unknown: [] });
    }
    const example = read('.env.example');
    expect(envVars.filter((v) => !new RegExp(`^${v}=`, 'm').test(example))).toEqual([]);
  });
});
