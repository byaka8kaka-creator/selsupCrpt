import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { DEFAULTS } from '../extension/common.js';
import { fixture, sequence } from './fixture.js';
const url='https://selsup.ru/application/integration/crpt';
const username='test-account', password='test-password';
function loginHTML(filled=true) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Авторизация</h1><form method="post" action="${url}">
  <input type="text" autocomplete="username" value="${filled?username:''}"><input type="password" autocomplete="current-password" value="${filled?password:''}">
  <button type="submit" onclick="sessionStorage.setItem('loginClicks',Number(sessionStorage.getItem('loginClicks')||0)+1);sessionStorage.setItem('loginClickedAt',Date.now())">Войти</button>
  <button type="button" onclick="sessionStorage.setItem('yandexClicked','yes')">Войти с Яндекс ID</button></form></body></html>`;
}
async function harness() {
  const browser=await chromium.launch({executablePath:'/usr/lib/chromium/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();
  const settings={...DEFAULTS,delay:1,timeout:10,organizations:['Организация А','Тест FBS']};
  const state={resume:null,auth:null,started:false}; const messages=[], timings=[];
  await page.exposeFunction('mockMessage', msg=>{
    messages.push(msg);
    timings.push({time:Date.now(),message:msg.message});
    if(msg.type==='checkpoint')state.resume=msg.resume;
    if(msg.type==='authCheckpoint')state.auth=msg.auth;
    if(msg.type==='resume')return state.started && (state.resume||state.auth) ? {ok:true,id:'login-run',settings,resume:state.resume,auth:state.auth}: {ok:false};
    if(msg.type==='finished')state.result=msg.result;
    return {ok:true};
  });
  const helper=await readFile('extension/token.js','utf8'),content=await readFile('extension/content.js','utf8');
  await page.addInitScript({content:`
  window.chrome={runtime:{id:'test',onMessage:{addListener(fn){window.listener=fn}},async sendMessage(msg){return mockMessage(msg)}}};
  window.dispatch=msg=>new Promise(r=>listener(msg,{id:'test'},r));
  document.addEventListener('DOMContentLoaded',()=>{${helper}\n${content}});
  `});
  const start=async()=>{state.started=true;return page.evaluate(settings=>dispatch({type:'execute',id:'login-run',settings}),settings)};
  // Wait through navigation using an exposed function, without requiring a live
  // DOM variable from the previous document.
  const finished=async()=>{
    const end=Date.now()+35000;
    while(!state.result&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
    assert.ok(state.result,'scenario completed');return state.result;
  };
  return {browser,page,settings,state,messages,timings,start,finished};
}

async function assertLoginDelay(h) {
  const wait=h.timings.find(m=>m.message?.includes('обязательная пауза 3 секунды'));
  assert.ok(wait,'mandatory wait is logged');
  const clickedAt=Number(await h.page.evaluate(()=>sessionStorage.getItem('loginClickedAt')));
  assert.ok(clickedAt-wait.time>=3000,`Login clicked after ${clickedAt-wait.time} ms`);
}

test('авторизация: обычный вход из сохранённых полей, перезагрузка и оба прохода', {timeout:40000},async()=>{
  const h=await harness();let submitted=0;
  try {
    await h.page.route('https://selsup.ru/**',async route=>{
      if(route.request().method()==='POST')submitted++;
      await route.fulfill({contentType:'text/html; charset=utf-8',body:submitted?fixture:loginHTML()});
    });
    await h.page.goto(url);assert.equal((await h.start()).started,true);
    assert.equal((await h.finished()).ok,true);
    assert.equal(submitted,1);assert.equal(await h.page.evaluate(()=>sessionStorage.getItem('loginClicks')),'1');
    await assertLoginDelay(h);
    assert.equal(await h.page.evaluate(()=>sessionStorage.getItem('yandexClicked')),null);
    assert.deepEqual(await h.page.evaluate(()=>clicks),sequence);
    assert.equal(h.state.auth,null);
    assert.ok(h.messages.some(m=>m.message==='Авторизация подтверждена: страница CRPT загружена.'));
    const persisted=JSON.stringify({state:h.state,messages:h.messages});assert.equal(persisted.includes(username),false);assert.equal(persisted.includes(password),false);
  }finally{await h.browser.close();}
});

test('авторизация: пустое автозаполнение и неудачный вход допускают только одно нажатие', {timeout:30000},async()=>{
  for(const filled of [false,true]){
    const h=await harness();let submitted=0;
    try{
      await h.page.route('https://selsup.ru/**',async route=>{
        if(route.request().method()==='POST')submitted++;
        await route.fulfill({contentType:'text/html; charset=utf-8',body:loginHTML(filled)});
      });
      await h.page.goto(url);await h.start();const result=await h.finished();
      assert.equal(result.ok,false);assert.equal(submitted,1);
      assert.match(result.error,/повторного нажатия не было/);
      assert.equal(await h.page.evaluate(()=>sessionStorage.getItem('yandexClicked')),null);
    }finally{await h.browser.close();}
  }
});

test('авторизация: браузер показывает пароль, но JS видит пустые значения', {timeout:25000},async()=>{
  for (const mode of ['password','both','autofill']) {
    const h=await harness();let submitted=0;
    // Keep this regression focused on signing in and continuing the enabled
    // action, including the layout where the upper token is disabled.
    h.settings.stepEnabled=[false,true,false,false,false];h.settings.categoryEnabled=false;
    try {
      await h.page.route('https://selsup.ru/**',async route=>{
        if(route.request().method()==='POST')submitted++;
        await route.fulfill({contentType:'text/html; charset=utf-8',body:submitted?fixture:loginHTML()});
      });
      await h.page.goto(url);
      await h.page.locator('input[type=password]').evaluate(input=>Object.defineProperty(input,'value',{get(){return ''}}));
      if(mode==='both')await h.page.locator('input[type=text]').evaluate(input=>Object.defineProperty(input,'value',{get(){return ''}}));
      assert.equal(await h.page.locator('input[type=password]').evaluate(input=>input.value),'');
      if(mode==='autofill') {
        const session=await h.page.context().newCDPSession(h.page);
        await session.send('DOM.enable');await session.send('CSS.enable');
        const {root}=await session.send('DOM.getDocument');
        const {nodeId}=await session.send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type=password]'});
        await session.send('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:['autofill']});
        assert.equal(await h.page.locator('input[type=password]').evaluate(input=>input.matches(':autofill')),true);
      }
      await h.start();const result=await h.finished();
      assert.equal(result.ok,true,result.error);assert.equal(submitted,1);
      assert.equal(await h.page.evaluate(()=>sessionStorage.getItem('loginClicks')),'1');
      await assertLoginDelay(h);
      assert.deepEqual(await h.page.evaluate(()=>clicks),['2']);
      assert.equal(h.messages.some(m=>m.message?.includes('автозаполнение недоступно для проверки JavaScript')),mode!=='autofill');
      const persisted=JSON.stringify({state:h.state,messages:h.messages});
      assert.equal(persisted.includes(username),false);assert.equal(persisted.includes(password),false);
    } finally {await h.browser.close();}
  }
});

test('авторизация: ожидание позднего автозаполнения и переход без перезагрузки документа', {timeout:40000},async()=>{
  const h=await harness();
  try{
    await h.page.route('https://selsup.ru/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:loginHTML(false)}));
    await h.page.goto(url);
    await h.page.locator('form').evaluate(form=>form.addEventListener('submit',e=>e.preventDefault()));
    await h.start();
    const waitBy=Date.now()+2000;
    while(!h.messages.some(m=>m.message?.includes('ожидание автозаполнения')) && Date.now()<waitBy)await new Promise(r=>setTimeout(r,50));
    assert.equal(await h.page.evaluate(()=>sessionStorage.getItem('loginClicks')),null);
    await h.page.locator('input[type=text]').fill(username);await h.page.locator('input[type=password]').fill(password);
    await h.page.waitForFunction(()=>sessionStorage.getItem('loginClicks')==='1');
    await assertLoginDelay(h);
    await h.page.setContent(fixture);
    assert.equal((await h.finished()).ok,true);assert.deepEqual(await h.page.evaluate(()=>clicks),sequence);
    assert.equal(h.state.auth,null);assert.ok(h.messages.some(m=>m.message?.includes('ожидание автозаполнения')));
  }finally{await h.browser.close();}
});

test('авторизация: отдельная страница входа и возврат с главной страницы на CRPT', {timeout:45000},async()=>{
  const h=await harness();let authed=false,submitted=0;
  try{
    await h.page.route('https://selsup.ru/**',async route=>{
      const request=route.request();const path=new URL(request.url()).pathname;
      if(request.method()==='POST'){
        submitted++;authed=true;
        await route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><script>location.assign("https://selsup.ru/application")</script>'});return;
      }
      if(path==='/login'){await route.fulfill({contentType:'text/html; charset=utf-8',body:loginHTML()});return;}
      if(path==='/application'){await route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><h1>Главная страница</h1>'});return;}
      if(!authed){await route.fulfill({contentType:'text/html; charset=utf-8',body:loginHTML()});return;}
      await route.fulfill({contentType:'text/html; charset=utf-8',body:fixture});
    });
    await h.page.goto('https://selsup.ru/login');assert.equal(new URL(h.page.url()).pathname,'/login');await h.start();
    const result=await h.finished();assert.equal(result.ok,true,result.error);assert.equal(submitted,1);
    assert.equal(h.page.url(),url);assert.deepEqual(await h.page.evaluate(()=>clicks),sequence);
    assert.ok(h.messages.some(m=>m.message==='Авторизация: возврат на страницу CRPT после входа.'));
  }finally{await h.browser.close();}
});
