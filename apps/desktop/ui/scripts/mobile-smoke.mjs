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

const port = process.env.MOBILE_SMOKE_PORT ?? '4188';
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

const androidUserAgent =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';

let browser;
try {
  await waitForServer();
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: androidUserAgent,
    colorScheme: 'dark',
    timezoneId: 'UTC',
    locale: 'en-US',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem('stomp.theme', 'studio');
    localStorage.setItem('stomp.density', 'comfortable');
    localStorage.setItem('stomp.motion', 'reduced');
    Math.random = () => 0.5;
  });

  await page.goto(`${base}/#board`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.mobile-block-card');
  assert((await page.locator('.mobile-block-card').count()) === 9, 'mobile chain should show nine blocks');
  assert(
    (await page.locator('.mobile-chain .knob').count()) === 0,
    'mobile chain cards must not contain interactive knobs',
  );
  assert(
    (await page.locator('#nav-tab-amp').count()) === 0,
    'Amp room must not be exposed on mobile',
  );
  assert(
    await page.locator('.nav-tab__short').first().isVisible(),
    'mobile tabs should show short labels',
  );
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert(pageOverflow <= 2, `mobile board has horizontal overflow (${pageOverflow}px)`);

  // Selecting a block opens the full-height editor; back returns to the chain.
  await page.locator('.mobile-block-card').first().click();
  await page.waitForSelector('.inspector--mobile');
  assert((await page.locator('.mobile-chain').count()) === 0, 'editor should replace the chain pane');
  const editorHeight = await page.locator('.inspector--mobile').boundingBox();
  assert(editorHeight && editorHeight.height > 320, 'mobile editor is not using the available height');
  await page.locator('.inspector__back-btn').click();
  await page.waitForSelector('.mobile-block-card');

  // The connection sheet is centered, not anchored to the bottom.
  await page.locator('.connection-pill').click();
  await page.waitForSelector('.connection-sheet');
  const sheet = await page.locator('.connection-sheet').boundingBox();
  const viewport = page.viewportSize();
  assert(sheet && viewport, 'connection sheet or viewport missing');
  const centerOffset = Math.abs(sheet.y + sheet.height / 2 - viewport.height / 2);
  assert(centerOffset <= 6, `connection sheet is not centered (${centerOffset}px off)`);
  assert(sheet.width <= viewport.width, 'connection sheet is wider than the viewport');
  assert(
    await page.locator('.connection-sheet__foot').isVisible(),
    'connection sheet footer is not visible',
  );
  await page.locator('.connection-sheet [aria-label="Close connection sheet"]').click();

  // Narrower phone: the tab labels and chain grid must still fit.
  await page.setViewportSize({ width: 360, height: 640 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.mobile-block-card');
  const narrowOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert(narrowOverflow <= 2, `360px mobile board has horizontal overflow (${narrowOverflow}px)`);
  assert(
    (await page.locator('#nav-tab-amp').count()) === 0,
    'Amp room tab reappeared at 360px',
  );

  // A stale mobile deep link must not open the desktop-only amp room.
  await page.goto(`${base}/?mobile-deep=1#amp`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.mobile-block-card');
  assert(
    (await page.evaluate(() => window.location.hash)) === '#board',
    'mobile #amp deep link did not normalize to #board',
  );

  // Landscape phones keep the compact chain + inspector layout.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.signal-chain .pedal');
  assert(
    (await page.locator('.signal-chain .pedal').count()) === 9,
    'landscape phone should use the nine-pedal chain layout',
  );
  assert(
    (await page.locator('#nav-tab-amp').count()) === 0,
    'Amp room tab reappeared in landscape',
  );
  const landscapeOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert(
    landscapeOverflow <= 2,
    `landscape phone has horizontal overflow (${landscapeOverflow}px)`,
  );

  assert(errors.length === 0, `mobile page errors:\n${errors.join('\n')}`);
  console.log('MOBILE SMOKE PASSED');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
