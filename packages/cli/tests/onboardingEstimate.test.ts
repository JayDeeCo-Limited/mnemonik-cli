import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeScanner } from '@mnemonik/shared';
import { describe, expect, it } from 'vitest';
import {
  countIndexableFiles,
  formatDurationRange,
  onboardingEstimateLines,
} from '../src/scanner/estimate.js';

describe('onboarding estimate: what indexing will do, shown before the first scan', () => {
  it('counts the files the scanner itself would index, and their size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mnk-estimate-'));
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n'.repeat(50));
    await writeFile(join(root, 'src', 'b.ts'), 'export const b = 2;\n'.repeat(50));
    await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    const count = await countIndexableFiles([root]);
    expect(count).toEqual({ files: 2, bytes: 2000, partial: false });
  });

  it('selects exactly the files the scanner itself lists, whatever rule applies', async () => {
    // One implementation (CodeScanner extends FileSelector, which the estimate
    // loads alone so the CLI bundles no compiler): pinned on a tree that
    // exercises each kind of rule.
    const root = await mkdtemp(join(tmpdir(), 'mnk-estimate-rules-'));
    const files: Record<string, string> = {
      'src/a.ts': 'export const a = 1;\n',
      'src/App.vue': '<template><p>a</p></template>\n',
      'src/skip.log': 'not source\n',
      'ignored/x.ts': 'export const x = 1;\n',
      'kept/y.ts': 'export const y = 1;\n',
      'kept/drop.ts': 'export const d = 1;\n',
      'vendor/lib.js': 'module.exports = 1;\n',
      'vendor/keep.js': 'module.exports = 2;\n',
      'gen/out.ts': 'export const g = 1;\n',
      'node_modules/dep/index.js': 'module.exports = 1;\n',
      '.env': 'TOKEN=placeholder\n',
      'docs/guide.md': '# Guide\n\nText.\n',
      'nested/.git/HEAD': 'ref: refs/heads/main\n',
      'nested/inner.ts': 'export const n = 1;\n',
      '.gitignore': 'ignored/\nkept/drop.ts\n!vendor/keep.js\n',
      '.gitattributes': 'gen/** linguist-generated\n',
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const scanner = await new CodeScanner().listFilesWithStatus(root);
    expect(scanner.complete).toBe(true);
    const listed: string[] = [];
    const count = await countIndexableFiles([root], {
      list: async (dir) => {
        const { FileSelector } = await import('@mnemonik/shared/file-selection');
        const result = await new FileSelector().listFilesWithStatus(dir);
        listed.push(...result.paths);
        return result;
      },
    });
    expect([...listed].sort()).toEqual([...scanner.paths].sort());
    // And the estimate's own default path counts the same files and bytes.
    const bytes = [...scanner.stats.values()].reduce((sum, stat) => sum + stat.size, 0);
    expect(await countIndexableFiles([root])).toEqual({
      files: scanner.paths.length,
      bytes,
      partial: false,
    });
    expect(count.files).toBe(scanner.paths.length);
    // The tree exercised the rules: some files were left out, some kept.
    expect(scanner.paths.length).toBeGreaterThan(1);
    expect(scanner.paths.length).toBeLessThan(Object.keys(files).length - 3);
  });

  it('says "at least" when the count runs past its time bound', async () => {
    let clock = 0;
    const count = await countIndexableFiles(['/a', '/b'], {
      list: async () => {
        clock += 40_000;
        return { paths: [] };
      },
      now: () => clock,
    });
    expect(count.partial).toBe(true);
    expect(onboardingEstimateLines({ files: 12000, bytes: 3e8, partial: true }, null)).toEqual([
      'Mnemonik will index at least 12,000 files (286 MB).',
    ]);
  });

  it('turns the server range into words', () => {
    expect(formatDurationRange(20, 45)).toBe('under a minute');
    expect(formatDurationRange(240, 300)).toBe('about 4 to 5 minutes');
    expect(formatDurationRange(600, 600)).toBe('about 10 minutes');
    expect(formatDurationRange(3000, 9000)).toBe('about 50 minutes to 3 hours');
    expect(formatDurationRange(7200, 14400)).toBe('about 2 to 4 hours');
    expect(formatDurationRange(3 * 86400, 5 * 86400)).toBe('about 3 to 5 days');
  });

  it('shows the count and the time, and says when the time reflects other accounts', () => {
    const count = { files: 3412, bytes: 48 * 1024 * 1024, partial: false };
    expect(
      onboardingEstimateLines(count, {
        files: 3412,
        lowSeconds: 600,
        highSeconds: 1200,
        basis: 'measured',
        accountsAhead: 4,
      })
    ).toEqual([
      'Mnemonik will index 3,412 files (48 MB).',
      'Indexing will take about 10 to 20 minutes at the current load. You can keep working while it runs; files become searchable as they are indexed.',
    ]);
    expect(onboardingEstimateLines({ files: 0, bytes: 0, partial: false }, null)).toEqual([]);
  });
});
