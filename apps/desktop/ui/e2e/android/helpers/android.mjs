import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname_ = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(dirname_, '../../../../../..');
export const UI_DIR = resolve(REPO_ROOT, 'apps/desktop/ui');
export const APP_ID = process.env.STOMPSTATION_PACKAGE ?? 'pro.stompstation.desktop';
export const SIM_PORT = process.env.STOMP_SIM_PORT ?? '45700';
export const DIAGNOSTICS_DIR =
  process.env.E2E_DIAGNOSTICS_DIR ?? resolve(REPO_ROOT, 'dist/android/e2e/diagnostics');

/**
 * A board block in either layout: compact cards on phones, pedal shells on
 * tablets/landscape. Keep specs layout-agnostic with this selector.
 */
export const BOARD_BLOCK = '.mobile-block-card, .signal-chain .pedal';

function adbBinary() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  return sdk ? resolve(sdk, 'platform-tools', 'adb') : 'adb';
}

function adbDeviceArgs() {
  return process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
}

export function adb(args, { encoding = 'utf8', timeout = 30000 } = {}) {
  const result = spawnSync(adbBinary(), [...adbDeviceArgs(), ...args], {
    encoding,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

export function adbText(args, options = {}) {
  const result = adb(args, options);
  if (result.status !== 0) {
    throw new Error(
      `adb ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return (result.stdout ?? '').trim();
}

export function reverseSimulatorPort(port = SIM_PORT) {
  const result = adb(['reverse', `tcp:${port}`, `tcp:${port}`]);
  if (result.status !== 0) {
    console.warn(
      `[android] adb reverse tcp:${port} failed; the app will not reach the host simulator.\n` +
        `${result.stderr ?? ''}`,
    );
  }
}

export function clearAppData(appId = APP_ID) {
  const result = adb(['shell', 'pm', 'clear', appId]);
  // pm clear fails when the app is not installed; that is fine before install.
  return result.status === 0;
}

/**
 * Click through the DOM instead of WebDriver's hit-tested elementClick.
 * Chromedriver's coordinate mapping is offset by the Android visual viewport
 * inset, so elementClick can report an element as "not interactable" when the
 * button is actually visible. DOM click still runs the React handler; use a
 * native-context tap when the test is specifically about touch hit-testing.
 */
export async function jsClick(browser, selector) {
  await browser.execute((sel) => {
    const element = document.querySelector(sel);
    if (!element) throw new Error(`missing element: ${sel}`);
    element.click();
  }, selector);
}

export async function openConnectionSheet(browser) {
  const sheet = browser.$('.connection-sheet');
  if (await sheet.isDisplayed()) return;
  await jsClick(browser, '.connection-pill');
  await sheet.waitForDisplayed({ timeout: 15_000 });
}

export async function disconnectIfConnected(browser) {
  const disconnect = browser.$('.connection-sheet .btn--danger');
  if (!(await disconnect.isDisplayed())) return;
  await jsClick(browser, '.connection-sheet .btn--danger');
  await browser
    .$('.connection-sheet')
    .waitForDisplayed({ reverse: true, timeout: 10_000 });
  await jsClick(browser, '.connection-pill');
  await browser.$('.connection-sheet').waitForDisplayed({ timeout: 10_000 });
}

export async function waitForScanToSettle(browser) {
  // The mDNS scan inserts/removes a status banner, which changes the sheet
  // height and can move the Connect button while a click is in flight.
  const searching = browser.$('.connection-search[role="status"]');
  if (await searching.isDisplayed()) {
    await searching
      .waitForDisplayed({ reverse: true, timeout: 30_000 })
      .catch(() => undefined);
  }
  await browser.pause(200);
}

export async function connectToSimulator(browser, port = SIM_PORT) {
  const input = browser.$('#manual-address');
  await input.waitForDisplayed({ timeout: 15_000 });
  await waitForScanToSettle(browser);
  await input.setValue(`127.0.0.1:${port}`);
  await jsClick(browser, '.connection-sheet__actions .btn--primary');
  await browser.$(BOARD_BLOCK).waitForDisplayed({ timeout: 60_000 });
}

/** Open the first board block using whichever board layout is active. */
export async function openFirstBlockEditor(browser) {
  const card = browser.$('.mobile-block-card');
  const selector = (await card.isExisting())
    ? '.mobile-block-card'
    : '.signal-chain .pedal';
  await jsClick(browser, selector);
  await browser.$('.inspector').waitForDisplayed({ timeout: 15_000 });
}

/** Ensure the app is connected to the deterministic host simulator. */
export async function ensureSimulatorConnection(browser, port = SIM_PORT) {
  await openConnectionSheet(browser);
  await disconnectIfConnected(browser);
  await connectToSimulator(browser, port);
}

export function pushFixture(localPath, remoteName, remoteDir = '/sdcard/Download') {
  const result = adb(['push', localPath, `${remoteDir}/${remoteName}`], {
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `adb push failed (${result.status}): ${result.stderr ?? result.stdout}`,
    );
  }
  // Make the file immediately visible to DocumentsUI/MediaStore.
  adb(['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
    '-d', `file://${remoteDir}/${remoteName}`]);
}

export async function dismissAnrDialogs(browser) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const close = browser.$('id=android:id/aerr_close');
    if (!(await close.isExisting())) return;
    console.warn('[android] closing an "isn\'t responding" system dialog');
    await close.click();
    await browser.pause(500);
  }
}

export async function waitForWebViewContext(browser, appId = APP_ID) {
  let webview;
  await browser.waitUntil(
    async () => {
      const contexts = (await browser.getAppiumContexts()).map((context) =>
        typeof context === 'string' ? context : context.id,
      );
      webview = contexts.find((name) => name === `WEBVIEW_${appId}`);
      if (!webview) return false;
      try {
        await browser.switchAppiumContext(webview);
        return true;
      } catch {
        // The context can be listed before the page is attachable.
        return false;
      }
    },
    {
      timeout: 120_000,
      interval: 1000,
      timeoutMsg:
        'no WEBVIEW context appeared — is the app a debug build with WebView debugging enabled?',
    },
  );
  return webview;
}

export function captureDiagnostics(label = 'failure') {
  try {
    const safeLabel = label.replace(/[^\w-]+/g, '_').slice(0, 80);
    const dir = resolve(
      DIAGNOSTICS_DIR,
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeLabel}`,
    );
    mkdirSync(dir, { recursive: true });

    const commands = {
      'devices.txt': ['devices', '-l'],
      'window.txt': ['shell', 'dumpsys', 'window'],
      'activities.txt': ['shell', 'dumpsys', 'activity', 'activities'],
      'forwards.txt': ['forward', '--list'],
      'reverses.txt': ['reverse', '--list'],
      'logcat.txt': ['logcat', '-d', '-t', '20000'],
    };
    for (const [file, args] of Object.entries(commands)) {
      const result = adb(args, { timeout: 60000 });
      writeFileSync(resolve(dir, file), result.stdout ?? '');
    }

    const sockets = adb(['shell', 'cat', '/proc/net/unix'], { timeout: 60000 });
    writeFileSync(
      resolve(dir, 'webview-sockets.txt'),
      (sockets.stdout ?? '')
        .split('\n')
        .filter((line) => line.includes('webview_devtools_remote'))
        .join('\n'),
    );

    const screenshot = adb(['exec-out', 'screencap', '-p'], {
      encoding: 'buffer',
      timeout: 30000,
    });
    if (screenshot.status === 0) {
      writeFileSync(resolve(dir, 'screen.png'), screenshot.stdout);
    }

    console.warn(`[android diagnostics] ${dir}`);
  } catch (error) {
    console.warn(
      `[android diagnostics] failed to capture: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}
