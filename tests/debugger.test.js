import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { DEFAULTS, URL, validate, nextRun, dayKey } from '../extension/common.js';
import { clickAuthTarget } from '../extension/auth-debugger.js';
const token='12345678-1234-1234-1234-123456789abc';

async function harness(overrides={}) {
  const events={}, calls=[];
  const data={run:{id:'run',tabId:1,heartbeat:Date.now(),auth:{deadline:Date.now()+60000,attempted:false,returning:false}}};
  const event=name=>({addListener(fn){events[name]=fn}});
  const chrome={
    storage:{local:{async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(data[k])]))},async set(values){Object.assign(data,structuredClone(values))}}},
    alarms:{async create(){},async clear(){},onAlarm:event('alarm')},
    runtime:{id:'test',onMessage:event('message'),onInstalled:event('installed'),onStartup:event('startup')},
    tabs:{async get(){return {id:1,url:data.url||URL}},async update(){calls.push({method:'activate'})},async sendMessage(){if(overrides.stop)return overrides.stop();return {ok:true}}},
    scripting:{async executeScript(){calls.push({method:'locate'});if(overrides.locate)return overrides.locate(data,calls);return [{result:{x:40,y:50}}]}},
    debugger:{
      async attach(){calls.push({method:'attach'});if(overrides.attach)await overrides.attach(data,calls)},
      async sendCommand(_,method,params){calls.push({method,...params});if(overrides.send)await overrides.send(params,data,calls)},
      async detach(){calls.push({method:'detach'});if(overrides.detach)await overrides.detach(data,calls)}
    }
  };
  const source=(await readFile('extension/background.js','utf8')).replace(/^import .*?;\n/gm,'');
  vm.runInNewContext(source,{chrome,DEFAULTS,URL,validate,nextRun,dayKey,clickAuthTarget,crypto,setTimeout,Date,Promise,Error});
  const sender={id:'test',tab:{id:1},frameId:0,url:URL};
  const command=(msg,from=sender)=>new Promise(r=>events.message(msg,from,r));
  const click=(extra={},from=sender)=>command({type:'authClick',id:'run',action:'heading',token,...extra},from);
  return {data,calls,command,click,sender};
}

test('debugger: only active top-frame SelSup login actions, reserved once',async()=>{
  const h=await harness();
  for(const sender of [ {...h.sender,id:'foreign'}, {...h.sender,tab:{id:2}}, {...h.sender,frameId:1}, {...h.sender,url:'https://selsup.ru.evil.test/'}, {id:'test'} ]) {
    assert.equal((await h.click({},sender)).ok,false);
  }
  for(const extra of [{id:'other'},{action:'arbitrary'},{token:'[invalid]'},{action:'login'}])assert.equal((await h.click(extra)).ok,false);
  assert.equal(h.calls.length,0,'unauthorized requests never attach or activate a tab');
  assert.equal((await h.click()).ok,true);
  assert.equal(h.data.run.authClicks.heading,true);
  assert.deepEqual(h.calls.filter(c=>c.method==='Input.dispatchMouseEvent').map(c=>c.type),['mouseMoved','mousePressed','mouseReleased']);
  assert.equal(h.calls.filter(c=>c.method==='attach').length,1);assert.equal(h.calls.at(-1).method,'detach');
  const count=h.calls.length;
  assert.equal((await h.click()).ok,false);assert.equal(h.calls.length,count,'no duplicate heading click');
  h.data.run.auth.attempted=true;
  assert.equal((await h.click({action:'login'})).ok,true);
  assert.equal((await h.click({action:'login'})).ok,false);
  assert.equal(h.calls.filter(c=>c.method==='attach').length,2);
});

test('debugger: attach refusal, CDP failure, layout change and origin change clean up without retry',async()=>{
  for(const failure of ['attach','locate','press','moved','origin']) {
    let locations=0;
    const h=await harness({
      attach(){if(failure==='attach')throw Error('busy')},
      locate(data){locations++;if(failure==='locate')throw Error('target vanished');if(failure==='origin')data.url='https://example.test/';return [{result:{x:failure==='moved'&&locations===2?100:40,y:50}}]},
      send(params){if(failure==='press'&&params.type==='mousePressed')throw Error('detached')}
    });
    const result=await h.click();assert.equal(result.ok,false,failure);
    if(failure==='attach'){assert.match(result.error,/DevTools/);assert.equal(h.calls.some(c=>c.method==='detach'),false,'do not detach another debugger');}
    else assert.equal(h.calls.at(-1).method,'detach',failure);
    assert.equal(h.calls.filter(c=>c.type==='mouseReleased'&&c.x===40).length,0,'no Login/heading click on a failed operation');
  }
});

test('debugger: Stop can finish a run while attach is pending; no mouse press follows',async()=>{
  let resolveAttach;
  const pending=new Promise(r=>resolveAttach=r);
  const h=await harness({attach:()=>pending});
  const click=h.click();
  while(!h.calls.some(c=>c.method==='attach'))await new Promise(r=>setTimeout(r,1));
  assert.equal((await h.command({type:'stop'},{id:'test'})).ok,true);
  assert.equal(h.data.run,null);
  resolveAttach();
  assert.equal((await click).ok,false);
  assert.equal(h.calls.some(c=>c.type==='mousePressed'),false);
  assert.equal(h.calls.at(-1).method,'detach');
});

test('debugger: cancellation after mouse down releases outside the button and detaches',async()=>{
  const h=await harness({send(params,data){if(params.type==='mousePressed')data.run=null}});
  assert.equal((await h.click()).ok,false);
  const release=h.calls.find(c=>c.type==='mouseReleased');assert.equal(release.x,-1);assert.equal(release.y,-1);
  assert.equal(h.calls.at(-1).method,'detach');
});

test('debugger: Stop cancels clicks immediately even while the tab Stop response is pending',async()=>{
  let resolveAttach,resolveStop;
  const attach=new Promise(r=>resolveAttach=r),stop=new Promise(r=>resolveStop=r);
  const h=await harness({attach:()=>attach,stop:()=>stop});
  const click=h.click();
  while(!h.calls.some(c=>c.method==='attach'))await new Promise(r=>setTimeout(r,1));
  const stopping=h.command({type:'stop'},{id:'test'});
  resolveAttach();
  assert.equal((await click).ok,false);
  assert.ok(h.data.run,'run cleanup is still waiting for the tab');
  assert.equal(h.calls.some(c=>c.type==='mousePressed'),false);
  assert.equal(h.calls.at(-1).method,'detach');
  resolveStop({ok:true});assert.equal((await stopping).ok,true);assert.equal(h.data.run,null);
});
