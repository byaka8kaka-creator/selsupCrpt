import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { DEFAULTS, URL, validate, nextRun, dayKey } from '../extension/common.js';

test('service worker: расписание, взаимная блокировка, журнал, остановка и восстановление', async () => {
  const data={}, alarms=new Map(), events={}; 
  const event=name=>({addListener(fn){events[name]=fn}});
  const chrome={
    storage:{local:{async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]]))},async set(values){Object.assign(data,structuredClone(values))}}},
    alarms:{async create(name,value){alarms.set(name,value)},async clear(name){return alarms.delete(name)},onAlarm:event('alarm')},
    runtime:{id:'test',onMessage:event('message'),onInstalled:event('installed'),onStartup:event('startup')},
    tabs:{async create(){return {id:1,url:URL,status:'complete'}},async get(){return {id:1,url:URL,status:'complete'}},async sendMessage(id,msg){if(msg.type==='execute')return {ok:true,started:true};return {ok:true}}},
    scripting:{async executeScript(){}}
  };
  const source=(await readFile('extension/background.js','utf8')).replace(/^import .*?;\n/,'');
  vm.runInNewContext(source,{chrome,DEFAULTS,URL,validate,nextRun,dayKey,crypto,setTimeout,Date,Promise,Error});
  const command=(type,extra={},sender={id:'test'})=>new Promise(r=>events.message({type,...extra},sender,r));
  const settle=()=>new Promise(r=>setTimeout(r,20));
  assert.equal((await command('save',{settings:{...DEFAULTS,enabled:true}})).ok,true);
  assert.ok(alarms.get('daily').when>Date.now());
  assert.equal((await command('start')).ok,true); await settle();
  assert.equal((await command('start')).ok,false);
  assert.ok(data.run.tabId===1);
  assert.equal((await command('progress',{id:data.run.id,message:'Шаг 1'},{id:'test',tab:{id:2}})).ok,false);
  assert.equal((await command('progress',{id:data.run.id,message:'Шаг 1'},{id:'test',tab:{id:1}})).ok,true);
  const checkpoint={pass:1,waitUntil:Date.now(),deadline:Date.now()+10000};
  assert.equal((await command('checkpoint',{id:data.run.id,resume:checkpoint},{id:'test',tab:{id:1}})).ok,true);
  assert.equal((await command('resume',{}, {id:'test',tab:{id:2}})).ok,false);
  const resumed=await command('resume',{}, {id:'test',tab:{id:1}});
  assert.equal(resumed.resume.pass,1); assert.equal(resumed.settings.time,DEFAULTS.time);
  await command('checkpoint',{id:data.run.id,resume:null},{id:'test',tab:{id:1}});
  assert.equal((await command('resume',{}, {id:'test',tab:{id:1}})).ok,false);
  const auth={deadline:Date.now()+10000,attempted:true,returning:false};
  assert.equal((await command('authCheckpoint',{id:data.run.id,auth},{id:'test',tab:{id:1}})).ok,true);
  const loginResume=await command('resume',{}, {id:'test',tab:{id:1}});
  assert.equal(loginResume.auth.attempted,true);assert.equal(loginResume.auth.deadline,auth.deadline);
  assert.equal(loginResume.resume,null);
  await command('authCheckpoint',{id:data.run.id,auth:null},{id:'test',tab:{id:1}});
  await command('finished',{id:data.run.id,result:{ok:true}},{id:'test',tab:{id:1}}); await settle();
  assert.equal(data.run,null); assert.equal(data.logs.at(-1).level,'success');
  events.alarm({name:'daily'}); await settle();
  assert.equal(data.lastScheduledDay,dayKey()); assert.ok(data.run); const previous=data.run.id;
  await command('stop'); await command('finished',{id:previous,result:{ok:true}},{id:'test',tab:{id:1}}); await settle();
  assert.equal(data.run,null); assert.equal(data.logs.at(-1).level,'error');
  events.alarm({name:'daily'}); await settle(); assert.equal(data.run,null);
  assert.equal((await command('start')).ok,true); await settle(); assert.notEqual(data.run.id,previous);
  data.run.heartbeat=Date.now()-100000;
  events.alarm({name:'watchdog'}); await settle(); assert.equal(data.run,null); assert.match(data.logs.at(-1).message,/Связь/);
  await settle();
  data.run={id:'old',heartbeat:0}; events.startup(); await settle();
  assert.equal(data.run,null); assert.match(data.logs.at(-1).message,/перезапуском/);
  await command('clear'); assert.equal(data.logs.length,0);
});
