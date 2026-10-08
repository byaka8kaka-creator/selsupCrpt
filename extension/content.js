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
  const stepOn = (run, step) => run.settings.stepEnabled?.[step - 1] !== false;
  function tokenButtonsForStep(run, step) {
    const found = candidates('ПОЛУЧИТЬ ТОКЕН');
    if (found.length > 2) throw Error(`Шаг ${step}: найдено больше двух кнопок токена. Задайте CSS-селектор.`);
    if (found.length === 2) return [found[step - 1]];
    if (step === 2 && !stepOn(run, 1) && found.length === 1) return found;
    return [];
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
        found = tokenButtonsForStep(run, step);
      } else found = candidates(step === 3 ? 'ПРОВЕРИТЬ СУЗ' : step === 4 ? 'СОХРАНИТЬ' : organization, step === 5);
      if (found.length > 1) throw Error(`Шаг ${step}: несколько подходящих элементов. Задайте CSS-селектор.`);
      if (found.length === 1 && enabled(found[0])) return found[0];
      await pause(run, 250);
    }
    throw Error(`Шаг ${step}: элемент не найден или недоступен. Проверьте вход, страницу и настройки.`);
  }
  async function click(run, step, organization, label, beforeClick) {
    const el = await target(run, step, organization);
    await report(run, `${label}: нажатие.`);
    check(run);
    if (!el.isConnected || !visible(el) || !enabled(el)) throw Error(`Шаг ${step}: элемент изменился перед нажатием. Повторите после проверки страницы.`);
    if (beforeClick) await beforeClick();
    check(run);
    el.scrollIntoView({ block: 'center' }); el.click();
    await pause(run, run.settings.delay * 1000);
    await report(run, `${label}: пауза завершена.`);
  }
  async function checkpoint(run, resume) {
    check(run);
    const response = await chrome.runtime.sendMessage({ type: 'checkpoint', id: run.id, resume });
    if (!response?.ok) throw Error('Не удалось сохранить состояние перед обновлением страницы.');
    run.resume = resume;
  }
  function tokenStatuses(run) {
    let nodes;
    try { nodes = [...document.querySelectorAll(run.settings.tokenStatusSelector || 'body *')].filter(visible); }
    catch { throw Error('Некорректный CSS-селектор статуса токена.'); }
    const statuses = nodes.map(el => ({ el, time: SelSupToken.parse(el.textContent || '') })).filter(x => x.time !== null);
    return statuses.filter(x => !statuses.some(y => x !== y && x.el.contains(y.el)));
  }
  async function verifyToken(run) {
    await pause(run, Math.max(0, run.resume.waitUntil - Date.now()));
    await report(run, 'Проверка верхнего токена: ожидается обновлённый успешный статус с датой в пределах ±5 минут.');
    while (Date.now() <= run.resume.deadline) {
      check(run);
      const leaves = tokenStatuses(run);
      if (leaves.length > 1) throw Error('Несколько статусов верхнего токена. Задайте CSS-селектор статуса.');
      if (leaves.length === 1 && SelSupToken.fresh(leaves[0].time)) {
        const time = leaves[0].time;
        // The page timestamp has one-second precision: a renewal within the
        // same second as the click can legitimately retain the same text.
        const updated = !Number.isFinite(run.resume.beforeTime) || time !== run.resume.beforeTime || time === Math.floor(run.resume.clickedAt / 1000) * 1000;
        if (updated) {
          await report(run, 'Верхний токен успешно получен: статус обновлён, дата соответствует текущему времени (±5 минут).');
          await checkpoint(run, null);
          return;
        }
      }
      await pause(run, 250);
    }
    throw Error('Верхний токен не подтверждён: статус не обновился или нет корректной надписи «Токен успешно получен» с датой в пределах ±5 минут.');
  }
  function categoryControls(run) {
    if (run.settings.categorySelector) return [...document.querySelectorAll(run.settings.categorySelector)].filter(visible);
    const lowerButtons = stepOn(run, 2) && run.settings.selectors[1]
      ? [...document.querySelectorAll(run.settings.selectors[1])].filter(visible) : tokenButtonsForStep(run, 2);
    const checks = stepOn(run, 3) && run.settings.selectors[2]
      ? [...document.querySelectorAll(run.settings.selectors[2])].filter(visible) : candidates('ПРОВЕРИТЬ СУЗ');
    if (lowerButtons.length !== 1) return [];
    const lower = lowerButtons[0], checkButton = checks.length === 1 ? checks[0] : null;
    let row = lower.parentElement;
    if (checkButton) while (row && !row.contains(checkButton)) row = row.parentElement;
    if (!row) return [];
    const controls = [...row.querySelectorAll('select, [role="combobox"], .ant-select, .el-select, .v-select, button, a, [role="button"], [aria-haspopup="listbox"], [aria-haspopup="menu"]')]
      .filter(el => visible(el) && (lower.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && (!checkButton || (el.compareDocumentPosition(checkButton) & Node.DOCUMENT_POSITION_FOLLOWING)));
    return controls.filter(el => !controls.some(other => other !== el && other.contains(el)));
  }
  async function categoryControl(run) {
    const deadline = Date.now() + run.settings.timeout * 1000;
    while (Date.now() <= deadline) {
      check(run); let found;
      try { found = categoryControls(run); } catch { throw Error('Некорректный CSS-селектор выбора категории.'); }
      if (found.length > 1) throw Error('Несколько полей категории. Задайте CSS-селектор выбора категории.');
      if (found.length === 1 && enabled(found[0])) return found[0];
      await pause(run, 250);
    }
    throw Error('Не найдено поле категории между нижним токеном и проверкой СУЗ. Задайте его CSS-селектор.');
  }
  const popupSelector = '[role="listbox"], [role="menu"], .ant-select-dropdown, .ant-dropdown, .ant-dropdown-menu, .el-select-dropdown, .rc-select-dropdown, .dropdown-menu, .p-dropdown-panel';
  const popupVisible = el => visible(el) && getComputedStyle(el).opacity !== '0' && el.getBoundingClientRect().width > 1 && el.getBoundingClientRect().height > 1;
  function popupState(run, control, initial) {
    const visiblePopups = [...document.querySelectorAll(popupSelector)].filter(popupVisible);
    const ids = [control, ...control.querySelectorAll('[aria-controls], [aria-owns]')]
      .flatMap(el => `${el.getAttribute('aria-controls') || ''} ${el.getAttribute('aria-owns') || ''}`.split(/\s+/)).filter(Boolean);
    const associated = ids.map(id => document.getElementById(id)).filter(el => el && popupVisible(el));
    let menus = associated.length ? associated : visiblePopups.filter(el => !initial.has(el));
    if (!menus.length && run.settings.categoryOptionSelector) {
      let options;
      try { options = [...document.querySelectorAll(run.settings.categoryOptionSelector)].filter(el => visible(el) && el !== control && !control.contains(el)); }
      catch { throw Error('Некорректный CSS-селектор пункта категории.'); }
      menus = options.map(el => el.closest(popupSelector) || el.parentElement);
    }
    return [...new Set(menus)];
  }
  async function openCategory(run, control) {
    if (control instanceof HTMLSelectElement) {
      await report(run, 'Категория: найден стандартный select, выбор значения.');
      return [];
    }
    const initial = new Set([...document.querySelectorAll(popupSelector)].filter(popupVisible));
    const end = Date.now() + Math.min(run.settings.timeout * 1000, 8000);
    const opened = () => popupState(run, control, initial);
    const waitOpened = async ms => {
      const until = Math.min(end, Date.now() + ms);
      do { check(run); const menus = opened(); if (menus.length) return menus; await pause(run, 100); } while (Date.now() < until);
      return [];
    };
    let menus = opened();
    if (menus.length) { await report(run, 'Категория: список уже открыт.'); return menus; }
    const selector = '.ant-select-selector, .ant-select-selection, .ant-dropdown-trigger, [role="combobox"], nz-select-top-control';
    const primary = control.matches(selector) ? control : control.querySelector(selector) || control;
    const targets = [...new Set([primary, control.querySelector('.ant-select-arrow, .ant-select-suffix, .el-input__suffix')])].filter(el => el && visible(el));
    for (const target of targets) {
      target.scrollIntoView({ block: 'center' });
      const rect = target.getBoundingClientRect();
      const mouse = { bubbles: true, cancelable: true, view: window, button: 0, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
      const strategies = [
        ['наведение', () => {
          target.dispatchEvent(new MouseEvent('mouseover', { ...mouse, relatedTarget: document.body }));
          target.dispatchEvent(new MouseEvent('mouseenter', { ...mouse, bubbles: false }));
        }],
        ['событие указателя', () => {
          target.dispatchEvent(new PointerEvent('pointerdown', { ...mouse, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
          target.dispatchEvent(new PointerEvent('pointerup', { ...mouse, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        }],
        ['нажатие мыши', () => {
          target.focus({ preventScroll: true });
          target.dispatchEvent(new MouseEvent('mousedown', { ...mouse, buttons: 1 }));
          target.dispatchEvent(new MouseEvent('mouseup', mouse));
        }],
        ['клик', () => target.click()],
        ['клавиша ArrowDown', () => {
          const keyboardTarget = target.querySelector('input:not([type="hidden"])') || target;
          keyboardTarget.focus({ preventScroll: true });
          keyboardTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true }));
          keyboardTarget.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
        }]
      ];
      for (const [name, action] of strategies) {
        check(run); menus = opened(); if (menus.length) return menus;
        if (Date.now() >= end) break;
        await report(run, `Категория: попытка открытия (${name}).`);
        action(); menus = await waitOpened(800);
        if (menus.length) { await report(run, 'Категория: открытие списка подтверждено.'); return menus; }
      }
    }
    throw Error('Список категории не открылся. Пункт «Корма для животных» не искался. Проверьте CSS-селектор поля категории.');
  }
  async function selectCategory(run) {
    const category = 'Корма для животных';
    const control = await categoryControl(run);
    const menus = await openCategory(run, control);
    await pause(run, run.settings.delay * 1000);
    const deadline = Date.now() + run.settings.timeout * 1000;
    while (true) {
      check(run); let options;
      if (control instanceof HTMLSelectElement) options = [...control.options].filter(el => normalize(el.textContent) === normalize(category));
      else if (run.settings.categoryOptionSelector) {
        try { options = [...document.querySelectorAll(run.settings.categoryOptionSelector)].filter(el => visible(el) && menus.some(menu => menu === el || menu.contains(el))); }
        catch { throw Error('Некорректный CSS-селектор пункта категории.'); }
      } else options = candidates(category, true).filter(el => menus.some(menu => menu === el || menu.contains(el)));
      if (options.length > 1) throw Error('Несколько пунктов «Корма для животных». Задайте CSS-селектор пункта.');
      if (options.length === 1 && enabled(options[0])) {
        if (normalize(options[0].textContent || '') !== normalize(category)) throw Error('Селектор пункта указывает на другую категорию.');
        await report(run, 'Категория: выбор «Корма для животных».');
        check(run);
        if (control instanceof HTMLSelectElement) {
          control.value = options[0].value;
          control.dispatchEvent(new Event('input', { bubbles: true }));
          control.dispatchEvent(new Event('change', { bubbles: true }));
        } else { options[0].scrollIntoView({ block: 'center' }); options[0].click(); }
        break;
      }
      if (Date.now() > deadline) throw Error('В списке не найден доступный пункт «Корма для животных».');
      await pause(run, 250);
    }
    await pause(run, run.settings.delay * 1000);
    const confirmationDeadline = Date.now() + run.settings.timeout * 1000;
    while (Date.now() <= confirmationDeadline) {
      const current = await categoryControl(run);
      const selected = current instanceof HTMLSelectElement ? current.selectedOptions[0]?.textContent : (current.querySelector('.ant-select-selection-item, .ant-select-selection-selected-value')?.textContent || current.textContent || current.value || '');
      if (normalize(selected || '') === normalize(category)) {
        await report(run, 'Категория подтверждена: «Корма для животных».'); return;
      }
      await pause(run, 250);
    }
    throw Error('Выбор категории «Корма для животных» не подтверждён в поле.');
  }
  async function authCheckpoint(run, auth) {
    check(run);
    const response = await chrome.runtime.sendMessage({ type: 'authCheckpoint', id: run.id, auth });
    if (!response?.ok) throw Error('Не удалось сохранить состояние авторизации.');
    run.auth = auth;
  }
  function loginForm() {
    const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
    if (!passwords.length) return null;
    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .filter(el => visible(el) && normalize(el.tagName === 'INPUT' ? el.value : el.textContent || '') === 'ВОЙТИ');
    const pairs = buttons.flatMap(button => {
      const form = button.closest('form');
      return passwords.filter(password => !form || form.contains(password)).map(password => ({ button, password, root: form || (() => { let root = password.parentElement; while (root && !root.contains(button)) root = root.parentElement; return root || document.body; })() }));
    });
    if (pairs.length > 1) throw Error('Несколько форм авторизации. Нельзя однозначно выбрать кнопку «Войти».');
    return pairs[0] || null;
  }
  function appearsFilled(input) {
    if (input.value.length > 0) return true;
    // Chromium can paint a saved password before exposing its value to JS.
    for (const selector of [':autofill', ':-webkit-autofill']) {
      try { if (input.matches(selector)) return true; } catch { /* Unsupported pseudo-class. */ }
    }
    return false;
  }
  function loginHeading(form) {
    for (let root = form.root; root; root = root.parentElement) {
      for (const selector of ['h1, h2, h3, h4, [role="heading"]', 'p, div, span']) {
        const found = [...root.querySelectorAll(selector)].filter(el => visible(el)
          && normalize(el.textContent || '') === 'АВТОРИЗАЦИЯ'
          && !el.closest('a, button, [role="button"], [role="link"], [contenteditable="true"]'));
        const leaves = found.filter(el => !found.some(other => other !== el && el.contains(other)));
        if (leaves.length > 1) throw Error('Несколько надписей «Авторизация». Нельзя однозначно выбрать место клика.');
        if (leaves.length === 1) return leaves[0];
      }
    }
    return null;
  }
  async function prepareLogin(run, form) {
    const heading = loginHeading(form);
    if (heading) {
      await report(run, 'Авторизация: клик по надписи «Авторизация» перед входом.');
      check(run);
      heading.scrollIntoView({ block: 'center' });
      const rect = heading.getBoundingClientRect();
      const mouse = { bubbles: true, cancelable: true, view: window, button: 0, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
      heading.dispatchEvent(new PointerEvent('pointerdown', { ...mouse, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      heading.dispatchEvent(new MouseEvent('mousedown', { ...mouse, buttons: 1 }));
      // A synthetic mousedown doesn't perform the browser's default blur.
      if (form.root.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) document.activeElement.blur();
      heading.dispatchEvent(new PointerEvent('pointerup', { ...mouse, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      heading.dispatchEvent(new MouseEvent('mouseup', mouse));
      heading.click();
    } else {
      await report(run, 'Авторизация: надпись «Авторизация» не найдена. Подготовка полей без клика.');
      if (form.root.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) document.activeElement.blur();
    }
    await pause(run, 500);
    const current = loginForm();
    if (!current) return;
    await report(run, 'Авторизация: уведомление формы об автозаполнении, пауза перед входом.');
    const inputs = [...current.root.querySelectorAll('input')].filter(el => visible(el) && ['text', 'email', 'tel', 'password'].includes(el.type));
    for (const input of inputs) {
      check(run);
      // Notify the site's form model without assigning or copying credentials.
      if (!input.value.length) continue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await pause(run, 500);
  }
  function crptReady(run) {
    if (location.origin !== 'https://selsup.ru' || location.pathname !== '/application/integration/crpt' || document.readyState === 'loading') return false;
    try {
      const ready = [1, 2, 3, 4, 5].every(step => {
        if (!stepOn(run, step)) return true;
        const selector = run.settings.selectors[step - 1];
        if (selector) return [...document.querySelectorAll(selector.replaceAll('{organization}', CSS.escape(run.settings.organizations[0])))].some(visible);
        if (step === 1 || step === 2) {
          // Leave ambiguous controls to target(), which gives a precise error.
          return candidates('ПОЛУЧИТЬ ТОКЕН').length > 2 || tokenButtonsForStep(run, step).length > 0;
        }
        return candidates(step === 3 ? 'ПРОВЕРИТЬ СУЗ' : step === 4 ? 'СОХРАНИТЬ' : run.settings.organizations[0], step === 5).length > 0;
      });
      return ready && ([1, 2, 3, 4, 5].some(step => stepOn(run, step)) || run.settings.categoryEnabled === false || categoryControls(run).length > 0);
    } catch { throw Error('Некорректный CSS-селектор кнопок страницы CRPT.'); }
  }
  async function ensureAuthorized(run) {
    const deadline = run.auth?.deadline ?? Date.now() + run.settings.timeout * 1000;
    let detected = false, autofillWaitUntil = null, prepared = false;
    while (Date.now() <= deadline) {
      check(run);
      const form = loginForm();
      if (form) {
        if (!run.auth) {
          await authCheckpoint(run, { deadline, attempted: false, returning: false, entryPath: location.pathname });
          await report(run, 'Авторизация: обнаружена страница входа.');
        }
        detected = true;
        if (!run.auth.attempted && enabled(form.button)) {
          // Values and autofill markers are hints, never a prerequisite to
          // pressing Login: the browser may conceal a painted saved password.
          // Credential values never enter messages, logs, settings or storage.
          if (autofillWaitUntil === null) {
            await report(run, 'Авторизация: ожидание автозаполнения — обязательная пауза 3 секунды перед нажатием «Войти».');
            autofillWaitUntil = Date.now() + 3000;
          }
          const usernames = [...form.root.querySelectorAll('input')].filter(el => visible(el) && ['text','email','tel'].includes(el.type));
          if (usernames.length && Date.now() >= autofillWaitUntil) {
            if (!prepared) {
              await prepareLogin(run, form);
              prepared = true;
              continue; // Re-read the form after blur/events and possible re-render.
            }
            const filled = appearsFilled(form.password) && usernames.some(appearsFilled);
            await authCheckpoint(run, { ...run.auth, attempted: true });
            await report(run, filled
              ? 'Авторизация: нажатие кнопки «Войти» с данными, подставленными браузером.'
              : 'Авторизация: автозаполнение недоступно для проверки JavaScript. Однократное нажатие «Войти» после ожидания браузера.');
            check(run);
            if (!form.button.isConnected || !visible(form.button) || !enabled(form.button)) throw Error('Форма входа изменилась перед нажатием. Повторите запуск после проверки страницы.');
            form.button.scrollIntoView({ block: 'center' }); form.button.click();
          }
        }
      } else if (crptReady(run)) {
        if (run.auth || detected) {
          await report(run, 'Авторизация подтверждена: страница CRPT загружена.');
          await authCheckpoint(run, null);
        }
        return;
      } else if (run.auth?.attempted && location.pathname !== '/application/integration/crpt' && location.pathname !== run.auth.entryPath && !run.auth.returning && document.readyState === 'complete') {
        await authCheckpoint(run, { ...run.auth, returning: true });
        await report(run, 'Авторизация: возврат на страницу CRPT после входа.');
        check(run); location.assign('https://selsup.ru/application/integration/crpt');
      }
      await pause(run, 250);
    }
    if (run.auth && !run.auth.attempted) throw Error('Авторизация не выполнена: поля формы или кнопка «Войти» недоступны.');
    if (run.auth?.attempted) throw Error('После нажатия «Войти» страница CRPT не загрузилась. Проверьте вход в браузере; повторного нажатия не было.');
    throw Error('Страница CRPT не загрузилась вовремя.');
  }
  async function execute(run) {
    const heartbeat = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'heartbeat', id: run.id }).then(r => { if (!r?.ok) run.cancelled = true; }).catch(() => { run.cancelled = true; });
    }, 20000);
    try {
      await ensureAuthorized(run);
      const resumedPass = run.resume?.pass;
      if (resumedPass === undefined) {
        if (stepOn(run, 5)) {
          await report(run, 'Страница открыта. Выбор первой организации.');
          await click(run, 5, run.settings.organizations[0], 'Подготовка: первая организация');
        } else await report(run, 'Переключение организаций выключено: один проход для текущей организации.');
      } else await report(run, 'Продолжение после обновления страницы, без повторного клика верхнего токена.');
      for (let pass = resumedPass ?? 0; pass < (stepOn(run, 5) ? 2 : 1); pass++) {
        if (pass !== resumedPass && stepOn(run, 1)) {
          await click(run, 1, null, `Проход ${pass+1}, шаг 1 (верхний токен)`, () => checkpoint(run, {
            pass, clickedAt: Date.now(), beforeTime: run.settings.tokenStatusEnabled === false ? null : tokenStatuses(run)[0]?.time ?? null,
            waitUntil: Date.now() + run.settings.delay * 1000,
            deadline: Date.now() + (run.settings.delay + run.settings.timeout) * 1000
          }));
        }
        if (!stepOn(run, 1)) await report(run, `Проход ${pass+1}: шаг 1 и проверка верхнего токена пропущены — выключены в настройках.`);
        else if (run.settings.tokenStatusEnabled !== false) await verifyToken(run);
        else {
          await pause(run, Math.max(0, (run.resume?.waitUntil || 0) - Date.now()));
          await checkpoint(run, null);
          await report(run, `Проход ${pass+1}: проверка верхнего токена пропущена — выключена в настройках.`);
        }
        if (run.settings.categoryEnabled !== false) await selectCategory(run);
        else await report(run, `Проход ${pass+1}: выбор категории пропущен — выключен в настройках.`);
        for (let step = 2; step <= 5; step++) {
          const names = ['верхний токен', 'нижний токен', 'проверка СУЗ', 'сохранение', 'переключение организации'];
          if (!stepOn(run, step)) { await report(run, `Проход ${pass+1}, шаг ${step} (${names[step-1]}): пропущен — выключен в настройках.`); continue; }
          await click(run, step, run.settings.organizations[pass === 0 ? 1 : 0], `Проход ${pass+1}, шаг ${step} (${names[step-1]})`);
        }
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
    finally { clearInterval(heartbeat); if (active === run) active = null; }
  }
  function begin(message) {
    active = { id: message.id, settings: message.settings, resume: message.resume || null, auth: message.auth || null, cancelled: false };
    const run = active;
    void execute(run).then(result => chrome.runtime.sendMessage({ type: 'finished', id: run.id, result })).catch(() => {});
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'stop') {
      if (active?.id === message.id) active.cancelled = true;
      respond({ ok: true }); return;
    }
    if (message.type === 'execute') {
      if (active) { respond({ ok: false, error: 'На странице уже выполняется сценарий.' }); return; }
      if (location.origin !== 'https://selsup.ru') {
        respond({ ok: false, error: 'Неверная страница SelSup.' }); return;
      }
      respond({ ok: true, started: true });
      begin(message);
      return;
    }
  });
  if (location.origin === 'https://selsup.ru') {
    void chrome.runtime.sendMessage({ type: 'resume' }).then(message => { if (message?.ok && (message.resume || message.auth) && !active) begin(message); }).catch(() => {});
  }
})();
