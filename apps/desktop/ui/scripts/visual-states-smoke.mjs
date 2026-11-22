import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';

const root = resolve(process.cwd());
const entry = resolve(root, 'index.html');
if (!existsSync(entry)) {
  console.error('index.html is missing.');
  process.exit(1);
}

const port = process.env.STATE_SMOKE_PORT ?? '4184';
const base = `http://127.0.0.1:${port}`;
const vite = resolve(root, 'node_modules/vite/bin/vite.js');
const server = spawn(
  process.execPath,
  [vite, '--port', port, '--strictPort', '--host', '127.0.0.1'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
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
  throw new Error(`dev server did not start\n${serverLog}`);
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

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

const themes = ['studio', 'cream', 'british'];

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

  const scan = async (label) => {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    if (results.violations.length > 0) {
      throw new Error(
        `${label}: ${results.violations.length} accessibility violation(s)\n${JSON.stringify(
          summarize(results.violations),
          null,
          2,
        )}`,
      );
    }
  };

  const tokenColors = async (...names) =>
    page.evaluate((tokens) => {
      const probe = document.createElement('span');
      document.body.appendChild(probe);
      const output = {};
      for (const token of tokens) {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
        probe.style.color = raw;
        output[token] = getComputedStyle(probe).color;
      }
      probe.remove();
      return output;
    }, names);

  for (const theme of themes) {
    await page.goto(`${base}/#board`, { waitUntil: 'networkidle' });
    await page.evaluate((value) => localStorage.setItem('stomp.theme', value), theme);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.pedal');
    await page.waitForFunction(() => Boolean(window.__stompTest));

    // Focus state: keyboard focus must draw the accent ring.
    await page.keyboard.press('Tab');
    const dial = page.locator('.knob__dial').first();
    await dial.focus();
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      const probe = document.createElement('span');
      probe.style.color = raw;
      document.body.appendChild(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return {
        visible: element.matches(':focus-visible'),
        shadow: getComputedStyle(element).boxShadow,
        accent,
      };
    });
    assert(focus?.visible, `${theme}/focus: knob did not match :focus-visible`);
    assert(
      focus.shadow.includes(focus.accent),
      `${theme}/focus: focus ring does not use the theme accent (${focus.shadow})`,
    );

    // Pending state: the arc turns amber and remains legible.
    await page.evaluate(() => {
      const store = window.__stompTest.store;
      const pending = store
        .getState()
        .blocks.flatMap((block) => [block, block.secondLane].filter(Boolean))
        .flatMap((block) => block.controls.map((control) => control.id));
      store.setState({ pending });
    });
    await page.waitForSelector('.knob--pending');
    await page.waitForTimeout(180);
    const pendingStroke = await page
      .locator('.knob--pending .knob__arc')
      .first()
      .evaluate((element) => getComputedStyle(element).stroke);
    const { '--amber': amber } = await tokenColors('--amber');
    assert(
      pendingStroke === amber,
      `${theme}/pending: arc stroke ${pendingStroke} is not the amber token ${amber}`,
    );
    await scan(`${theme}/pending`);
    await page.evaluate(() => window.__stompTest.store.setState({ pending: [] }));

    // Conflict state: the bar and conflicted control keep the warning treatment.
    await page.evaluate(() => {
      const store = window.__stompTest.store;
      const state = store.getState();
      const drive = state.blocks.find((block) => block.id === 'drive');
      const gain = drive?.controls.find((control) => control.name === 'gain');
      if (!drive || !gain) throw new Error('demo drive gain control is missing');
      store.setState({
        conflicts: [
          {
            id: gain.id,
            kind: 'control',
            label: gain.label,
            localValue: gain.value,
            deviceValue: Number(gain.value) + 1,
            blockId: drive.id,
            controlId: gain.id,
          },
        ],
        blocks: state.blocks.map((block) =>
          block.id === drive.id
            ? {
                ...block,
                controls: block.controls.map((control) =>
                  control.id === gain.id ? { ...control, conflict: true } : control,
                ),
              }
            : block,
        ),
      });
    });
    await page.waitForSelector('.device-conflict-bar');
    await page.waitForSelector('.knob--conflict');
    const conflictShadow = await page
      .locator('.knob--conflict .knob__dial')
      .first()
      .evaluate((element) => getComputedStyle(element).boxShadow);
    const { '--amber': amberForConflict } = await tokenColors('--amber');
    const amberParts = amberForConflict.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
    const shadowSrgb = conflictShadow.match(/color\(srgb\s+([^/]+)\//)?.[1]
      .trim()
      .split(/\s+/)
      .map(Number);
    const shadowUsesAmber =
      shadowSrgb?.length === 3
        ? amberParts.every(
            (part, index) => Math.abs(shadowSrgb[index] - part / 255) < 0.002,
          )
        : conflictShadow.includes(amberForConflict.replace('rgb(', 'rgba('));
    assert(
      shadowUsesAmber,
      `${theme}/conflict: conflict ring does not use amber (${conflictShadow})`,
    );
    await scan(`${theme}/conflict`);
    await page.evaluate(() =>
      window.__stompTest.store.setState({ conflicts: [], pending: [] }),
    );

    // Error state: a failed write uses the danger tone and remains legible.
    await page.evaluate(() =>
      window.__stompTest.store.getState().notify('Device write failed', 'bad'),
    );
    await page.waitForSelector('.toast--bad');
    const { '--danger': danger } = await tokenColors('--danger');
    const toastIcon = await page
      .locator('.toast--bad svg')
      .first()
      .evaluate((element) => getComputedStyle(element).color);
    assert(
      toastIcon === danger,
      `${theme}/error: toast icon ${toastIcon} is not the danger token ${danger}`,
    );
    await scan(`${theme}/error`);
    await page.locator('.toast__close').click();

    console.log(`PASS ${theme} focused/pending/conflict/error`);
  }

  assert(errors.length === 0, `page errors:\n${errors.join('\n')}`);
  console.log('VISUAL STATES SMOKE PASSED');
} finally {
  await browser?.close();
  server.kill();
}
