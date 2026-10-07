import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { DEFAULTS } from '../extension/common.js';

test('Chromium: переключатели сохраняются, отключённые селекторы сохраняются без проверки', {timeout:30000}, async()=>{
  const browser=await chromium.launch({executablePath:'/usr/lib/chromium/chromium',headless:true,args:['--no-sandbox']});
  try {
    const page=await browser.newPage();
    const files=new Map(await Promise.all(['options.html','options.js','options.css','common.js'].map(async name=>[name,await readFile(`extension/${name}`,'utf8')])));
    await page.route('http://127.0.0.1:32123/**',route=>{
      const name=new URL(route.request().url()).pathname.slice(1);
      return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html; charset=utf-8',body:files.get(name)||''});
    });
    const legacy={...DEFAULTS};delete legacy.stepEnabled;delete legacy.categoryEnabled;delete legacy.tokenStatusEnabled;
    await page.addInitScript(legacy=>{
      window.chrome={storage:{local:{async get(){return {settings:JSON.parse(localStorage.getItem('settings'))||legacy}}},onChanged:{addListener(){}}},alarms:{async get(){}},runtime:{async sendMessage(msg){if(msg.type==='save')localStorage.setItem('settings',JSON.stringify(msg.settings));return {ok:true}}}};
    },legacy);
    const ready=async()=>page.waitForFunction(()=>document.querySelector('#logs').textContent==='Действий пока нет.');
    const save=async()=>{
      await page.locator('#status').evaluate(n=>n.textContent='');
      await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#status').textContent.length>0);
      return page.locator('#status').textContent();
    };
    await page.goto('http://127.0.0.1:32123/options.html');await ready();
    assert.equal(await page.locator('#step1Enabled').isChecked(),true);
    await page.locator('details').evaluate(n=>n.open=true);
    await page.locator('#selector1').fill('[');await page.locator('#tokenStatusSelector').fill('[');
    await page.locator('#step1Enabled').uncheck();
    assert.equal(await page.locator('#tokenStatusEnabled').isDisabled(),true);
    assert.equal(await page.locator('#tokenStatusSelector').isDisabled(),true);
    assert.equal(await save(),'Настройки сохранены.');
    await page.reload();await ready();
    assert.equal(await page.locator('#step1Enabled').isChecked(),false);
    assert.equal(await page.locator('#selector1').inputValue(),'[');
    assert.equal(await page.locator('#tokenStatusEnabled').isChecked(),true);
    await page.locator('#step1Enabled').check();
    assert.notEqual(await save(),'Настройки сохранены.','active invalid CSS must fail');
    await page.locator('details').evaluate(n=>n.open=true);
    await page.locator('#selector1').fill('');await page.locator('#tokenStatusSelector').fill('');
    await page.locator('#categoryEnabled').uncheck();
    assert.equal(await page.locator('#categorySelector').isDisabled(),true);
    assert.equal(await page.locator('#categoryOptionSelector').isDisabled(),true);
    await page.locator('#org1').fill('');await page.locator('#org2').fill('');
    await page.locator('#step5Enabled').uncheck();
    assert.equal(await page.locator('#org1').isDisabled(),true);
    assert.equal(await page.locator('#selector5').isDisabled(),true);
    assert.equal(await save(),'Настройки сохранены.');
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('settings')));
    assert.deepEqual(saved.stepEnabled,[true,true,true,true,false]);assert.equal(saved.categoryEnabled,false);
    for(let i=1;i<=4;i++)await page.locator(`#step${i}Enabled`).uncheck();
    assert.equal(await save(),'Включите хотя бы одно действие.');
  } finally {await browser.close();}
});
