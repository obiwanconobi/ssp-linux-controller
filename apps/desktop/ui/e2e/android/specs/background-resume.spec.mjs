import { browser, $, $$, expect } from '@wdio/globals';
import {
  APP_ID,
  BOARD_BLOCK,
  ensureSimulatorConnection,
  waitForWebViewContext,
} from '../helpers/android.mjs';

describe('StompStation Android background/resume', () => {
  it('reconnects to the simulator session after the app is backgrounded', async () => {
    await ensureSimulatorConnection(browser);
    expect(await $$(BOARD_BLOCK)).toBeElementsArrayOfSize(9);

    await browser.background(3);
    await browser.pause(1_000);
    await waitForWebViewContext(browser, APP_ID);
    await browser.setTimeout({ script: 30_000 });

    await $(BOARD_BLOCK).waitForDisplayed({ timeout: 60_000 });
    await browser.waitUntil(
      async () =>
        (await $('.connection-pill').getAttribute('class'))?.includes(
          'connection-pill--on',
        ),
      {
        timeout: 60_000,
        timeoutMsg: 'the device session did not reconnect after resume',
      },
    );
    expect(await $$(BOARD_BLOCK)).toBeElementsArrayOfSize(9);
    expect((await $('.status-bar .status-bar__left').getText()).toLowerCase()).toContain(
      'synced',
    );
  });
});
