/**
 * Fast Android WebView smoke test.
 *
 * Requires a debug APK already installed and running with WebView debugging
 * enabled. Attaches Playwright to the app's WebView over CDP, connects to the
 * host simulator through `adb reverse`, edits a knob through the real Tauri IPC
 * path, saves, and captures a screenshot.
 *
 * Run from apps/desktop/ui:
 *   node scripts/android-webview-smoke.mjs
 *
 * Env:
 *   STOMPSTATION_PACKAGE  default pro.stompstation.desktop
 *   STOMP_SIM_PORT        default 45700
 *   ANDROID_SERIAL        select a device
 *   CDP_PORT              default 9222
 *   E2E_ARTIFACT_DIR      default <repo>/dist/android/e2e
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const UI_DIR = resolve(process.cwd());
const REPO_ROOT = resolve(UI_DIR, '../../..');
const APP_ID = process.env.STOMPSTATION_PACKAGE ?? 'pro.stompstation.desktop';
const SIM_PORT = process.env.STOMP_SIM_PORT ?? '45700';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);
const BOARD_BLOCK = '.mobile-block-card, .signal-chain .pedal';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? resolve(REPO_ROOT, 'dist/android/e2e');
const ADB = resolve(
  process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? `${process.env.HOME}/Android/Sdk`,
  'platform-tools',
  'adb',
);
const SERIAL_ARGS = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function adb(args, encoding = 'utf8') {
  const result = spawnSync(ADB, [...SERIAL_ARGS, ...args], {
    encoding,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function adbText(args) {
  const result = adb(args);
  if (result.status !== 0) {
    throw new Error(`adb ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? '').trim();
}

function currentPid() {
  return adbText(['shell', 'pidof', APP_ID]).split(/\s+/)[0] || '';
}

async function waitForPid(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = currentPid();
    if (pid) return pid;
    await sleep(500);
  }
  throw new Error(`${APP_ID} is not running`);
}

async function waitForSocket(pid, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = adbText(['shell', 'cat', '/proc/net/unix']);
    const line = output
      .split('\n')
      .find((candidate) => candidate.includes(`webview_devtools_remote_${pid}`));
    if (line) return line.slice(line.indexOf('@') + 1);
    await sleep(500);
  }
  throw new Error(
    `No WebView devtools socket for ${APP_ID} (pid ${pid}). ` +
      'Use a debug build and let the page finish loading.',
  );
}

async function selectPage(browser) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    if (pages.length > 0) {
      for (const candidate of pages) {
        try {
          if (await candidate.locator('.connection-pill').count()) return candidate;
        } catch {
          /* page navigating */
        }
      }
      return pages[0];
    }
    await sleep(500);
  }
  throw new Error('Playwright did not see a page target in the Android WebView');
}

// Playwright's CDP mouse coordinates can be offset by visualViewport.offsetTop
// in the Android WebView (status-bar/edge-to-edge inset), so a coordinate click
// can land on the element above the target. DOM click still exercises the real
// React/Tauri handler and is reliable for this DOM-level smoke. Use Appium when
// the test specifically needs a real touch/hit target.
async function domClick(locator) {
  await locator.waitFor({ state: 'visible' });
  await locator.evaluate((element) => element.click());
}

async function openConnectionSheet(page) {
  const sheet = page.locator('.connection-sheet');
  if (await sheet.isVisible()) return;
  await domClick(page.locator('.connection-pill'));
  await sheet.waitFor({ state: 'visible', timeout: 15_000 });
}

async function disconnectIfConnected(page) {
  const disconnect = page.locator('.connection-sheet .btn--danger');
  if (!(await disconnect.isVisible())) return;
  await domClick(disconnect);
  await page.locator('.connection-sheet').waitFor({ state: 'hidden', timeout: 10_000 });
  await domClick(page.locator('.connection-pill'));
  await page.locator('.connection-sheet').waitFor({ state: 'visible', timeout: 10_000 });
}

async function waitForScanToSettle(page) {
  // The mDNS scan inserts/removes a status banner; clicking while it is
  // changing height can make Playwright land on the wrong element.
  const searching = page.locator('.connection-search[role="status"]');
  if (await searching.isVisible()) {
    await searching.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined);
  }
  await page.waitForTimeout(200);
}

async function connectToSimulator(page) {
  const input = page.locator('#manual-address');
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await waitForScanToSettle(page);
  await input.fill(`127.0.0.1:${SIM_PORT}`);
  await domClick(page.locator('.connection-sheet__actions .btn--primary'));
  await page
    .locator(BOARD_BLOCK)
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
}

async function captureFailure(page, error) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  try {
    if (page) {
      writeFileSync(
        resolve(ARTIFACT_DIR, 'webview-smoke-failure.html'),
        await page.content(),
      );
    }
  } catch {
    /* page may be gone */
  }
  try {
    if (page) {
      await page.screenshot({
        path: resolve(ARTIFACT_DIR, 'webview-smoke-failure.png'),
      });
    }
  } catch {
    /* ignore */
  }
  try {
    const logcat = adb(['logcat', '-d', '-t', '2000']);
    writeFileSync(resolve(ARTIFACT_DIR, 'webview-smoke-failure-logcat.txt'), logcat.stdout ?? '');
  } catch {
    /* ignore */
  }
  console.error(`\nANDROID WEBVIEW SMOKE FAILED: ${error instanceof Error ? error.message : error}`);
  console.error(`Artifacts: ${ARTIFACT_DIR}`);
}

let browser;
let page;
let forwarded = false;
try {
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  adbText(['reverse', `tcp:${SIM_PORT}`, `tcp:${SIM_PORT}`]);
  if (process.env.STOMPSTATION_CLEAR_DATA !== '0') {
    adb(['shell', 'pm', 'clear', APP_ID]);
    await sleep(750);
  }
  // -S forces a fresh process; without it a just-cleared app can leave the old
  // task in a "delivered to running instance" state and never restart.
  const start = adbText(['shell', 'am', 'start', '-S', '-W', '-n', `${APP_ID}/.MainActivity`]);
  if (/Error|Exception/i.test(start)) {
    throw new Error(`failed to launch ${APP_ID}: ${start}`);
  }

  const pid = await waitForPid();
  const socket = await waitForSocket(pid);
  adbText(['forward', `tcp:${CDP_PORT}`, `localabstract:${socket}`]);
  forwarded = true;

  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  console.log(`Android WebView: pid=${pid} socket=${socket} targets=${targets.length}`);

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  page = await selectPage(browser);
  page.setDefaultTimeout(30_000);

  await page.locator('.connection-pill').waitFor({
    state: 'visible',
    timeout: 30_000,
  });

  await openConnectionSheet(page);
  await disconnectIfConnected(page);
  await connectToSimulator(page);

  const blockCount = await page.locator(BOARD_BLOCK).count();
  if (blockCount !== 9) {
    throw new Error(`expected nine board blocks, found ${blockCount}`);
  }

  const mobileCard = page.locator('.mobile-block-card');
  await domClick(
    (await mobileCard.count())
      ? mobileCard.first()
      : page.locator('.signal-chain .pedal').first(),
  );
  await page.locator('.inspector').waitFor({ state: 'visible', timeout: 15_000 });

  const dial = page.locator('.inspector .knob__dial[aria-label^="Threshold"]');
  await dial.waitFor({ state: 'visible', timeout: 15_000 });
  const knob = dial.locator('..');
  const readout = knob.locator('.knob__readout');
  const before = Number(await dial.getAttribute('aria-valuenow'));
  const min = Number(await dial.getAttribute('aria-valuemin'));
  const max = Number(await dial.getAttribute('aria-valuemax'));
  // Toggle between the ends so the test is deterministic even when the
  // simulator retained the previous run's saved value.
  const target = before === max ? min : max;
  const key = before === max ? 'Home' : 'End';

  // Use the slider's keyboard contract. CDP typing into the controlled text
  // input does not reliably raise React's onChange inside the Android WebView;
  // Appium/WDIO covers real text entry.
  await dial.evaluate((element) => element.focus());
  await page.keyboard.press(key);

  await page.waitForFunction(
    (wanted) => {
      const element = document.querySelector('.inspector .knob__dial[aria-label^="Threshold"]');
      return element && Math.abs(Number(element.getAttribute('aria-valuenow')) - wanted) < 0.001;
    },
    target,
    { timeout: 10_000 },
  );

  const after = (await readout.textContent()) ?? '';
  const expected = (await dial.getAttribute('aria-valuetext')) ?? '';
  if (after.trim() !== expected.trim()) {
    throw new Error(`slider commit did not update the readout; got "${after}", expected "${expected}"`);
  }

  // Phones hide the title-bar save-state chip to keep the header within the
  // viewport; the status bar carries the same state at every width.
  await page
    .locator('.status-bar__save', { hasText: 'Edited' })
    .waitFor({ state: 'visible', timeout: 10_000 });

  const save = page.locator('.title-bar__save');
  if (!(await save.isEnabled())) throw new Error('Save button was disabled after an edit');
  await domClick(save);
  await page
    .locator('.status-bar__save', { hasText: 'Saved' })
    .waitFor({ state: 'visible', timeout: 30_000 });

  await page.screenshot({
    path: resolve(ARTIFACT_DIR, 'webview-smoke.png'),
  });

  console.log(`Board blocks: ${blockCount}`);
  console.log(`Knob: "${before}" -> "${after.trim()}"`);
  console.log(`Screenshot: ${resolve(ARTIFACT_DIR, 'webview-smoke.png')}`);
  console.log('ANDROID WEBVIEW SMOKE PASSED');
} catch (error) {
  await captureFailure(page, error);
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  if (forwarded) {
    try {
      adbText(['forward', '--remove', `tcp:${CDP_PORT}`]);
    } catch {
      /* ignore */
    }
  }
}
