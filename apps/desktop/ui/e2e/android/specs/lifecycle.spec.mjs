import { browser, $, $$, expect } from '@wdio/globals';
import {
  APP_ID,
  ensureSimulatorConnection,
  jsClick,
  openFirstBlockEditor,
  waitForScanToSettle,
  waitForWebViewContext,
} from '../helpers/android.mjs';

describe('StompStation Android native shell', () => {
  it('closes the connection sheet with the Android Back button', async () => {
    // Make sure the React back handler is installed before sending the native
    // key event; Wry can load the page before the effect has run.
    await browser.waitUntil(
      async () =>
        await browser.execute(() => typeof window.__stompHandleBack === 'function'),
      { timeout: 15_000, timeoutMsg: 'the Android back handler was never installed' },
    );

    // Make sure the sheet is open before the native key event, and let the
    // launch scan finish so a late completion cannot race the close.
    const sheet = $('.connection-sheet');
    if (!(await sheet.isDisplayed())) {
      await jsClick(browser, '.connection-pill');
      await sheet.waitForDisplayed({ timeout: 15_000 });
    }
    await waitForScanToSettle(browser);

    await browser.switchAppiumContext('NATIVE_APP');
    await browser.pressKeyCode(4); // KEYCODE_BACK
    await browser.pause(750);

    await waitForWebViewContext(browser, APP_ID);
    await browser.waitUntil(
      async () => !(await $('.connection-sheet').isDisplayed()),
      {
        timeout: 10_000,
        timeoutMsg: 'Android Back did not close the connection sheet',
      },
    );

    // The app must stay alive; this test starts offline, so assert the command
    // pill rather than a pedal shell (there are no pedals until it connects).
    expect(await $('.connection-pill').isDisplayed()).toBe(true);
  });

  it('returns from the block editor to the chain with Android Back', async () => {
    await ensureSimulatorConnection(browser);
    await openFirstBlockEditor(browser);
    await $('.inspector--mobile').waitForDisplayed({ timeout: 15_000 });

    await browser.switchAppiumContext('NATIVE_APP');
    await browser.pressKeyCode(4); // KEYCODE_BACK
    await browser.pause(750);

    await waitForWebViewContext(browser, APP_ID);
    await $('.mobile-chain').waitForDisplayed({ timeout: 10_000 });
    expect(await $('.inspector--mobile').isExisting()).toBe(false);
    expect(await $$('.mobile-block-card')).toBeElementsArrayOfSize(9);
  });
});
