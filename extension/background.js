import { DEFAULTS, URL, validate, nextRun, dayKey } from './common.js';
const DAILY = 'daily', WATCH = 'watchdog';
let gate = Promise.resolve();
function exclusive(fn) { const task = gate.then(fn); gate = task.catch(() => {}); return task; }
async function log(level, message) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.push({ time: new Date().toISOString(), level, message });
  await chrome.storage.local.set({ logs: logs.slice(-1000) });
}
async function settings() { const { settings } = await chrome.storage.local.get('settings'); return validate({ ...DEFAULTS, ...settings }); }
async function schedule() {
  const s = await settings(); await chrome.alarms.clear(DAILY);
  if (s.enabled) await chrome.alarms.create(DAILY, { when: nextRun(s.time) });
}
async function finish(id, error) {
  const { run } = await chrome.storage.local.get('run');
  if (run?.id !== id) return;
  await log(error ? 'error' : 'success', error || 'Завершено: оба прохода выполнены, верхние токены и категория подтверждены, отправлены клики сохранения.');
  await chrome.storage.local.set({ run: null }); await chrome.alarms.clear(WATCH);
}
async function execute(run, s) {
  try {
    let tab;
    if (run.tabId != null) tab = await chrome.tabs.get(run.tabId);
    else tab = await chrome.tabs.create({ url: URL, active: true });
    await exclusive(async () => {
      const state = await chrome.storage.local.get('run');
      if (state.run?.id !== run.id) throw Error('Запуск отменён.');
      run.tabId = tab.id; await chrome.storage.local.set({ run });
    });
    // Wait for this navigation, including redirects; never inject into another origin.
    const end = Date.now() + s.timeout * 1000;
    while (true) {
      tab = await chrome.tabs.get(tab.id);
      if (tab.status === 'complete') break;
      if (Date.now() > end) throw Error('Страница не загрузилась вовремя.');
      await new Promise(r => setTimeout(r, 250));
    }
    if (!tab.url || !/^https:\/\/selsup\.ru(?:\/|$)/.test(tab.url)) throw Error('Открыта страница за пределами SelSup. Запуск остановлен.');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['token.js', 'content.js'] });
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'execute', id: run.id, settings: s });
    if (!result?.ok || !result.started) throw Error(result?.error || 'Сценарий не запущен на странице.');
  } catch (e) { await exclusive(() => finish(run.id, `Запуск остановлен: ${e.message}`)); }
}
async function start(source) {
  const s = await settings();
  const { run: current, lastScheduledDay } = await chrome.storage.local.get(['run', 'lastScheduledDay']);
  if (current) throw Error('Сценарий уже выполняется.');
  if (source === 'schedule' && (!s.enabled || lastScheduledDay === dayKey())) return;
  const run = { id: crypto.randomUUID(), heartbeat: Date.now(), tabId: null, settings: s, resume: null, auth: null };
  await chrome.storage.local.set({ run, ...(source === 'schedule' ? { lastScheduledDay: dayKey() } : {}) });
  await chrome.alarms.create(WATCH, { periodInMinutes: 1 });
  await log('info', `Запуск: ${source === 'schedule' ? 'по расписанию' : 'вручную'}.`);
  void execute(run, s);
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  exclusive(async () => {
    if (sender.tab) {
      const { run } = await chrome.storage.local.get('run');
      if (!run || sender.tab.id !== run.tabId) return { ok: false };
      if (message.type === 'resume') {
        if ((!run.resume && !run.auth) || !run.settings) return { ok: false };
        run.heartbeat = Date.now(); await chrome.storage.local.set({ run });
        await log('info', run.auth ? 'Страница загружена: продолжается авторизация.' : 'Страница перезагружена: продолжается проверка верхнего токена.');
        return { ok: true, id: run.id, settings: run.settings, resume: run.resume, auth: run.auth || null };
      }
      if (message.id !== run.id) return { ok: false };
      if (message.type === 'authCheckpoint') {
        if (message.auth !== null && (!Number.isFinite(message.auth?.deadline) || typeof message.auth.attempted !== 'boolean' || typeof message.auth.returning !== 'boolean')) return { ok: false };
        run.auth = message.auth; run.heartbeat = Date.now();
        await chrome.storage.local.set({ run }); return { ok: true };
      }
      if (message.type === 'checkpoint') {
        if (message.resume !== null && (!Number.isInteger(message.resume?.pass) || message.resume.pass < 0 || message.resume.pass > 1 || !Number.isFinite(message.resume.deadline) || !Number.isFinite(message.resume.waitUntil))) return { ok: false };
        run.resume = message.resume; run.heartbeat = Date.now();
        await chrome.storage.local.set({ run }); return { ok: true };
      }
      if (message.type === 'finished') {
        await finish(run.id, message.result?.ok ? null : (message.result?.error || 'Сценарий завершился без результата.'));
        return { ok: true };
      }
      if (message.type === 'progress' || message.type === 'heartbeat') {
        run.heartbeat = Date.now(); await chrome.storage.local.set({ run });
        if (message.type === 'progress') await log('info', String(message.message).slice(0, 300));
        return { ok: true };
      }
      return { ok: false };
    }
    if (sender.id !== chrome.runtime.id) throw Error('Недопустимый отправитель.');
    if (message.type === 'save') { await chrome.storage.local.set({ settings: validate(message.settings) }); await schedule(); }
    else if (message.type === 'start') await start('manual');
    else if (message.type === 'stop') {
      const { run } = await chrome.storage.local.get('run');
      if (run) {
        if (run.tabId != null) await chrome.tabs.sendMessage(run.tabId, { type: 'stop', id: run.id }).catch(() => {});
        await finish(run.id, 'Остановлено пользователем. Уже выполненные действия не отменены.');
      }
    } else if (message.type === 'clear') await chrome.storage.local.set({ logs: [] });
    else throw Error('Неизвестная команда.');
    return { ok: true };
  }).then(respond, e => respond({ ok: false, error: e.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  void exclusive(async () => {
    if (alarm.name === DAILY) { await schedule(); await start('schedule'); }
    if (alarm.name === WATCH) {
      const { run } = await chrome.storage.local.get('run');
      if (run && Date.now() - run.heartbeat > 90000) {
        if (run.tabId != null) await chrome.tabs.sendMessage(run.tabId, { type: 'stop', id: run.id }).catch(() => {});
        await finish(run.id, 'Связь со страницей потеряна. Проверьте журнал перед ручным повтором.');
      }
    }
  }).catch(e => exclusive(() => log('error', e.message)));
});
async function initialize() {
  const { run } = await chrome.storage.local.get('run');
  if (run) await finish(run.id, 'Предыдущий запуск прерван перезапуском браузера. Автоматический повтор не выполняется.');
  await schedule();
}
chrome.runtime.onInstalled.addListener(() => { void exclusive(initialize); });
chrome.runtime.onStartup.addListener(() => { void exclusive(initialize); });
