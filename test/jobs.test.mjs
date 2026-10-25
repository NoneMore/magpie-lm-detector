import test from 'node:test';
import assert from 'node:assert/strict';
import { JobManager, validateJob } from '../src/jobs.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const base = { model:'provider/gpt',api:'chat_completions',count:3,parallel:2,repeat:2,strict:true,stream:false };
const gateway = { url:'http://127.0.0.1:3425/v1',key:'top-secret-key' };
const sample = {state:'complete',count:300,expected_count:300,error:null,response_model:'gpt'};
function mockDetector() {
  const calls=[];
  return {calls,detector:{builtAt:'2026-10-25',async detect(config,signal){
    calls.push(config);
    await sleep(10);
    if (signal.aborted) return {samples:[],analysis:null,error:'Cancelled'};
    return {samples:[sample,sample,sample], analysis:{decision:'scored',prediction:'gpt',results:[{model:'gpt',score:1}]},error:null};
  }}};
}

test('validate parameters and reject groups and invalid strict mode',()=>{
  assert.equal(validateJob(base).repeat,2);
  assert.throws(()=>validateJob({...base,count:1,strict:true}),/严格/);
  assert.throws(()=>validateJob({...base,model:'group/x'}),/具体/);
  assert.throws(()=>validateJob({...base,timeout:1000}),/timeout/);
  assert.throws(()=>validateJob({...base,repeat:21}),/repeat/);
  assert.throws(()=>validateJob({...base,effort:'low\nhigh'}),/推理/);
  assert.equal(validateJob({...base,parallel:3,count:1,strict:false}).parallel,1);
});

test('multi-round SDK detection uses stable Gateway, strict, options and returns safe state',async()=>{
  const fake = mockDetector();
  const jobs = new JobManager(async()=>fake.detector);
  const j = await jobs.start(base,gateway,['provider/gpt']);
  assert.equal(j.state,'running');
  for(let i=0;i<30;i++){if(jobs.get(j.jobId).state!=='running')break;await sleep(10)}
  const result=jobs.get(j.jobId);
  assert.equal(result.state,'done');
  assert.equal(result.completed,6);
  assert.equal(result.rounds.length,2);
  assert.equal(result.rounds[0].analysis.decision,'scored');
  assert.equal(fake.calls.length,2);
  assert.equal(fake.calls[0].api,'chat_completions');
  assert.equal(fake.calls[0].strict,true);
  assert.equal(fake.calls[0].stream,false);
  assert.equal(fake.calls[0].apiKey,gateway.key);
  assert.equal(JSON.stringify(result).includes(gateway.key),false);
});

test('cancelling a running SDK detection stops subsequent rounds and accepts missing result',async()=>{
  const fake = mockDetector();
  const jobs = new JobManager(async()=>fake.detector);
  const first = await jobs.start({...base,repeat:20},gateway,['provider/gpt']);
  const canceled=jobs.cancel(first.jobId);
  assert.equal(canceled.state,'cancelled');
  await sleep(35);
  assert.equal(jobs.get(first.jobId).state,'cancelled');
  assert.equal(fake.calls.length,0);
  assert.throws(()=>jobs.get('unknown'),/任务不存在/);
});

test('limit parallel jobs to two', async()=>{
  let release;
  const blocker = new Promise(r=>{release=r});
  const jobs=new JobManager(async()=>({builtAt:'today',detect:async()=>{await blocker;return {samples:[sample],analysis:null,error:'not found'}}}));
  const a=await jobs.start({...base,count:1,strict:false,repeat:1},gateway,['provider/gpt']);
  const b=await jobs.start({...base,count:1,strict:false,repeat:1},gateway,['provider/gpt']);
  await assert.rejects(()=>jobs.start(base,gateway,['provider/gpt']),/两个/);
  jobs.cancel(a.jobId);jobs.cancel(b.jobId);release();
});
