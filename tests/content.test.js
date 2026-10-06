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
import { fixture, sequence } from './fixture.js';

test('Chromium: два прохода, остановка, недоступная кнопка, неоднозначность, CSS', {timeout:120000}, async () => {
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
      await page.evaluate(()=>sessionStorage.clear());
      await page.reload();
      await page.addScriptTag({path:'extension/token.js'});
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
    assert.deepEqual(await page.evaluate(()=>clicks),sequence);
    assert.equal(await page.evaluate(()=>progress.filter(x=>x.message?.includes(': нажатие.')).length),11);
    await setup();
    const pending=run(s);
    await page.waitForFunction(()=>clicks.length===1);
    await page.evaluate(()=>dispatch({type:'stop',id:'run'}));
    assert.equal((await pending).ok,false);
    assert.deepEqual(await page.evaluate(()=>clicks),['A']);
    await setup(); await page.locator('[data-step="2"]').evaluate(el=>el.disabled=true);
    const failed=await run(s); assert.equal(failed.ok,false); assert.match(failed.error,/Шаг 2/);
    assert.deepEqual(await page.evaluate(()=>clicks),['A','1','open','feed']);
    await setup(); await page.locator('[data-step="1"]').evaluate(el=>el.after(el.cloneNode(true)));
    assert.match((await run(s)).error,/больше двух/);
    assert.deepEqual(await page.evaluate(()=>clicks),['A']);
    for (const mode of ['stale','future','unchangedFresh']) {
      await setup(); await page.evaluate(mode=>{
        window.tokenMode=mode==='unchangedFresh'?'stale':mode;
        if(mode==='unchangedFresh'){const d=new Date(Date.now()-60000);document.querySelector('#token-status').textContent='Токен успешно получен: '+d.toLocaleDateString('ru-RU')+' '+d.toLocaleTimeString('ru-RU',{hour12:false});}
      },mode);
      const rejected=await run(s); assert.equal(rejected.ok,false); assert.match(rejected.error,/Верхний токен не подтверждён/);
      assert.deepEqual(await page.evaluate(()=>clicks),['A','1']);
    }
    await setup();
    const custom={...s,selectors:['[data-step="1"]','[data-step="2"]','[data-step="3"]','[data-step="4"]','[role="tab"][aria-label="{organization}"]']};
    await page.locator('[data-org="A"]').evaluate(el=>el.setAttribute('aria-label','Организация А'));
    await page.locator('[data-org="B"]').evaluate(el=>el.setAttribute('aria-label','Тест FBS'));
    assert.equal((await run(custom)).ok,true);
    assert.deepEqual(await page.evaluate(()=>clicks),sequence);
  } finally {await browser.close();}
});

test('Chromium: продолжение после полной перезагрузки на шаге 1 без повторного клика', {timeout:35000}, async () => {
  const { readFile } = await import('node:fs/promises');
  const helper=await readFile('extension/token.js','utf8'), content=await readFile('extension/content.js','utf8');
  const browser=await chromium.launch({executablePath:'/usr/lib/chromium/chromium',headless:true,args:['--no-sandbox']});
  try {
    const page=await browser.newPage();
    const settings={...DEFAULTS,delay:1,timeout:10,organizations:['Организация А','Тест FBS']};
    let checkpoint=null; const messages=[];
    await page.exposeFunction('mockMessage', msg=>{
      messages.push(msg);
      if(msg.type==='checkpoint')checkpoint=msg.resume;
      if(msg.type==='resume')return checkpoint ? {ok:true,id:'reload-run',settings,resume:checkpoint} : {ok:false};
      return {ok:true};
    });
    await page.addInitScript({content:`
      window.chrome={runtime:{id:'test',onMessage:{addListener(fn){window.listener=fn}},async sendMessage(msg){const result=await mockMessage(msg);if(msg.type==='finished')window.completed=msg.result;return result}}};
      window.dispatch=msg=>new Promise(r=>listener(msg,{id:'test'},r));
      ${helper}\n${content}
    `});
    await page.route('https://selsup.ru/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:fixture}));
    await page.goto('https://selsup.ru/application/integration/crpt');
    await page.evaluate(()=>window.tokenMode='reload');
    assert.equal((await page.evaluate(settings=>dispatch({type:'execute',id:'reload-run',settings}),settings)).started,true);
    await page.waitForFunction(()=>window.completed,null,{timeout:30000});
    assert.equal((await page.evaluate(()=>completed)).ok,true);
    assert.deepEqual(await page.evaluate(()=>clicks),sequence);
    assert.equal(messages.filter(x=>x.message?.startsWith('Продолжение после обновления')).length,1);
    assert.equal(checkpoint,null);
  }finally{await browser.close();}
});

test('Chromium: категория в обычном select и Ant Design; отсутствие пункта блокирует шаг 2', {timeout:45000},async()=>{
  const browser=await chromium.launch({executablePath:'/usr/lib/chromium/chromium',headless:true,args:['--no-sandbox']});
  try {
    const page=await browser.newPage();
    await page.addInitScript(()=>{
      window.progress=[];
      window.chrome={runtime:{id:'test',onMessage:{addListener(fn){window.listener=fn}},async sendMessage(msg){progress.push(msg);if(msg.type==='finished')window.completed=msg.result;return {ok:true}}}};
      window.dispatch=msg=>new Promise(r=>listener(msg,{id:'test'},r));
    });
    const testCase=async(type,missing=false)=>{
      const native='<select id="category"><option>Одежда</option><option value="feed">Корма для животных</option></select>';
      const ant='<div class="ant-select" id="category"><div class="ant-select-selection" role="combobox"><span class="ant-select-selection-selected-value">Одежда</span></div></div>';
      const html=`<html><head><meta charset="utf-8"></head><body><button role="tab">Организация А</button><p id="token"></p><button data-step="1">Получить токен</button><div><button data-step="2">Получить токен</button>${type==='native'?native:ant}<button data-step="3">Проверить СУЗ</button></div><button data-step="4">Сохранить</button><div id="menu" hidden><div role="option" data-feed>Корма для животных</div></div><script>
      window.clicks=[];const d=new Date();document.querySelector('#token').textContent='Токен успешно получен: '+d.toLocaleDateString('ru-RU')+' '+d.toLocaleTimeString('ru-RU',{hour12:false});
      document.addEventListener('click',e=>{if(e.target.dataset.step)clicks.push(e.target.dataset.step);if(e.target.hasAttribute('data-feed')){document.querySelector('.ant-select-selection-selected-value').textContent=e.target.textContent;document.querySelector('#menu').hidden=true;}});
      document.querySelector('.ant-select-selection')?.addEventListener('mousedown',()=>{document.querySelector('#menu').hidden=false});
      </script></body></html>`;
      await page.unrouteAll();await page.route('https://selsup.ru/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:html}));
      await page.goto('https://selsup.ru/application/integration/crpt');
      if(missing)await page.locator('[data-feed]').evaluate(el=>el.remove());
      await page.addScriptTag({path:'extension/token.js'});await page.addScriptTag({path:'extension/content.js'});
      const settings={...DEFAULTS,delay:1,timeout:10,organizations:['Организация А','Тест FBS']};
      await page.evaluate(settings=>dispatch({type:'execute',id:'category-run',settings,resume:{pass:1,waitUntil:Date.now(),deadline:Date.now()+10000}}),settings);
      await page.waitForFunction(()=>window.completed,null,{timeout:25000});
      return {result:await page.evaluate(()=>completed),clicks:await page.evaluate(()=>clicks)};
    };
    for(const type of ['native','ant']){
      const result=await testCase(type);assert.equal(result.result.ok,true,JSON.stringify(result));assert.deepEqual(result.clicks,['2','3','4']);
    }
    const failed=await testCase('ant',true);assert.equal(failed.result.ok,false);assert.match(failed.result.error,/не найден доступный пункт/);assert.deepEqual(failed.clicks,[]);
  }finally{await browser.close();}
});
