import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { DEFAULTS, URL, validate, nextRun, dayKey } from '../extension/common.js';
import { clickAuthTarget } from '../extension/auth-debugger.js';
const source=(await readFile('extension/background.js','utf8')).replace(/^import .*?;\n/gm,'');

async function finishCase(config={}) {
  const {createdTab=true,url=URL,error,removeFails=false}=config;
  const data={run:{id:'run',tabId:7,createdTab}}, removed=[],events={};
  if(Object.hasOwn(config,'createdTab')&&config.createdTab===undefined)delete data.run.createdTab;
  const event=name=>({addListener(fn){events[name]=fn}});
  const chrome={
    storage:{local:{async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(data[k])]))},async set(values){Object.assign(data,structuredClone(values))}}},
    alarms:{async clear(){},onAlarm:event('alarm')},
    runtime:{id:'test',onMessage:event('message'),onInstalled:event('installed'),onStartup:event('startup')},
    tabs:{async get(id){return {id,url}},async remove(id){if(removeFails)throw Error('closed');removed.push(id)}}
  };
  vm.runInNewContext(source,{chrome,DEFAULTS,URL,validate,nextRun,dayKey,clickAuthTarget,crypto,setTimeout,Date,Promise,Error});
  const command=(id,tabId)=>new Promise(resolve=>events.message({type:'finished',id,result:{ok:!error,error}},{id:'test',tab:{id:tabId}},resolve));
  assert.equal((await command('other',7)).ok,false);assert.equal((await command('run',8)).ok,false);
  assert.equal(removed.length,0,'other runs and tabs cannot close the owned tab');
  assert.equal((await command('run',7)).ok,true);
  await command('run',7);assert.equal(data.run,null);
  return {data,removed};
}

test('successful completion closes only the owned CRPT tab once, including query/fragment URLs',async()=>{
  for(const url of [URL,URL+'?org=2#token']) {
    const result=await finishCase({url});assert.deepEqual(result.removed,[7]);
    assert.equal(result.data.logs.at(-1).level,'success');assert.match(result.data.logs.at(-1).message,/Вкладка сценария закрыта/);
  }
});

test('failed runs, reused/unmarked tabs and manually changed addresses are preserved',async()=>{
  for(const config of [{error:'Step failed'},{createdTab:false},{createdTab:undefined},{url:'https://example.test/'},{url:'https://selsup.ru/application'},{url:URL+'/other'}]) {
    const result=await finishCase(config);
    assert.deepEqual(result.removed,[]);
  }
});

test('tab cleanup failure leaves a warning but preserves successful completion and releases the run',async()=>{
  const result=await finishCase({removeFails:true});
  assert.deepEqual(result.removed,[]);assert.equal(result.data.run,null);
  assert.equal(result.data.logs.some(l=>l.level==='warning'),true);
  assert.equal(result.data.logs.at(-1).level,'success');
});
