import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { DEFAULTS, URL, validate, nextRun, dayKey } from '../extension/common.js';
import { clickAuthTarget } from '../extension/auth-debugger.js';

async function harness(initial={}) {
  let clock=new Date(2026,9,12,6,0).getTime(), tabs=0;
  class ClockDate extends Date {constructor(...args){super(...(args.length?args:[clock]))}static now(){return clock}}
  const data=structuredClone(initial), alarms=new Map(), events={};
  const event=name=>({addListener(fn){events[name]=fn}});
  const chrome={
    storage:{local:{async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(data[k])]))},async set(values){Object.assign(data,structuredClone(values))}}},
    alarms:{async create(name,value){alarms.set(name,value)},async clear(name){return alarms.delete(name)},onAlarm:event('alarm')},
    runtime:{id:'test',onMessage:event('message'),onInstalled:event('installed'),onStartup:event('startup')},
    tabs:{async create(){return {id:++tabs,url:URL,status:'complete'}},async get(id){return {id,url:URL,status:'complete'}},async sendMessage(){return {ok:true,started:true}}},
    scripting:{async executeScript(){}}
  };
  const source=(await readFile('extension/background.js','utf8')).replace(/^import .*?;\n/gm,'');
  const load=()=>vm.runInNewContext(source,{chrome,DEFAULTS,URL,validate,nextRun:time=>nextRun(time,new ClockDate()),dayKey:date=>dayKey(date||new ClockDate()),clickAuthTarget,crypto,setTimeout,Date:ClockDate,Promise,Error});
  load();
  const settle=()=>new Promise(r=>setTimeout(r,15));
  const command=(type,extra={},sender={id:'test'})=>new Promise(r=>events.message({type,...extra},sender,r));
  const alarm=async name=>{events.alarm({name});await settle()};
  const finish=async(ok=true)=>{const run=data.run;assert.ok(run);await command('finished',{id:run.id,result:{ok,error:ok?undefined:'test failure'}},{id:'test',tab:{id:run.tabId}})};
  return {data,alarms,command,alarm,finish,tabs:()=>tabs,setClock:(day,hour,minute=0)=>clock=new Date(2026,9,day,hour,minute).getTime(),restart:async()=>{load();events.startup();await settle()}};
}

test('second daily time validates and old settings keep a single schedule',()=>{
  const legacy={...DEFAULTS};delete legacy.time2;
  assert.equal(validate(legacy).time2,'');
  assert.equal(validate({...DEFAULTS,time2:'19:00'}).time2,'19:00');
  for(const time2 of ['25:00','7:00',DEFAULTS.time,null,123])assert.throws(()=>validate({...DEFAULTS,time2}));
});

test('two daily times: both execute on the same day, duplicate alarms and failed-run retries are blocked, restart preserves markers',async()=>{
  const h=await harness();
  await h.command('save',{settings:{...DEFAULTS,enabled:true,time:'07:00',time2:'19:00'}});
  assert.equal(h.alarms.get('daily').when,new Date(2026,9,12,7,0).getTime());
  assert.equal(h.alarms.get('daily2').when,new Date(2026,9,12,19,0).getTime());
  for(const day of [12,13]) {
    h.setClock(day,7);await h.alarm('daily');
    assert.equal(h.tabs(),(day-12)*2+1);
    assert.equal(h.data.run.settings.time2,'19:00');
    await h.alarm('daily');assert.equal(h.tabs(),(day-12)*2+1);
    await h.finish();
    h.setClock(day,19);await h.alarm('daily2');assert.equal(h.tabs(),(day-12)*2+2);
    assert.ok(h.data.logs.some(l=>l.message.includes('(19:00, второй запуск)')));
    await h.finish(false);await h.alarm('daily2');assert.equal(h.data.run,null);
    assert.equal(h.tabs(),(day-12)*2+2);
    assert.equal(h.alarms.get('daily').when,new Date(2026,9,day+1,7,0).getTime());
    assert.equal(h.alarms.get('daily2').when,new Date(2026,9,day+1,19,0).getTime());
    await h.restart();await h.alarm('daily');await h.alarm('daily2');assert.equal(h.data.run,null);
  }
});

test('second time is optional; clearing it or disabling schedule clears alarms and ignores stale events',async()=>{
  const h=await harness();
  const settings={...DEFAULTS,enabled:true,time2:'19:00'};
  await h.command('save',{settings});assert.ok(h.alarms.has('daily2'));
  await h.command('save',{settings:{...settings,time2:''}});
  assert.ok(h.alarms.has('daily'));assert.equal(h.alarms.has('daily2'),false);
  await h.alarm('daily2');assert.equal(h.tabs(),0);
  await h.command('save',{settings:{...settings,enabled:false}});
  assert.equal(h.alarms.has('daily'),false);assert.equal(h.alarms.has('daily2'),false);
  await h.alarm('daily');await h.alarm('daily2');assert.equal(h.tabs(),0);
});

test('legacy daily marker blocks the first time, but allows the new second time',async()=>{
  const day=dayKey(new Date(2026,9,12));
  const h=await harness({lastScheduledDay:day});
  await h.command('save',{settings:{...DEFAULTS,enabled:true,time2:'19:00'}});
  h.setClock(12,7);await h.alarm('daily');assert.equal(h.tabs(),0);
  h.setClock(12,19);await h.alarm('daily2');assert.equal(h.tabs(),1);
  assert.deepEqual(h.data.lastScheduledRuns,{'07:00':day,'19:00':day});
  await h.finish();await h.alarm('daily');assert.equal(h.tabs(),1);
});

test('overlapping second run is logged and consumed once without opening another tab',async()=>{
  const h=await harness();
  await h.command('save',{settings:{...DEFAULTS,enabled:true,time2:'07:01'}});
  h.setClock(12,7);await h.alarm('daily');const id=h.data.run.id;
  h.setClock(12,7,1);await h.alarm('daily2');
  assert.equal(h.data.run.id,id);assert.equal(h.tabs(),1);
  assert.ok(h.data.logs.some(l=>l.message.includes('07:01 пропущен: сценарий уже выполняется')));
  await h.finish();await h.alarm('daily2');assert.equal(h.data.run,null);assert.equal(h.tabs(),1);
});

test('schedule edits preserve today\'s used times even when a time is temporarily removed',async()=>{
  const h=await harness();
  await h.command('save',{settings:{...DEFAULTS,enabled:true}});
  h.setClock(12,7);await h.alarm('daily');await h.finish();
  await h.command('save',{settings:{...DEFAULTS,enabled:true,time:'08:00'}});
  h.setClock(12,8);await h.alarm('daily');await h.finish();
  await h.command('save',{settings:{...DEFAULTS,enabled:true,time:'08:00',time2:'07:00'}});
  await h.alarm('daily2');assert.equal(h.tabs(),2);assert.equal(h.data.run,null);
});
