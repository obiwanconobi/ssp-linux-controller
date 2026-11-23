// Mobile E2E pattern adapted from Tauri's plugins-workspace suite
// (MIT OR Apache-2.0):
// https://github.com/tauri-apps/plugins-workspace/tree/v2/packages/api-e2e
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_ID,
  REPO_ROOT,
  SIM_PORT,
  captureDiagnostics,
  clearAppData,
  dismissAnrDialogs,
  reverseSimulatorPort,
  waitForWebViewContext,
} from './helpers/android.mjs';

const dirname_ = dirname(fileURLToPath(import.meta.url));

// Appium and UiAutomator2 need these in their own process environment. Resolve
// the common local installs so `pnpm test` works without a shell profile.
if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
  const sdk = resolve(process.env.HOME ?? '', 'Android/Sdk');
  if (existsSync(sdk)) process.env.ANDROID_HOME = sdk;
}
if (process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
  process.env.ANDROID_SDK_ROOT = process.env.ANDROID_HOME;
}
if (!process.env.JAVA_HOME && existsSync('/opt/android-studio/jbr/bin/java')) {
  process.env.JAVA_HOME = '/opt/android-studio/jbr';
}
const toolPaths = [
  process.env.JAVA_HOME ? resolve(process.env.JAVA_HOME, 'bin') : '',
  process.env.ANDROID_HOME ? resolve(process.env.ANDROID_HOME, 'platform-tools') : '',
].filter(Boolean);
if (toolPaths.length > 0) {
  process.env.PATH = `${toolPaths.join(':')}:${process.env.PATH ?? ''}`;
}

const APK =
  process.env.STOMPSTATION_APK ??
  resolve(REPO_ROOT, 'dist/android/stompstation-x86_64-debug.apk');
const LOG_DIR = process.env.E2E_LOG_DIR ?? resolve(REPO_ROOT, 'dist/android/e2e/logs');

if (!existsSync(APK)) {
  throw new Error(
    `Debug APK not found at ${APK}. Build it first:\n` +
      '  ./scripts/build-android.sh x86_64 debug',
  );
}
mkdirSync(LOG_DIR, { recursive: true });

// Appium auto-discovers drivers installed as local devDependencies.
process.env.APPIUM_HOME ??= dirname_;

export const config = {
  specs: ['./specs/**/*.spec.mjs'],
  maxInstances: 1,
  capabilities: [
    {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:app': APK,
      'appium:appPackage': APP_ID,
      'appium:appActivity': '.MainActivity',
      // Every build has the same version code; force the rebuilt APK to install.
      'appium:enforceAppInstall': true,
      // The system WebView updates independently of the app.
      'appium:chromedriverAutodownload': true,
      'appium:autoGrantPermissions': true,
      // A system_server restart can temporarily remove the `settings` service;
      // do not fail the whole session over the hidden-API policy tweak.
      'appium:ignoreHiddenApiPolicyError': true,
      // Start from a clean app state; the spec also tolerates a remembered connection.
      'appium:noReset': false,
      ...(process.env.ANDROID_SERIAL ? { 'appium:udid': process.env.ANDROID_SERIAL } : {}),
      ...(process.env.ANDROID_AVD ? { 'appium:avd': process.env.ANDROID_AVD } : {}),
      // Slow emulators need room for the helper APK and first chromedriver download.
      'appium:uiautomator2ServerInstallTimeout': 120_000,
      'appium:uiautomator2ServerLaunchTimeout': 120_000,
      'appium:adbExecTimeout': 60_000,
      'appium:newCommandTimeout': 300,
    },
  ],
  services: [
    [
      'appium',
      {
        args: {
          address: '127.0.0.1',
          // Appium 4 requires insecure features to be scoped to the driver.
          allowInsecure: 'uiautomator2:chromedriver_autodownload',
        },
        appiumStartTimeout: 120_000,
        logPath: LOG_DIR,
      },
    ],
  ],
  reporters: ['spec'],
  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    timeout: 180_000,
  },
  connectionRetryCount: 0,
  // The board intentionally has multiple `.pedal`/`.knob` elements; `$`
  // resolves the first one instead of throwing a strict-mode violation.
  strictSelectors: false,
  // First session includes app install, UiAutomator2 server install, and possibly
  // a chromedriver download.
  connectionRetryTimeout: 600_000,
  logLevel: 'info',

  onPrepare: () => {
    // If a device is already running, start from a clean state. When Appium
    // boots the AVD for the first session, the spec's state handling covers it.
    if (process.env.STOMPSTATION_CLEAR_DATA !== '0') {
      const cleared = clearAppData();
      if (cleared) console.log(`[android] cleared app data for ${APP_ID}`);
    }
  },

  before: async (_capabilities, _specs, browser) => {
    reverseSimulatorPort(SIM_PORT);

    // Native context: close any system dialog that would steal focus.
    await dismissAnrDialogs(browser);

    await waitForWebViewContext(browser, APP_ID);
    await browser.setTimeout({ script: 30_000 });

    await browser.waitUntil(
      async () => {
        try {
          return await browser.execute(
            () => typeof window.__TAURI_INTERNALS__ !== 'undefined',
          );
        } catch {
          // A command issued mid-navigation can hit a stale execution context.
          return false;
        }
      },
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg:
          'window.__TAURI_INTERNALS__ never became available — the WebView did not load the app.',
      },
    );
  },

  afterTest: (test, _context, { passed }) => {
    if (passed) return;
    captureDiagnostics(`${test.parent} ${test.title}`);
  },
};
