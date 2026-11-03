import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Equivalent of `grep -ri "xbyte\|talabat" src/core`: core must not know this provider exists. */
describe('provider boundary', () => {
  it('src/core mentions neither xbyte nor talabat', () => {
    const root = resolve(__dirname, '../../core');
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    })(root);

    const hits = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${relative(root, file)}:${i + 1}` }))
        .filter(({ line }) => /xbyte|talabat/i.test(line))
        .map(({ at }) => at),
    );
    expect(files.length).toBeGreaterThan(10);
    expect(hits).toEqual([]);
  });
});
