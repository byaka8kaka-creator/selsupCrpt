import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { DEFAULTS, nextRun, validate, dayKey } from '../extension/common.js';

test('ежедневное расписание и проверка настроек', () => {
  const now = new Date(2026, 9, 6, 8, 0);
  assert.equal(nextRun('07:00', now), new Date(2026, 9, 7, 7, 0).getTime());
  assert.equal(nextRun('09:00', now), new Date(2026, 9, 6, 9, 0).getTime());
  assert.equal(dayKey(now), '2026-10-06');
  assert.throws(() => validate({ ...DEFAULTS, delay: 0 }));
  assert.throws(() => validate({ ...DEFAULTS, time: '25:00' }));
  assert.throws(() => validate({ ...DEFAULTS, organizations: ['A', 'A'] }));
});
const fixture = `<!doctype html><html><body>
<button role="tab" data-org="A">Организация А</button><button role="tab" data-org="B"><span>Тест FBS</span></button>
<button data-step="1">ПОЛУЧИТЬ ТОКЕН</button><button data-step="2">Получить токен</button>
<button data-step="3">ПРОВЕРИТЬ СУЗ</button><button data-step="4">СОХРАНИТЬ</button>
<script>window.clicks=[]; document.addEventListener('click', e=>{const el=e.target.closest('button'); if(el) clicks.push(el.dataset.org || el.dataset.step)});</script></body></html>`;

test('Chromium: два прохода, остановка, недоступная кнопка, неоднозначность, CSS', {timeout:60000}, async () => {
  const browser = await chromium.launch({ executablePath:'/usr/lib/chromium/chromium', headless:true, args:['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('https://selsup.ru/**', route => route.fulfill({contentType:'text/html; charset=utf-8', body:fixture}));
    await page.addInitScript(() => {
      window.progress=[];
      window.chrome={runtime:{id:'test',onMessage:{addListener(fn){window.listener=fn}}, async sendMessage(msg){progress.push(msg);if(msg.type==='finished')window.completed=msg.result;return {ok:true}}}};
      window.dispatch = message => new Promise(resolve => listener(message,{id:'test'},resolve));
    });
    const setup = async () => {
      await page.goto('https://selsup.ru/application/integration/crpt');
      await page.addScriptTag({path:'extension/content.js'});
    };
    const s={...DEFAULTS,delay:1,timeout:10,organizations:['Организация А','Тест FBS']};
    const run = async settings => {
      const ack = await page.evaluate(settings=>dispatch({type:'execute',id:'run',settings}), settings);
      if (!ack.started) return ack;
      await page.waitForFunction(()=>window.completed, null, {timeout:25000});
      return page.evaluate(()=>completed);
    };
    await setup(); const first=await run(s); assert.equal(first.ok,true,JSON.stringify({result:first, clicks:await page.evaluate(()=>clicks)}));
    assert.deepEqual(await page.evaluate(()=>clicks),['A','1','2','3','4','B','1','2','3','4','A']);
    assert.equal(await page.evaluate(()=>progress.filter(x=>x.message?.includes(': нажатие.')).length),11);
    await setup();
    const pending=run(s);
    await page.waitForFunction(()=>clicks.length===1);
    await page.evaluate(()=>dispatch({type:'stop',id:'run'}));
    assert.equal((await pending).ok,false);
    assert.deepEqual(await page.evaluate(()=>clicks),['A']);
    await setup(); await page.locator('[data-step="2"]').evaluate(el=>el.disabled=true);
    const failed=await run(s); assert.equal(failed.ok,false); assert.match(failed.error,/Шаг 2/);
    assert.deepEqual(await page.evaluate(()=>clicks),['A','1']);
    await setup(); await page.locator('[data-step="1"]').evaluate(el=>el.after(el.cloneNode(true)));
    assert.match((await run(s)).error,/больше двух/);
    assert.deepEqual(await page.evaluate(()=>clicks),['A']);
    await setup();
    const custom={...s,selectors:['[data-step="1"]','[data-step="2"]','[data-step="3"]','[data-step="4"]','[role="tab"][aria-label="{organization}"]']};
    await page.locator('[data-org="A"]').evaluate(el=>el.setAttribute('aria-label','Организация А'));
    await page.locator('[data-org="B"]').evaluate(el=>el.setAttribute('aria-label','Тест FBS'));
    assert.equal((await run(custom)).ok,true);
    assert.deepEqual(await page.evaluate(()=>clicks),['A','1','2','3','4','B','1','2','3','4','A']);
  } finally {await browser.close();}
});
