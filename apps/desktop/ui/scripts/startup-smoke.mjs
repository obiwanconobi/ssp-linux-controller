import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.cwd());
const dist = resolve(root, 'dist/index.html');
if (!existsSync(dist)) {
  console.error('dist/index.html is missing — run `pnpm build` first.');
  process.exit(1);
}

const fixture = JSON.parse(
  readFileSync(resolve(root, '../../../fixtures/snapshots/simulator-2.4.4.json'), 'utf8'),
);
const simulatorInfo = {
  address: 'serial:/dev/ttyACM0@115200',
  transport: 'USB · CDC-ACM',
  device_name: 'StompStation PRO',
  firmware: '2.4.4',
  node_count: 132,
};

const port = process.env.STARTUP_SMOKE_PORT ?? '4178';
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

let browser;
try {
  await waitForServer();
  browser = await chromium.launch();

  const openScenario = async (mode) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    await page.addInitScript(
      ({ mode, simulatorInfo, fixture }) => {
        const calls = [];
        window.__startupCalls = calls;
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
          unregisterListener: () => undefined,
        };
        window.__TAURI_INTERNALS__ = {
          transformCallback: (callback) => {
            const id = Math.floor(Math.random() * 1_000_000);
            window[`_${id}`] = callback;
            return id;
          },
          unregisterCallback: () => undefined,
          convertFileSrc: (path) => path,
          invoke: async (command, args) => {
            calls.push({ command, args });
            if (command === 'get_bootstrap') {
              return {
                product: 'StompStation',
                version: '0.6.0',
                platform: 'linux x86_64',
                connected: false,
                demo_allowed: mode === 'demo',
                transports: ['Wi-Fi', 'USB', 'Manual TCP'],
                serial_ports: [],
              };
            }
            if (command === 'plugin:event|listen') return 1;
            if (command === 'plugin:event|unlisten') return null;
            if (command === 'list_serial_ports') return [];
            if (command === 'discover_wifi') return [];
            if (command === 'auto_connect') {
              if (mode === 'none') {
                const error = new Error(
                  'No StompStation found over Wi-Fi or USB (no USB serial ports were found). Connect manually, or launch with --demo for the simulator.',
                );
                error.code = 'no_device';
                throw error;
              }
              return simulatorInfo;
            }
            if (command === 'get_snapshot') return fixture.snapshot;
            if (command === 'select_block') return fixture.editors[args.blockPath];
            if (command === 'disconnect') return null;
            throw new Error(`unexpected command ${command}`);
          },
        };
      },
      { mode, simulatorInfo, fixture },
    );
    await page.goto(`${base}/#board`, { waitUntil: 'networkidle' });
    return { page, errors };
  };

  {
    const { page, errors } = await openScenario('none');
    await page.waitForSelector('.connection-search--failed');
    const banner = await page.locator('.connection-search--failed').innerText();
    assert(banner.includes('No pedal found automatically'), 'missing automatic-discovery error title');
    assert(banner.includes('Wi-Fi or USB'), 'missing discovery fallback detail');
    assert((await page.locator('.signal-chain .pedal').count()) === 0, 'empty startup rendered pedals');
    assert(
      (await page.locator('.connection-sheet .btn', { hasText: 'Use simulator' }).count()) === 0,
      'demo control is visible without the launch flag',
    );
    const calls = await page.evaluate(() => window.__startupCalls.map((entry) => entry.command));
    assert(calls.includes('auto_connect'), 'startup did not run automatic discovery');
    assert(errors.length === 0, `no-device startup errors:\n${errors.join('\n')}`);
    await page.close();
  }

  {
    const { page, errors } = await openScenario('demo');
    await page.waitForFunction(
      () => document.querySelectorAll('.signal-chain .pedal').length === 9,
      undefined,
      { timeout: 4_000 },
    );
    const calls = await page.evaluate(() => window.__startupCalls.map((entry) => entry.command));
    assert(!calls.includes('auto_connect'), 'demo launch still searched for hardware');
    assert(
      (await page.locator('.connection-sheet').count()) === 0,
      'demo launch opened the connection sheet',
    );
    assert(errors.length === 0, `demo startup errors:\n${errors.join('\n')}`);
    await page.close();
  }

  {
    const { page, errors } = await openScenario('usb');
    await page.waitForFunction(
      () => document.querySelectorAll('.signal-chain .pedal').length === 9,
      undefined,
      { timeout: 8_000 },
    );
    await page.waitForSelector('.connection-sheet', { state: 'detached' });
    const calls = await page.evaluate(() => window.__startupCalls.map((entry) => entry.command));
    assert(calls.includes('auto_connect'), 'USB startup did not run automatic discovery');
    assert(
      calls.filter((command) => command === 'select_block').length === 9,
      'auto-connected board did not load every block editor',
    );
    assert(
      (await page.locator('.title-bar__state').innerText()).includes('USB'),
      'auto-connected transport is not shown in the title bar',
    );
    assert(errors.length === 0, `USB startup errors:\n${errors.join('\n')}`);
    await page.close();
  }

  console.log('STARTUP SMOKE PASSED');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
