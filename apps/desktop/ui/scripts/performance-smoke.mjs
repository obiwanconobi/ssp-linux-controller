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

const port = process.env.PERF_SMOKE_PORT ?? '4187';
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

const metrics = async (client) => {
  const { metrics: values } = await client.send('Performance.getMetrics');
  return Object.fromEntries(values.map((entry) => [entry.name, entry.value]));
};

let browser;
try {
  await waitForServer();
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send('Performance.enable');

  const started = Date.now();
  await page.goto(`${base}/#board`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.pedal');
  await page.evaluate(() => document.fonts.ready);
  const readyMs = Date.now() - started;

  const pageMetrics = await page.evaluate(() => {
    const paints = performance.getEntriesByType('paint');
    return {
      firstPaint:
        paints.find((entry) => entry.name === 'first-paint')?.startTime ?? null,
      firstContentfulPaint:
        paints.find((entry) => entry.name === 'first-contentful-paint')?.startTime ?? null,
      nodes: document.querySelectorAll('*').length,
      heap: performance.memory?.usedJSHeapSize ?? null,
    };
  });
  const loaded = await metrics(client);
  const heapAtReady = pageMetrics.heap ?? loaded.JSHeapUsedSize ?? 0;

  await page.waitForTimeout(3000);
  const idle = await metrics(client);
  const heapIdle = idle.JSHeapUsedSize ?? heapAtReady;
  const heapGrowth = Math.max(0, heapIdle - heapAtReady);

  console.log(
    `startup=${readyMs}ms fcp=${pageMetrics.firstContentfulPaint?.toFixed(0) ?? 'n/a'}ms ` +
      `nodes=${pageMetrics.nodes} heap=${(heapIdle / 1024 / 1024).toFixed(1)}MiB ` +
      `growth=${(heapGrowth / 1024 / 1024).toFixed(1)}MiB`,
  );

  assert(readyMs < 3000, `startup budget exceeded: ${readyMs}ms (limit 3000ms)`);
  assert(
    (pageMetrics.firstContentfulPaint ?? 0) < 2000,
    `first-contentful-paint budget exceeded: ${pageMetrics.firstContentfulPaint}ms (limit 2000ms)`,
  );
  assert(
    pageMetrics.nodes < 4000,
    `DOM node budget exceeded: ${pageMetrics.nodes} (limit 4000)`,
  );
  assert(
    heapIdle < 120 * 1024 * 1024,
    `idle JS heap budget exceeded: ${(heapIdle / 1024 / 1024).toFixed(1)}MiB (limit 120MiB)`,
  );
  assert(
    heapGrowth < 16 * 1024 * 1024,
    `idle heap growth budget exceeded: ${(heapGrowth / 1024 / 1024).toFixed(1)}MiB (limit 16MiB)`,
  );

  console.log('PERFORMANCE SMOKE PASSED');
} finally {
  await browser?.close();
  server.kill();
}
