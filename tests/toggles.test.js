import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { DEFAULTS, validate } from '../extension/common.js';
import { fixture } from './fixture.js';

test('настройки: старые значения совместимы, переключатели проверяются, пустой сценарий запрещён',()=>{
  const old={...DEFAULTS};delete old.stepEnabled;delete old.categoryEnabled;delete old.tokenStatusEnabled;
  assert.deepEqual(validate(old).stepEnabled,[true,true,true,true,true]);
  assert.equal(validate(old).categoryEnabled,true);
  assert.throws(()=>validate({...DEFAULTS,stepEnabled:[true]}));
  assert.throws(()=>validate({...DEFAULTS,categoryEnabled:'false'}));
  assert.throws(()=>validate({...DEFAULTS,stepEnabled:[false,false,false,false,false],categoryEnabled:false}));
  assert.doesNotThrow(()=>validate({...DEFAULTS,stepEnabled:[false,true,true,true,false],organizations:['','']}));
});

test('Chromium: верхняя кнопка удалена, отключённые элементы не ожидаются и не нажимаются', {timeout:110000},async()=>{
  const browser=await chromium.launch({executablePath:'/usr/lib/chromium/chromium',headless:true,args:['--no-sandbox']});
  try{
    const page=await browser.newPage();
    await page.route('https://selsup.ru/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:fixture}));
    await page.addInitScript(()=>{
      window.messages=[];
      window.chrome={runtime:{id:'test',onMessage:{addListener(fn){window.listener=fn}},async sendMessage(msg){messages.push(msg);if(msg.type==='finished')window.completed=msg.result;return {ok:true}}}};
      window.dispatch=msg=>new Promise(r=>listener(msg,{id:'test'},r));
    });
    const setup=async()=>{
      await page.goto('https://selsup.ru/application/integration/crpt');await page.evaluate(()=>sessionStorage.clear());await page.reload();
    };
    const run=async settings=>{
      await page.addScriptTag({path:'extension/token.js'});await page.addScriptTag({path:'extension/content.js'});
      assert.equal((await page.evaluate(settings=>dispatch({type:'execute',id:'toggles',settings}),settings)).started,true);
      await page.waitForFunction(()=>window.completed,null,{timeout:30000});
      const result=await page.evaluate(()=>completed);assert.equal(result.ok,true,result.error);
      return page.evaluate(()=>({clicks,messages}));
    };
    const settings={...DEFAULTS,delay:1,timeout:10,organizations:['Организация А','Тест FBS'],stepEnabled:[false,true,true,true,true],selectors:['[','','','',''],tokenStatusSelector:'['};
    await setup();await page.locator('[data-step="1"], #token-status').evaluateAll(nodes=>nodes.forEach(n=>n.remove()));
    let result=await run(settings);
    assert.deepEqual(result.clicks,['A','open','feed','2','3','4','B','open','feed','2','3','4','A']);
    assert.equal(result.messages.filter(m=>m.message?.includes('шаг 1 и проверка верхнего токена пропущены')).length,2);
    assert.equal(result.messages.some(m=>m.message?.startsWith('Верхний токен успешно')),false);
    // Every remaining click and the category group can be skipped independently.
    // Missing check/save nodes and malformed disabled selectors must not block readiness.
    await setup();await page.locator('[data-step="1"], #token-status, [data-step="3"], [data-step="4"], #category, #menu').evaluateAll(nodes=>nodes.forEach(n=>n.remove()));
    result=await run({...settings,stepEnabled:[false,true,false,false,false],organizations:['',''],categoryEnabled:false,selectors:['[','','[','[','['],categorySelector:'[',categoryOptionSelector:'['});
    assert.deepEqual(result.clicks,['2']);
    assert.ok(result.messages.some(m=>m.message?.includes('один проход')));
    assert.ok(result.messages.some(m=>m.message?.includes('выбор категории пропущен')));
    // Disabling only the lower button leaves upper-token verification intact.
    await setup();result=await run({...settings,selectors:['','','','',''],tokenStatusSelector:'',stepEnabled:[true,false,true,true,false],categoryEnabled:false});
    assert.deepEqual(result.clicks,['1','3','4']);
    assert.ok(result.messages.some(m=>m.message?.startsWith('Верхний токен успешно')));
    // Status selection must not be evaluated when its own switch is off.
    await setup();await page.locator('#token-status').evaluate(n=>n.remove());
    await page.evaluate(()=>window.tokenMode='stale');
    result=await run({...settings,selectors:['','','','',''],stepEnabled:[true,true,true,true,false],categoryEnabled:false,tokenStatusEnabled:false});
    assert.deepEqual(result.clicks,['1','2','3','4']);
    assert.ok(result.messages.some(m=>m.message?.includes('проверка верхнего токена пропущена')));
  }finally{await browser.close();}
});
