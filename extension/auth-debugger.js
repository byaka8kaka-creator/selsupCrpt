// Only these two login actions are exposed; no arbitrary CDP command or
// coordinate is accepted from a content script.
export async function clickAuthTarget({ api, tabId, token, action, assertActive, detachWarning }) {
  if (!['heading', 'login'].includes(action) || !/^[a-f0-9-]{36}$/.test(token)) throw Error('Недопустимая цель клика авторизации.');
  const target = { tabId };
  let attached = false;
  try {
    await assertActive();
    await api.tabs.update(tabId, { active: true });
    await assertActive();
    try { await api.debugger.attach(target, '1.3'); attached = true; }
    catch { throw Error('Не удалось подключить chrome.debugger. Разрешите «debugger» для расширения и закройте DevTools/другой отладчик этой вкладки.'); }
    const locate = async () => {
      await assertActive();
      const results = await api.scripting.executeScript({ target: { tabId }, func: locateAuthTarget, args: [{ token, action }] });
      const point = results[0]?.result;
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0) throw Error('Не удалось определить место клика авторизации.');
      return point;
    };
    const point = await locate();
    await assertActive();
    await api.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none' });
    const current = await locate();
    if (Math.abs(point.x - current.x) > 1 || Math.abs(point.y - current.y) > 1) throw Error('Элемент входа переместился перед кликом. Повторите запуск после проверки страницы.');
    await assertActive();
    await api.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    // Always release a pressed button, including cancellation between down/up.
    // The run is checked again before release; cancelling releases away from
    // the control so that the release cannot submit the form.
    try { await assertActive(); }
    catch (e) {
      await api.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: -1, y: -1, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
      throw e;
    }
    await api.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
  } finally {
    if (attached) {
      try { await api.debugger.detach(target); }
      catch { if (detachWarning) await detachWarning(); }
    }
  }
}

// Runs in the selected tab. Only coordinates leave the page; field values do not.
async function locateAuthTarget({ token, action }) {
  if (location.origin !== 'https://selsup.ru') throw Error('Клик вне SelSup запрещён.');
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const text = el => (el.tagName === 'INPUT' ? el.value : el.textContent || '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('ru');
  const nodes = [...document.querySelectorAll('[data-selsup-auth-click]')].filter(el => el.getAttribute('data-selsup-auth-click') === token);
  const el = nodes.length === 1 ? nodes[0] : null;
  if (!el || !visible(el)) throw Error('Цель авторизации исчезла.');
  if (![...document.querySelectorAll('input[type="password"]')].some(visible)) throw Error('Страница входа не найдена.');
  if (action === 'heading') {
    if (text(el) !== 'АВТОРИЗАЦИЯ' || el.closest('a, button, [role="button"], [role="link"], [contenteditable="true"]')) throw Error('Цель не является текстом «Авторизация».');
  } else if (!el.matches('button, [role="button"], input[type="submit"]') || text(el) !== 'ВОЙТИ'
    || el.matches(':disabled') || el.closest('[aria-disabled="true"], fieldset:disabled')) throw Error('Кнопка «Войти» недоступна.');
  el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  // A minimized window may suspend animation frames. Geometry checks must
  // still finish so cancellation/timeouts can detach the debugger.
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
  if (!el.isConnected || !visible(el)) throw Error('Цель изменилась перед кликом.');
  const rect = el.getBoundingClientRect();
  const x = Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) / 2;
  const y = Math.max(0, rect.top) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) / 2;
  const hit = document.elementFromPoint(x, y);
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !hit || (hit !== el && !el.contains(hit))) throw Error('Цель авторизации перекрыта другим элементом.');
  return { x, y };
}
