import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS, nextRun, validate, dayKey } from '../extension/common.js';

test('ежедневное локальное расписание и проверка настроек', () => {
  const now = new Date(2026, 9, 6, 8, 0);
  assert.equal(nextRun('07:00', now), new Date(2026, 9, 7, 7, 0).getTime());
  assert.equal(nextRun('09:00', now), new Date(2026, 9, 6, 9, 0).getTime());
  assert.equal(dayKey(now), '2026-10-06');
  assert.throws(() => validate({ ...DEFAULTS, delay: 0 }));
  assert.throws(() => validate({ ...DEFAULTS, time: '25:00' }));
  assert.throws(() => validate({ ...DEFAULTS, organizations: ['A', 'A'] }));
});

import {fixture,sequence} from './fixture.js';

test('реальное расширение Chromium: настройки, 2 прохода, журнал, остановка, ошибки, alarm', { timeout: 90000 }, async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'selsup-test-'));
  const extension = path.resolve('extension');
  const context = await chromium.launchPersistentContext(profile, { executablePath: '/usr/lib/chromium/chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    await context.route('https://selsup.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const ui = await context.newPage(); await ui.goto(`chrome-extension://${id}/options.html`);
    await ui.locator('#org1').fill('Организация А'); await ui.locator('#org2').fill('Тест FBS');
    await ui.locator('#delay').fill('1'); await ui.locator('#timeout').fill('10');
    await ui.getByRole('button', { name: 'Сохранить настройки' }).click();
    await ui.waitForFunction(() => document.querySelector('#status').textContent === 'Настройки сохранены.');
    const command = (type, extra = {}) => ui.evaluate(async ({type, extra}) => chrome.runtime.sendMessage({ type, ...extra }), {type, extra});
    assert.equal((await command('start')).ok, true);
    assert.equal((await command('start')).ok, false, 'parallel execution rejected');
    await ui.waitForFunction(async () => !(await chrome.storage.local.get('run')).run, null, { timeout: 25000 });
    let site = context.pages().find(p => p.url().startsWith('https://selsup.ru/'));
    assert.deepEqual(await site.evaluate(() => clicks), sequence);
    let state = await ui.evaluate(() => chrome.storage.local.get(['logs', 'settings']));
    assert.equal(state.logs.at(-1).level, 'success');
    assert.equal(state.logs.filter(l => l.message.includes(': нажатие.')).length, 11);
    assert.equal(state.settings.delay, 1);
    // Stop after the preparation click. No further clicks may occur.
    const priorCount = state.logs.length;
    assert.equal((await command('start')).ok, true);
    await ui.waitForFunction(async count => (await chrome.storage.local.get('logs')).logs.slice(count).some(l => l.message === 'Подготовка: первая организация: нажатие.'), priorCount);
    await command('stop');
    await ui.waitForFunction(async () => !(await chrome.storage.local.get('run')).run);
    assert.equal((await ui.evaluate(() => chrome.storage.local.get('logs'))).logs.at(-1).level, 'error');
    // Disable the lower token: must time out, without clicking check/save.
    await context.unroute('https://selsup.ru/**');
    await context.route('https://selsup.ru/**', route => route.fulfill({ contentType:'text/html; charset=utf-8', body:fixture.replace('data-step="2"', 'disabled data-step="2"') }));
    assert.equal((await command('start')).ok, true);
    await ui.waitForFunction(async () => !(await chrome.storage.local.get('run')).run, null, { timeout: 20000 });
    site = context.pages().filter(p => p.url().startsWith('https://selsup.ru/')).at(-1);
    assert.deepEqual(await site.evaluate(() => clicks), ['A','1','open','feed']);
    assert.match((await ui.evaluate(() => chrome.storage.local.get('logs'))).logs.at(-1).message, /Шаг 2/);
    // Alarm handler schedules the next day and honors daily deduplication.
    await command('save', { settings: { ...DEFAULTS, enabled:true, organizations:['Организация А','Тест FBS'] } });
    await worker.evaluate(async () => {
      const date = new Date(); const key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
      await chrome.storage.local.set({ lastScheduledDay:key });
      await chrome.alarms.create('daily', { when:Date.now()+100 });
    });
    await ui.waitForFunction(async () => (await chrome.alarms.get('daily'))?.scheduledTime > Date.now() + 60000);
    assert.equal((await ui.evaluate(() => chrome.storage.local.get('run'))).run, null);
    await command('clear'); assert.deepEqual((await ui.evaluate(() => chrome.storage.local.get('logs'))).logs, []);
  } finally { await context.close(); await rm(profile, { recursive:true, force:true }); }
});
