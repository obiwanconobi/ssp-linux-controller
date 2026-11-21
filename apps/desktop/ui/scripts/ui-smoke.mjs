import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.cwd());
const dist = resolve(root, 'dist/index.html');
if (!existsSync(dist)) {
  console.error('dist/index.html is missing — run `pnpm build` first.');
  process.exit(1);
}

const port = process.env.UI_SMOKE_PORT ?? '4173';
const base = `http://127.0.0.1:${port}`;
const vite = resolve(root, 'node_modules/vite/bin/vite.js');
const server = spawn(process.execPath, [vite, 'preview', '--port', port, '--host', '127.0.0.1'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));

const localCaptures = mkdtempSync(join(tmpdir(), 'stomp-captures-'));
mkdirSync(join(localCaptures, 'sub'), { recursive: true });
writeFileSync(join(localCaptures, 'Amp.nam'), '{}');
writeFileSync(join(localCaptures, 'Drive.pnam'), '{}');
writeFileSync(join(localCaptures, 'sub', 'Cab.wav'), 'RIFF');

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

let browser;
try {
  await waitForServer();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  await page.goto(`${base}/#board`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.pedal');
  assert((await page.locator('.pedal').count()) === 9, 'expected nine pedal shells');

  const before = await page.locator('.knob__dial[aria-label^="Gain"]').first().getAttribute('aria-valuenow');
  const dial = page.locator('.knob__dial[aria-label^="Gain"]').first();
  const box = await dial.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 26, { steps: 6 });
  await page.mouse.up();
  const after = await dial.getAttribute('aria-valuenow');
  assert(before !== after, 'knob drag did not change its value');
  assert(
    (await page.locator('.title-bar__state .chip').first().textContent())?.includes('Edited'),
    'knob edit did not mark the preset edited',
  );

  // Click the value text to type an exact value, then reject an out-of-range one.
  await page.locator('.inspector .control-grid .knob__readout').first().click();
  const valueInput = page.locator('.inspector .control-grid .knob__readout-input').first();
  await valueInput.fill('8.2');
  await valueInput.press('Enter');
  assert(
    (await page.locator('.inspector .control-grid .knob__readout').first().textContent())?.includes('8.2'),
    'typed knob value was not committed',
  );
  await page.locator('.inspector .control-grid .knob__readout').first().click();
  const invalidInput = page.locator('.inspector .control-grid .knob__readout-input').first();
  await invalidInput.fill('99');
  await invalidInput.press('Enter');
  assert(
    (await invalidInput.getAttribute('aria-invalid')) === 'true',
    'out-of-range typed knob value was not rejected',
  );
  await invalidInput.press('Escape');

  // Parametric NAM must swap both the control list and the model list.
  const typeGroup = page.locator('.inspector__type .segmented');
  const typeBox = await page.locator('.inspector__type').boundingBox();
  const modelBox = await page.locator('.inspector__model').boundingBox();
  assert(
    Boolean(typeBox && modelBox && typeBox.y < modelBox.y),
    'Type must appear above the model selector',
  );
  await typeGroup.getByRole('button', { name: 'Parametric NAM' }).click();
  await page.waitForTimeout(250);
  const modelOptions = await page.locator('.inspector__model-select option').allTextContents();
  assert(modelOptions.some((option) => option.includes('Dumble Drive PNAM')), 'PNAM model list did not load');
  assert(
    (await page.locator('.inspector').innerText()) .toLowerCase().includes('character'),
    'PNAM controls did not load',
  );
  await typeGroup.getByRole('button', { name: 'NAM', exact: true }).click();
  await page.waitForTimeout(200);

  const plates = await page.locator('.signal-chain .pedal__plate').allTextContents();
  const driveHandle = page.locator('.signal-chain .pedal').nth(3).locator('.pedal__plate');
  const compPedal = page.locator('.signal-chain .pedal').nth(2);
  const grabBox = await driveHandle.boundingBox();
  const compBox = await compPedal.boundingBox();
  await page.mouse.move(grabBox.x + grabBox.width / 2, grabBox.y + grabBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(compBox.x + compBox.width / 2, compBox.y + compBox.height / 2, { steps: 18 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const reordered = await page.locator('.signal-chain .pedal__plate').allTextContents();
  assert(reordered.join(',') !== plates.join(','), 'drag reorder did not change the chain order');

  // Replace the selected block in one action, then remove it again.
  await page.locator('.signal-chain .pedal').first().click();
  await page.locator('[aria-label="Block actions"]').click();
  await page.locator('.menu__item', { hasText: 'Replace with' }).click();
  await page.waitForSelector('.menu--sub');
  await page.locator('.menu--sub .menu__item', { hasText: 'Chorus' }).click();
  await page.waitForTimeout(250);
  assert(
    (await page.locator('.signal-chain .pedal__plate').allTextContents()).some((text) =>
      text.includes('CHORUS'),
    ),
    'replace-with did not add the chosen block',
  );
  assert((await page.locator('.signal-chain .pedal').count()) === 9, 'replace-with changed the chain length');

  await page.locator('[aria-label="Block actions"]').click();
  await page.locator('.menu__item', { hasText: 'Remove from chain' }).click();
  await page.waitForTimeout(250);
  assert((await page.locator('.signal-chain .pedal').count()) === 8, 'remove-from-chain did not remove the block');
  assert(
    (await page.locator('.inspector--empty').count()) === 0,
    'remove-from-chain left the inspector without a following block',
  );

  await page.keyboard.press('Control+K');
  await page.waitForSelector('.command-palette');
  await page.locator('.command-palette__search input').fill('amp room');
  assert((await page.locator('.command-palette__item').count()) >= 1, 'command palette produced no result');
  await page.keyboard.press('Escape');

  await page.locator('.nav-tab', { hasText: 'Amp room' }).click();
  await page.waitForSelector('.amp-lane');
  assert((await page.locator('.amp-lane').count()) === 2, 'amp room did not show two lanes');
  assert((await page.locator('.amp-lane__face').count()) === 2, 'amp face plates are missing');

  await page.locator('.nav-tab', { hasText: 'Global EQ' }).click();
  await page.waitForSelector('.eq-band-card');
  assert((await page.locator('.eq-band-card').count()) === 4, 'global EQ did not show four bands');
  const handle = page.locator('.eq-graph__handle').nth(1);
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 44, handleBox.y - 18, { steps: 6 });
  await page.mouse.up();
  assert(
    (await page.locator('.eq-band-card').nth(1).locator('.eq-band-card__gain').textContent())?.length,
    'EQ graph drag did not update the band card',
  );

  await page.locator('.nav-tab', { hasText: 'Library' }).click();
  await page.waitForSelector('.library-table tbody tr');
  assert((await page.locator('.library-table tbody tr').count()) > 8, 'library table is empty');

  await page.locator('.segmented button', { hasText: 'Local files' }).click();
  await page.locator('input[webkitdirectory]').setInputFiles(localCaptures);
  await page.waitForTimeout(250);
  assert((await page.locator('.local-library tbody tr').count()) === 3, 'local folder scan did not list captures');
  await page.locator('.local-library tbody tr').first().locator('button', { hasText: 'Preflight' }).click();
  assert(await page.locator('.preflight').isVisible(), 'local preflight did not open');

  await page.locator('.nav-tab', { hasText: 'Settings' }).click();
  await page.waitForSelector('.settings-nav__item');
  await page.locator('.settings-nav__item', { hasText: 'Appearance' }).click();
  await page.waitForSelector('.theme-card');
  assert((await page.locator('.theme-card').count()) === 3, 'expected three built-in themes');
  await page.locator('.theme-card', { hasText: 'Cream Tolex' }).click();
  assert((await page.locator('html').getAttribute('data-theme')) === 'cream', 'theme did not apply');
  await page.locator('.settings-card__head .btn', { hasText: 'Reset to Studio Black' }).click();
  assert((await page.locator('html').getAttribute('data-theme')) === 'studio', 'theme reset failed');

  await page.locator('.nav-tab', { hasText: 'Stage mode' }).click();
  await page.waitForSelector('.stage-tile');
  assert((await page.locator('.stage-tile').count()) === 9, 'stage mode should show eight bypass tiles plus tuner');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  assert((await page.locator('.nav-tab[aria-selected="true"]').textContent())?.includes('Board'), 'Escape did not return to the board');

  await page.keyboard.press('t');
  await page.waitForSelector('.tuner-deck');
  assert(await page.locator('.tuner-deck').isVisible(), 'tuner deck did not open');
  await page.keyboard.press('Escape');

  assert(errors.length === 0, `UI console errors:\n${errors.join('\n')}`);
  console.log('UI SMOKE PASSED');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  rmSync(localCaptures, { recursive: true, force: true });
}
