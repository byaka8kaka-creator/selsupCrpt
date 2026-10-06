(() => {
  if (globalThis.__selsupCRPT) return;
  globalThis.__selsupCRPT = true;
  let active = null;
  const normalize = text => text.replace(/\s+/g, ' ').trim().toLocaleUpperCase('ru');
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const enabled = el => !el.matches(':disabled') && !el.closest('button:disabled, [aria-disabled="true"], fieldset:disabled');
  function candidates(text, organization = false) {
    const selector = organization ? 'button, a, [role="tab"], [role="button"], li, div, span' : 'button, a, [role="button"], input[type="button"], input[type="submit"]';
    let found = [...document.querySelectorAll(selector)].filter(el => visible(el) && normalize(el.value || el.textContent || '') === normalize(text));
    return found.filter(el => !found.some(other => other !== el && el.contains(other)));
  }
  function check(run) { if (run.cancelled || active !== run) throw Error('Сценарий остановлен.'); }
  async function report(run, message) {
    check(run);
    const response = await chrome.runtime.sendMessage({ type: 'progress', id: run.id, message });
    if (!response?.ok) { run.cancelled = true; check(run); }
  }
  async function pause(run, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { check(run); await new Promise(r => setTimeout(r, Math.min(200, end - Date.now()))); }
    check(run);
  }
  async function target(run, step, organization) {
    const end = Date.now() + run.settings.timeout * 1000;
    while (Date.now() < end) {
      check(run);
      let found;
      const custom = run.settings.selectors[step - 1];
      if (custom) {
        try { found = [...document.querySelectorAll(custom.replaceAll('{organization}', CSS.escape(organization || '')))].filter(visible); }
        catch { throw Error(`Шаг ${step}: некорректный CSS-селектор.`); }
      } else if (step === 1 || step === 2) {
        found = candidates('ПОЛУЧИТЬ ТОКЕН');
        if (found.length > 2) throw Error(`Шаг ${step}: найдено больше двух кнопок токена. Задайте CSS-селектор.`);
        found = found.length === 2 ? [found[step - 1]] : [];
      } else found = candidates(step === 3 ? 'ПРОВЕРИТЬ СУЗ' : step === 4 ? 'СОХРАНИТЬ' : organization, step === 5);
      if (found.length > 1) throw Error(`Шаг ${step}: несколько подходящих элементов. Задайте CSS-селектор.`);
      if (found.length === 1 && enabled(found[0])) return found[0];
      await pause(run, 250);
    }
    throw Error(`Шаг ${step}: элемент не найден или недоступен. Проверьте вход, страницу и настройки.`);
  }
  async function click(run, step, organization, label) {
    const el = await target(run, step, organization);
    await report(run, `${label}: нажатие.`);
    check(run);
    if (!el.isConnected || !visible(el) || !enabled(el)) throw Error(`Шаг ${step}: элемент изменился перед нажатием. Повторите после проверки страницы.`);
    el.scrollIntoView({ block: 'center' }); el.click();
    await pause(run, run.settings.delay * 1000);
    await report(run, `${label}: пауза завершена.`);
  }
  async function execute(run) {
    const heartbeat = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'heartbeat', id: run.id }).then(r => { if (!r?.ok) run.cancelled = true; }).catch(() => { run.cancelled = true; });
    }, 20000);
    try {
      await report(run, 'Страница открыта. Выбор первой организации.');
      await click(run, 5, run.settings.organizations[0], 'Подготовка: первая организация');
      for (let pass = 0; pass < 2; pass++) {
        for (let step = 1; step <= 5; step++) {
          const names = ['верхний токен', 'нижний токен', 'проверка СУЗ', 'сохранение', 'переключение организации'];
          await click(run, step, run.settings.organizations[pass === 0 ? 1 : 0], `Проход ${pass+1}, шаг ${step} (${names[step-1]})`);
        }
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
    finally { clearInterval(heartbeat); if (active === run) active = null; }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'stop') {
      if (active?.id === message.id) active.cancelled = true;
      respond({ ok: true }); return;
    }
    if (message.type === 'execute') {
      if (active) { respond({ ok: false, error: 'На странице уже выполняется сценарий.' }); return; }
      if (location.origin !== 'https://selsup.ru' || location.pathname !== '/application/integration/crpt') {
        respond({ ok: false, error: 'Неверная страница SelSup.' }); return;
      }
      active = { id: message.id, settings: message.settings, cancelled: false };
      const run = active;
      respond({ ok: true, started: true });
      void execute(run).then(result => chrome.runtime.sendMessage({ type: 'finished', id: run.id, result })).catch(() => {});
      return;
    }
  });
})();
