import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';

const root = resolve(process.cwd());
const dist = resolve(root, 'dist/index.html');
if (!existsSync(dist)) {
  console.error('dist/index.html is missing — run `pnpm build` first.');
  process.exit(1);
}

const port = process.env.A11Y_SMOKE_PORT ?? '4180';
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
const views = [
  { id: 'board', label: 'Board', selector: '.pedal' },
  { id: 'amp', label: 'Amp room', selector: '.amp-lane' },
  { id: 'eq', label: 'Global EQ', selector: '.eq-band-card' },
  { id: 'library', label: 'Library', selector: '.library-scope' },
  { id: 'settings', label: 'Settings', selector: '.settings-nav__item' },
  { id: 'stage', label: 'Stage mode', selector: '.stage-tile' },
];

const summarize = (violations) =>
  violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      summary: node.failureSummary?.split('\n').slice(0, 3).join(' '),
    })),
  }));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

let browser;
try {
  await waitForServer();
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  const scan = async (label, target = page) => {
    const results = await new AxeBuilder({ page: target })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    if (results.violations.length > 0) {
      const details = JSON.stringify(summarize(results.violations), null, 2);
      throw new Error(`${label}: ${results.violations.length} accessibility violation(s)\n${details}`);
    }
    console.log(`PASS ${label}`);
  };

  for (const theme of themes) {
    await page.goto(`${base}/#board`, { waitUntil: 'networkidle' });
    await page.evaluate((value) => localStorage.setItem('stomp.theme', value), theme);
    await page.reload({ waitUntil: 'networkidle' });

    for (const view of views) {
      await page.locator('.nav-tab', { hasText: 'Board' }).click();
      await page.waitForSelector('.pedal');
      if (view.id !== 'board') {
        await page.locator('.nav-tab', { hasText: view.label }).click();
      }
      await page.waitForSelector(view.selector);
      await page.waitForTimeout(120);
      await scan(`${theme}/${view.id}`);
      if (view.id === 'stage') {
        await page.keyboard.press('Escape');
        await page.waitForSelector('.pedal');
      }
    }

    await page.locator('.nav-tab', { hasText: 'Board' }).click();
    await page.waitForSelector('.pedal');
    await page.locator('.chain-add').click();
    await page.locator('.menu--blocks .menu__item', { hasText: 'Parametric EQ' }).click();
    await page.waitForSelector('.parametric-eq .eq-band-card');
    await page.waitForTimeout(180);
    await scan(`${theme}/parametric-eq`);
    await page.locator('.nav-tab', { hasText: 'Board' }).click();
    await page.waitForSelector('.pedal');

    await page.keyboard.press('t');
    await page.waitForSelector('.tuner-deck');
    await page.waitForTimeout(250);
    await scan(`${theme}/tuner`);
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+K');
    await page.waitForSelector('.command-palette');
    await page.waitForTimeout(250);
    await scan(`${theme}/command-palette`);
    await page.keyboard.press('Escape');

    await page.keyboard.press('?');
    await page.waitForSelector('.shortcuts-dialog, .dialog-content');
    await page.waitForTimeout(250);
    await scan(`${theme}/shortcuts`);
    await page.keyboard.press('Escape');

    await page.locator('.connection-pill').click();
    await page.waitForSelector('.connection-sheet');
    await page.waitForTimeout(250);
    await scan(`${theme}/connection`);
    await page.keyboard.press('Escape');

    await page.locator('.status-link[aria-label^="Activity log"]').click();
    await page.waitForSelector('.activity-drawer');
    await page.waitForTimeout(250);
    await scan(`${theme}/activity`);
    await page.keyboard.press('Escape');

    await page.locator('[aria-label="Patch actions"]').click();
    await page.getByRole('menuitem', { name: /Rename/ }).click();
    await page.waitForSelector('.dialog-content');
    await page.waitForTimeout(250);
    await scan(`${theme}/rename-dialog`);
    await page.keyboard.press('Escape');

    await page.locator('[aria-label="Patch actions"]').click();
    await page.getByRole('menuitem', { name: /Save as/ }).click();
    await page.waitForSelector('.dialog-content');
    await page.waitForTimeout(250);
    await scan(`${theme}/save-as-dialog`);
    await page.keyboard.press('Escape');

    await page.locator('.preset-row__delete').first().click();
    await page.waitForSelector('.dialog-content');
    await page.waitForTimeout(250);
    await scan(`${theme}/delete-dialog`);
    await page.keyboard.press('Escape');

    await page.locator('button[aria-label="Chain actions"]').click();
    await page.getByRole('menuitem', { name: /Clear chain/ }).click();
    await page.waitForSelector('.dialog-content');
    await page.waitForTimeout(250);
    await scan(`${theme}/clear-chain-dialog`);
    await page.keyboard.press('Escape');
  }

  // The narrow-window preset drawer is the only way to reach patches there.
  await page.setViewportSize({ width: 800, height: 900 });
  await page.evaluate(() => localStorage.setItem('stomp.theme', 'studio'));
  await page.goto(`${base}/#board`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.pedal');
  await page.getByRole('button', { name: 'Open patches drawer' }).click();
  await page.waitForSelector('.preset-drawer');
  await page.waitForTimeout(250);
  await scan('narrow/preset-drawer');
  await page.keyboard.press('Escape');

  // Phone layout: wrapped chain cards, the full-screen block editor, and the
  // centered connection sheet each need their own accessibility pass.
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
    colorScheme: 'dark',
    timezoneId: 'UTC',
    locale: 'en-US',
  });
  const mobilePage = await mobileContext.newPage();
  mobilePage.on('pageerror', (error) => errors.push(`mobile pageerror: ${error.message}`));
  mobilePage.on('console', (message) => {
    if (message.type() === 'error') errors.push(`mobile console: ${message.text()}`);
  });
  await mobilePage.addInitScript(() => {
    localStorage.setItem('stomp.theme', 'studio');
    localStorage.setItem('stomp.density', 'comfortable');
    localStorage.setItem('stomp.motion', 'reduced');
    Math.random = () => 0.5;
  });
  await mobilePage.goto(`${base}/#board`, { waitUntil: 'networkidle' });
  await mobilePage.waitForSelector('.mobile-block-card');
  assert(
    (await mobilePage.locator('#nav-tab-amp').count()) === 0,
    'Amp room must not be reachable on phones',
  );
  await scan('mobile/chain', mobilePage);

  await mobilePage.locator('.mobile-block-card').first().click();
  await mobilePage.waitForSelector('.inspector--mobile');
  await scan('mobile/editor', mobilePage);

  await mobilePage.locator('.inspector__back-btn').click();
  await mobilePage.waitForSelector('.mobile-block-card');
  await mobilePage.locator('.connection-pill').click();
  await mobilePage.waitForSelector('.connection-sheet');
  await scan('mobile/connection', mobilePage);
  await mobilePage.keyboard.press('Escape');
  await mobileContext.close();

  assert(errors.length === 0, `page errors:\n${errors.join('\n')}`);
  console.log('A11Y SMOKE PASSED');
} finally {
  await browser?.close();
  server.kill();
}
