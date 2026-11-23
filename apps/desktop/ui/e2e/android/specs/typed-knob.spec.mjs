import { browser, $, expect } from '@wdio/globals';
import {
  ensureSimulatorConnection,
  jsClick,
  openFirstBlockEditor,
} from '../helpers/android.mjs';

describe('StompStation Android typed controls', () => {
  it('commits a typed knob value through the real Tauri IPC path', async () => {
    await ensureSimulatorConnection(browser);

    await openFirstBlockEditor(browser);

    const dial = $('.inspector .knob__dial[aria-label^="Threshold"]');
    await dial.waitForDisplayed({ timeout: 15_000 });
    const readout = $('.inspector .knob__readout[title^="Threshold:"]');
    await readout.waitForDisplayed({ timeout: 10_000 });

    await jsClick(browser, '.inspector .knob__readout[title^="Threshold:"]');
    await browser.pause(200);
    const focused = await browser.execute(() => {
      const input = document.querySelector('.inspector .knob__readout-input');
      if (!(input instanceof HTMLInputElement)) return false;
      input.focus();
      input.select();
      return document.activeElement === input;
    });
    expect(focused).toBe(true);

    // Appium sends real key events, so React's onChange fires. CDP fill alone
    // can update the DOM without committing the controlled input.
    await browser.keys(['-', '3', '4']);
    await browser.keys('Enter');

    await browser.waitUntil(
      async () =>
        Math.abs(Number(await dial.getAttribute('aria-valuenow')) - -34) < 0.001,
      {
        timeout: 10_000,
        timeoutMsg: 'typed value was not committed to the knob',
      },
    );

    const text = (await readout.getText()).trim();
    expect(text).toContain('-34');
    expect((await dial.getAttribute('aria-valuetext')).trim()).toBe(text);

    await browser.waitUntil(
      async () =>
        (await $('.status-bar__save').getText()).toUpperCase().includes('EDITED'),
      {
        timeout: 10_000,
        timeoutMsg: 'typed edit did not mark the preset edited',
      },
    );
  });
});
