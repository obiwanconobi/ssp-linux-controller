import { resolve } from 'node:path';
import { browser, $, $$, expect } from '@wdio/globals';
import { BOARD_BLOCK, REPO_ROOT, ensureSimulatorConnection } from '../helpers/android.mjs';

describe('StompStation Android rotation', () => {
  after(async () => {
    await browser.setOrientation('PORTRAIT').catch(() => undefined);
  });

  it('keeps the board, inspector, and master controls usable in landscape', async () => {
    await ensureSimulatorConnection(browser);
    expect(await $$(BOARD_BLOCK)).toBeElementsArrayOfSize(9);
    await $('.mobile-chain').waitForDisplayed({ timeout: 10_000 });
    expect(await $('#nav-tab-amp').isExisting()).toBe(false);

    await browser.setOrientation('LANDSCAPE');
    await browser.pause(700);

    await $('.board-view').waitForDisplayed({ timeout: 15_000 });
    await $('.chain-hero').waitForDisplayed({ timeout: 10_000 });
    await $('.inspector').waitForDisplayed({ timeout: 10_000 });
    await $('.master-strip').waitForDisplayed({ timeout: 10_000 });
    expect(await $$('.signal-chain .pedal')).toBeElementsArrayOfSize(9);

    // The chain itself scrolls horizontally when needed; the page must not.
    const overflow = await browser.execute(() => ({
      width: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      height: window.innerHeight,
    }));
    expect(overflow.height).toBeGreaterThan(300);
    expect(overflow.pageWidth).toBeLessThanOrEqual(overflow.width + 2);

    const logDir =
      process.env.E2E_LOG_DIR ?? resolve(REPO_ROOT, 'dist/android/e2e/logs');
    await browser.saveScreenshot(resolve(logDir, 'appium-landscape.png'));

    // In a short landscape window the board scrolls; the inspector must be
    // reachable rather than clipped behind the master strip.
    const inspectorVisible = await browser.execute(() => {
      const main = document.querySelector('.app-main');
      const inspector = document.querySelector('.inspector');
      if (!(main instanceof HTMLElement) || !(inspector instanceof HTMLElement)) {
        return false;
      }
      main.scrollTo({ top: main.scrollHeight, behavior: 'instant' });
      const rect = inspector.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    });
    expect(inspectorVisible).toBe(true);

    await browser.setOrientation('PORTRAIT');
    await browser.pause(700);
    await $('.mobile-chain').waitForDisplayed({ timeout: 15_000 });
    expect(await $$('.mobile-block-card')).toBeElementsArrayOfSize(9);
    expect(await $('#nav-tab-amp').isExisting()).toBe(false);
  });
});
