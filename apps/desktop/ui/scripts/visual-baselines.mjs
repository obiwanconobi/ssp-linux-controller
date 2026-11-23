import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';

const root = resolve(process.cwd());
const dist = resolve(root, 'dist/index.html');
const baselineDir = resolve(root, 'visual-baselines');
const update = process.argv.includes('--update');

if (!existsSync(dist)) {
  console.error('dist/index.html is missing — run `pnpm build` first.');
  process.exit(1);
}
mkdirSync(baselineDir, { recursive: true });

const port = process.env.VISUAL_SMOKE_PORT ?? '4186';
const base = `http://127.0.0.1:${port}`;
const vite = resolve(root, 'node_modules/vite/bin/vite.js');
const server = spawn(process.execPath, [vite, 'preview', '--port', port, '--host', '127.0.0.1'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));

const waitForServer = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(base);
      if (response.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`preview server did not start\n${serverLog}`);
};

const themes = ['studio', 'cream', 'british'];
const MAX_DIFF_RATIO = 0.015;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

let browser;
try {
  await waitForServer();
  browser = await chromium.launch();

  for (const theme of themes) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      timezoneId: 'UTC',
      locale: 'en-US',
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') });
    await page.addInitScript(({ theme }) => {
      localStorage.setItem('stomp.theme', theme);
      localStorage.setItem('stomp.density', 'comfortable');
      localStorage.setItem('stomp.motion', 'reduced');
      localStorage.setItem('stomp.compactChain', '0');
      Math.random = () => 0.5;
    }, { theme });

    const capture = async (name, prepare) => {
      await page.goto(`${base}/?shot=${name}#board`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.pedal');
      await page.evaluate(() => document.fonts.ready);
      await prepare?.();
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      const actual = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      const file = resolve(baselineDir, `${theme}-${name}.png`);

      if (update) {
        writeFileSync(file, actual);
        console.log(`UPDATED ${theme}/${name}`);
        return;
      }
      assert(existsSync(file), `missing baseline ${file}; run pnpm test:visual:update`);
      const expected = PNG.sync.read(readFileSync(file));
      const received = PNG.sync.read(actual);
      assert(
        expected.width === received.width && expected.height === received.height,
        `${theme}/${name}: screenshot size changed (${expected.width}x${expected.height} → ${received.width}x${received.height})`,
      );
      const diff = new PNG({ width: expected.width, height: expected.height });
      const pixels = pixelmatch(
        expected.data,
        received.data,
        diff.data,
        expected.width,
        expected.height,
        { threshold: 0.15, includeAA: false },
      );
      const ratio = pixels / (expected.width * expected.height);
      if (ratio > MAX_DIFF_RATIO) {
        const diffFile = resolve(baselineDir, `${theme}-${name}.diff.png`);
        writeFileSync(diffFile, PNG.sync.write(diff));
        throw new Error(
          `${theme}/${name}: ${pixels} pixels differ (${(ratio * 100).toFixed(3)}%, limit ${(MAX_DIFF_RATIO * 100).toFixed(1)}%); see ${diffFile}`,
        );
      }
      console.log(`PASS ${theme}/${name} (${(ratio * 100).toFixed(3)}% diff)`);
    };

    await capture('board', async () => undefined);
    await capture('parametric-eq', async () => {
      await page.locator('.chain-add').click();
      await page.locator('.menu--blocks .menu__item', { hasText: 'Parametric EQ' }).click();
      await page.waitForSelector('.parametric-eq .eq-band-card');
      await page.locator('.inspector').evaluate((element) => {
        element.scrollTo({ top: 255 });
      });
    });
    await capture('amp', async () => {
      await page.locator('.nav-tab', { hasText: 'Amp room' }).click();
      await page.waitForSelector('.amp-lane');
    });
    await capture('eq', async () => {
      await page.locator('.nav-tab', { hasText: 'Global EQ' }).click();
      await page.waitForSelector('.eq-band-card');
    });
    await capture('library', async () => {
      await page.locator('.nav-tab', { hasText: 'Library' }).click();
      await page.waitForSelector('.library-scope');
    });
    await capture('settings', async () => {
      await page.locator('.nav-tab', { hasText: 'Settings' }).click();
      await page.waitForSelector('.settings-nav__item');
    });
    await capture('stage', async () => {
      await page.locator('.nav-tab', { hasText: 'Stage mode' }).click();
      await page.waitForSelector('.stage-tile');
    });
    await capture('tuner', async () => {
      await page.keyboard.press('t');
      await page.waitForSelector('.tuner-deck');
    });

    assert(errors.length === 0, `${theme}: page errors\n${errors.join('\n')}`);
    await context.close();
  }

  console.log(update ? 'VISUAL BASELINES UPDATED' : 'VISUAL REGRESSION PASSED');
} finally {
  await browser?.close();
  server.kill();
}
