import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.cwd());
const dist = resolve(root, 'dist/index.html');
if (!existsSync(dist)) {
  console.error('dist/index.html is missing — run `pnpm build` first.');
  process.exit(1);
}

const port = process.env.KEYBOARD_SMOKE_PORT ?? '4181';
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

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const active = (page) =>
  page.evaluate(() => ({
    id: document.activeElement?.id ?? '',
    className:
      typeof document.activeElement?.className === 'string'
        ? document.activeElement.className
        : '',
    ariaLabel: document.activeElement?.getAttribute('aria-label') ?? '',
  }));

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

  await page.goto(`${base}/#board`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.pedal');

  // The first Tab reaches the skip link, and Enter moves focus to the view panel.
  await page.keyboard.press('Tab');
  assert((await active(page)).className.includes('skip-link'), 'first Tab did not focus the skip link');
  await page.keyboard.press('Enter');
  assert((await active(page)).id === 'view-panel', 'skip link did not focus the main view');

  // Tabs support arrow/Home/End navigation with a roving tab stop.
  await page.locator('#nav-tab-board').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('.amp-lane');
  assert(
    (await page.locator('#nav-tab-amp').getAttribute('aria-selected')) === 'true',
    'ArrowRight did not activate the Amp room tab',
  );
  assert((await active(page)).id === 'nav-tab-amp', 'ArrowRight did not move focus to the tab');
  await page.keyboard.press('End');
  await page.waitForSelector('.stage-tile');
  assert((await active(page)).id === 'view-panel', 'entering stage did not focus the main view');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pedal');
  assert((await active(page)).id === 'view-panel', 'Escape from stage did not focus the main view');

  // Number shortcuts and preset stepping.
  await page.keyboard.press('3');
  await page.waitForSelector('.eq-band-card');
  assert(
    (await page.locator('#nav-tab-eq').getAttribute('aria-selected')) === 'true',
    'number shortcut did not open Global EQ',
  );
  const presetBefore = await page.locator('.preset-nav__name').textContent();
  await page.keyboard.press(']');
  await page.waitForTimeout(120);
  const presetAfter = await page.locator('.preset-nav__name').textContent();
  assert(presetBefore !== presetAfter, '] did not step to the next preset');
  await page.keyboard.press('[');
  await page.waitForTimeout(120);
  assert(
    (await page.locator('.preset-nav__name').textContent()) === presetBefore,
    '[ did not step back to the previous preset',
  );

  // Knobs expose the slider keyboard contract.
  await page.keyboard.press('1');
  await page.waitForSelector('.pedal');
  const dial = page.locator('.knob__dial').first();
  await dial.focus();
  const before = Number(await dial.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(80);
  assert(
    Number(await dial.getAttribute('aria-valuenow')) > before,
    'ArrowUp did not increase the focused knob',
  );
  await page.keyboard.press('Home');
  assert(
    Number(await dial.getAttribute('aria-valuenow')) ===
      Number(await dial.getAttribute('aria-valuemin')),
    'Home did not move the knob to its minimum',
  );
  await page.keyboard.press('End');
  assert(
    Number(await dial.getAttribute('aria-valuenow')) ===
      Number(await dial.getAttribute('aria-valuemax')),
    'End did not move the knob to its maximum',
  );

  // Global shortcuts still work while a knob owns focus.
  await page.keyboard.press('3');
  await page.waitForSelector('.eq-band-card');
  assert(
    (await page.locator('#nav-tab-eq').getAttribute('aria-selected')) === 'true',
    'number shortcut did not work from a focused knob',
  );
  await page.keyboard.press('1');
  await page.waitForSelector('.pedal');

  // Command-palette keyboard navigation runs the selected action.
  await page.keyboard.press('Control+K');
  await page.waitForSelector('.command-palette');
  const search = page.locator('.command-palette__search input');
  assert(await search.evaluate((element) => element === document.activeElement), 'search is not auto-focused');
  await search.fill('theme');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert(
    (await page.locator('html').getAttribute('data-theme')) !== 'studio',
    'command-palette Enter did not switch the theme',
  );

  // Restore Studio Black through the Settings UI using only the keyboard.
  await page.keyboard.press('5');
  await page.waitForSelector('.settings-nav__item');
  await page.locator('.settings-nav__item', { hasText: 'Appearance' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.theme-card');
  await page
    .locator('.settings-card__head .btn', { hasText: 'Reset to Studio Black' })
    .focus();
  await page.keyboard.press('Enter');
  assert(
    (await page.locator('html').getAttribute('data-theme')) === 'studio',
    'keyboard theme reset did not restore Studio Black',
  );

  // EQ graph handles support arrow keys.
  await page.keyboard.press('3');
  await page.waitForSelector('.eq-graph__handle');
  const eqHandle = page.locator('.eq-graph__handle').first();
  await eqHandle.focus();
  const eqBefore = Number(await eqHandle.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(80);
  assert(
    Number(await eqHandle.getAttribute('aria-valuenow')) > eqBefore,
    'ArrowUp did not raise the focused EQ band',
  );

  // Library segmented controls activate with Enter.
  await page.keyboard.press('4');
  await page.waitForSelector('.library-scope');
  const localTab = page.locator('.segmented button', { hasText: 'Local files' });
  await localTab.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert(
    (await localTab.getAttribute('aria-pressed')) === 'true',
    'Enter did not activate the Local files tab',
  );

  // Tuner and shortcuts shortcuts.
  await page.keyboard.press('1');
  await page.waitForSelector('.pedal');
  await page.keyboard.press('t');
  await page.waitForSelector('.tuner-deck');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert((await page.locator('.tuner-deck').count()) === 0, 'Escape did not close the tuner deck');

  await page.keyboard.press('?');
  await page.waitForSelector('.dialog-content');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert((await page.locator('.dialog-content').count()) === 0, 'Escape did not close shortcuts');

  // Menus and dialogs stay keyboard-operable and return focus to the trigger.
  await page.locator('[aria-label="Patch actions"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.menu');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#preset-name');
  assert((await active(page)).id === 'preset-name', 'rename dialog did not focus the name field');
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('.dialog-content')),
    );
    assert(inside, 'Tab left the rename dialog');
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert(
    (await page.locator('#preset-name').count()) === 0,
    'Escape did not close the rename dialog',
  );
  assert(
    (await active(page)).ariaLabel === 'Patch actions',
    'closing the rename dialog did not return focus to Patch actions',
  );

  // Clear-chain confirmation also restores focus to its trigger.
  await page.locator('[aria-label="Chain actions"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.menu');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.dialog-content');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert(
    (await active(page)).ariaLabel === 'Chain actions',
    'closing clear-chain did not return focus to Chain actions',
  );

  assert(errors.length === 0, `page errors:\n${errors.join('\n')}`);
  console.log('KEYBOARD SMOKE PASSED');
} finally {
  await browser?.close();
  server.kill();
}
