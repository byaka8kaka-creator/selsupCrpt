import { DEFAULTS, validate } from './common.js';
const $ = id => document.getElementById(id);
async function command(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw Error(result?.error || 'Нет ответа расширения.');
}
function showError(e) { $('status').textContent = e.message; }
async function refresh() {
  const { logs = [], run } = await chrome.storage.local.get(['logs', 'run']);
  $('logs').textContent = logs.map(l => `${new Date(l.time).toLocaleString()} [${l.level}] ${l.message}`).join('\n') || 'Действий пока нет.';
  $('run').disabled = !!run; $('stop').disabled = !run;
  const alarm = await chrome.alarms.get('daily');
  $('next').textContent = run ? 'Сценарий выполняется.' : alarm ? `Следующий запуск: ${new Date(alarm.scheduledTime).toLocaleString()}` : 'Автоматический запуск выключен.';
}
const { settings } = await chrome.storage.local.get('settings');
const s = { ...DEFAULTS, ...settings };
for (const key of ['time', 'delay', 'timeout']) $(key).value = s[key];
$('enabled').checked = s.enabled; $('org1').value = s.organizations[0]; $('org2').value = s.organizations[1];
s.selectors.forEach((v, i) => $(`selector${i+1}`).value = v);
$('settings').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const settings = validate({ enabled: $('enabled').checked, time: $('time').value, delay: Number($('delay').value), timeout: Number($('timeout').value), organizations: [$('org1').value.trim(), $('org2').value.trim()], selectors: Array.from({ length: 5 }, (_, i) => $(`selector${i+1}`).value.trim()) });
    if (settings.selectors[4] && !settings.selectors[4].includes('{organization}')) throw Error('В селекторе шага 5 нужен шаблон {organization}.');
    for (const selector of settings.selectors) if (selector) document.querySelector(selector.replaceAll('{organization}', CSS.escape(settings.organizations[0])));
    await command('save', { settings }); $('status').textContent = 'Настройки сохранены.'; await refresh();
  } catch (e) { showError(e); }
});
for (const [id, type] of [['run', 'start'], ['stop', 'stop'], ['clear', 'clear']]) $(id).addEventListener('click', async () => {
  try { await command(type); $('status').textContent = type === 'start' ? 'Запуск с сохранёнными настройками.' : type === 'stop' ? 'Запрошена остановка.' : 'Журнал очищен.'; await refresh(); } catch (e) { showError(e); }
});
$('export').addEventListener('click', async () => {
  const { logs = [] } = await chrome.storage.local.get('logs');
  const url = window.URL.createObjectURL(new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `selsup-log-${Date.now()}.json`; a.click(); setTimeout(() => window.URL.revokeObjectURL(url), 1000);
});
chrome.storage.onChanged.addListener(() => { void refresh(); });
await refresh();
