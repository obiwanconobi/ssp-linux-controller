import { browser, $, expect } from '@wdio/globals';
import {
  APP_ID,
  adb,
  ensureSimulatorConnection,
  jsClick,
  waitForWebViewContext,
} from '../helpers/android.mjs';

const SAVE_NAME = `StompStationSave-${Date.now()}.wav`;
const SAVE_PATH = `/sdcard/Download/${SAVE_NAME}`;

function savedFile() {
  return adb(['shell', 'ls', '-l', SAVE_PATH]).status === 0 ? SAVE_PATH : '';
}

describe('StompStation Android save picker', () => {
  it('downloads an IR through a content URI save target', async () => {
    await ensureSimulatorConnection(browser);
    adb(['shell', 'rm', '-f', SAVE_PATH]);

    await jsClick(browser, '#nav-tab-library');
    await $('.library-scope').waitForDisplayed({ timeout: 15_000 });
    await browser.execute(() => {
      const category = [...document.querySelectorAll('.library-scope__category')].find(
        (element) => element.textContent?.includes('IRs'),
      );
      if (!(category instanceof HTMLElement)) throw new Error('IRs category not found');
      category.click();
    });
    await $('.library-table').waitForDisplayed({ timeout: 15_000 });

    await jsClick(browser, '.library-table button[aria-label^="Download "]');

    await browser.switchAppiumContext('NATIVE_APP');
    const nameField = $('android=new UiSelector().className("android.widget.EditText")');
    await nameField.waitForDisplayed({ timeout: 20_000 });
    await nameField.setValue(SAVE_NAME);
    const saveButton = $('android=new UiSelector().resourceId("android:id/button1")');
    await saveButton.waitForDisplayed({ timeout: 10_000 });
    await saveButton.click();

    await waitForWebViewContext(browser, APP_ID);
    await browser.setTimeout({ script: 30_000 });
    await browser.waitUntil(
      async () => {
        const result = adb(['shell', 'ls', '-l', SAVE_PATH]);
        return result.status === 0 && /8248/.test(result.stdout ?? '');
      },
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: 'the downloaded IR was not written to the selected document',
      },
    );

    // The toast is short-lived; the saved document is the durable assertion.
    expect(savedFile()).not.toBe('');
  });
});
