import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { browser, $, $$, expect } from '@wdio/globals';
import {
  BOARD_BLOCK,
  REPO_ROOT,
  ensureSimulatorConnection,
  jsClick,
  openFirstBlockEditor,
} from '../helpers/android.mjs';

const LOG_DIR = process.env.E2E_LOG_DIR ?? resolve(REPO_ROOT, 'dist/android/e2e/logs');

describe('StompStation Android smoke', () => {
  it('connects to the simulator and saves a real parameter edit', async () => {
    await ensureSimulatorConnection(browser);

    expect(await $$(BOARD_BLOCK)).toBeElementsArrayOfSize(9);
    expect(await $('#nav-tab-amp').isExisting()).toBe(false);
    await $('.mobile-chain').waitForDisplayed({ timeout: 10_000 });

    await openFirstBlockEditor(browser);

    const dial = $('.inspector .knob__dial[aria-label^="Threshold"]');
    await dial.waitForDisplayed({ timeout: 15_000 });
    const before = Number(await dial.getAttribute('aria-valuenow'));
    const min = Number(await dial.getAttribute('aria-valuemin'));
    const max = Number(await dial.getAttribute('aria-valuemax'));
    // Toggle between the ends so this is deterministic across simulator state.
    const target = before === max ? min : max;
    const key = before === max ? 'Home' : 'End';

    // Drive the slider through its keyboard accessibility contract. The WebView
    // text-input path is covered separately by a real Appium key sequence.
    await browser.execute(
      (selector) => document.querySelector(selector)?.focus(),
      '.inspector .knob__dial[aria-label^="Threshold"]',
    );
    await browser.keys(key);

    await browser.waitUntil(
      async () =>
        Math.abs(Number(await dial.getAttribute('aria-valuenow')) - target) < 0.001,
      { timeout: 10_000, timeoutMsg: 'slider keyboard commit did not change the value' },
    );

    const readout = $('.inspector .knob__readout[title^="Threshold:"]');
    await readout.waitForDisplayed({ timeout: 10_000 });
    expect((await readout.getText()).trim()).toBe(
      (await dial.getAttribute('aria-valuetext')).trim(),
    );

    await browser.waitUntil(
      async () =>
        (await $('.status-bar__save').getText()).toUpperCase().includes('EDITED'),
      { timeout: 10_000, timeoutMsg: 'the parameter edit did not mark the preset as edited' },
    );

    const save = $('.title-bar__save');
    expect(await save.isEnabled()).toBe(true);
    await jsClick(browser, '.title-bar__save');

    await browser.waitUntil(
      async () =>
        (await $('.status-bar__save').getText()).toUpperCase().includes('SAVED'),
      { timeout: 30_000, timeoutMsg: 'the preset did not return to the saved state' },
    );

    mkdirSync(LOG_DIR, { recursive: true });
    await browser.saveScreenshot(resolve(LOG_DIR, 'appium-smoke.png'));
    console.log(`[android] smoke screenshot: ${resolve(LOG_DIR, 'appium-smoke.png')}`);
  });
});
