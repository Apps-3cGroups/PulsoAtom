import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { theme } from 'antd';
import { appearanceTheme, isFontScale, normalizeFontScale } from '../src/services/appearance.js';

test('font scale accepts tenths from the unchanged baseline to double', () => {
  for (const value of [1, 1.1, 1.5, 1.9, 2]) assert.equal(isFontScale(value), true);
  for (const value of [undefined, null, '2', 0, 0.9, 2.1, 1.15, NaN, Infinity]) {
    assert.equal(isFontScale(value), false);
    assert.equal(normalizeFontScale(value), 1);
  }
});

test('Ant Design derives the original baseline and doubles every heading and text size exactly', () => {
  const baseline = theme.getDesignToken(appearanceTheme(1));
  const original = theme.getDesignToken({ algorithm: theme.defaultAlgorithm, token: { fontSize: 13, controlHeight: 36 } });
  const keys = Object.keys(baseline).filter(key => /^font(?:Size|Height)/.test(key));
  assert.ok(keys.includes('fontSizeHeading1') && keys.includes('fontSizeSM'));
  for (const key of keys) assert.equal(baseline[key], original[key], `baseline ${key}`);
  for (const scale of [1.5, 2]) {
    const enlarged = theme.getDesignToken(appearanceTheme(scale));
    for (const key of keys) assert.equal(enlarged[key], baseline[key] * scale, `${key} at ${scale}`);
    for (const key of ['controlHeight', 'controlHeightSM', 'controlHeightLG', 'controlHeightXS']) {
      assert.equal(enlarged[key], baseline[key] * scale, `${key} at ${scale}`);
    }
  }
});

test('all authored absolute typography participates in the global scale, including shorthand and responsive text', async () => {
  let declarations = 0;
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await inspect(path);
      else if (entry.name.endsWith('.css')) {
        const css = await readFile(path, 'utf8');
        for (const [, property, value] of css.matchAll(/\b(font-size|font|line-height)\s*:\s*([^;{}]+)/g)) {
          if (!/[\d.]+(?:px|vw|vh|cqw|cqh)/.test(value)) continue;
          declarations++;
          assert.match(value, /var\(--font-scale(?:,\s*1)?\)/, `${path}: ${property}: ${value}`);
        }
      }
    }
  }
  await inspect(fileURLToPath(new URL('../src', import.meta.url)));
  assert.ok(declarations > 300, 'Covers portal typography, not only the new settings card');
});
