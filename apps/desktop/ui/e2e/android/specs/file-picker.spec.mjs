import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browser, $, expect } from '@wdio/globals';
import {
  APP_ID,
  ensureSimulatorConnection,
  jsClick,
  pushFixture,
  waitForWebViewContext,
} from '../helpers/android.mjs';

const FILE_NAME = 'StompStationPicker.wav';

function makeWav() {
  const dir = mkdtempSync(join(tmpdir(), 'stomp-android-picker-'));
  const path = join(dir, FILE_NAME);
  const frames = 2048;
  const dataLen = frames * 2;
  const wav = Buffer.alloc(44 + dataLen);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataLen, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(96_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataLen, 40);
  writeFileSync(path, wav);
  return path;
}

async function chooseDownloadedFile(name) {
  await browser.switchAppiumContext('NATIVE_APP');
  await browser.pause(800);

  const stem = name.replace(/\.[^.]+$/, '');
  const file = $(`android=new UiSelector().textContains("${stem}")`);
  const downloads = $('android=new UiSelector().text("Downloads")');

  // DocumentsUI starts on Recent. Open the roots drawer and select Downloads;
  // retry because the drawer/fragment transition can swallow the first tap.
  for (let attempt = 0; attempt < 4 && !(await file.isExisting()); attempt += 1) {
    if (!(await downloads.isExisting())) {
      const roots = $('android=new UiSelector().descriptionContains("Show roots")');
      if (await roots.isExisting()) {
        await roots.click().catch(() => undefined);
        await browser.pause(700);
      }
    }
    if (await downloads.isExisting()) {
      await downloads.click().catch(() => undefined);
      await browser.pause(700);
    }
  }

  await file.waitForDisplayed({ timeout: 30_000 });
  await file.click();

  await waitForWebViewContext(browser, APP_ID);
  await browser.setTimeout({ script: 30_000 });
}

describe('StompStation Android native file picker', () => {
  it('copies a picked content URI into app storage and preflights it', async () => {
    await ensureSimulatorConnection(browser);

    const local = makeWav();
    pushFixture(local, FILE_NAME);

    await jsClick(browser, '#nav-tab-library');
    await $('.library-scope').waitForDisplayed({ timeout: 15_000 });
    await browser.execute(() => {
      const category = [...document.querySelectorAll('.library-scope__category')].find(
        (element) => element.textContent?.includes('IRs'),
      );
      if (!(category instanceof HTMLElement)) throw new Error('IRs category not found');
      category.click();
    });

    await jsClick(browser, '.drop-zone .btn');
    await chooseDownloadedFile(FILE_NAME);

    const preflight = $('.preflight');
    await preflight.waitForDisplayed({ timeout: 30_000 });
    const text = await preflight.getText();
    expect(text).toContain('StompStationPicker');
    expect(text.toLowerCase()).toContain('wav');
    expect(text).not.toContain('Could not copy the selected file');

    // Complete the upload through the normal ACK path. The simulator is the
    // target, not hardware; this proves the cache path is readable by Rust.
    await jsClick(browser, '.preflight__actions .btn--primary');
    await $('.upload-card').waitForDisplayed({ timeout: 30_000 });
    await browser.waitUntil(
      async () => (await $('.upload-card').getText()).toUpperCase().includes('COMPLETE'),
      {
        timeout: 60_000,
        timeoutMsg: 'the picked IR did not upload through the ACK path',
      },
    );
    expect(await $('.upload-card').getText()).toContain('StompStationPicker.wav');
  });
});
