import test from 'node:test';
import assert from 'node:assert/strict';
import { JobManager, validateJob } from '../src/jobs.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const base = { model:'provider/gpt',api:'chat_completions',count:3,parallel:2,repeat:2,strict:true,stream:false };
const gateway = { url:'http://127.0.0.1:3425/v1',key:'top-secret-key' };
const sample = {state:'complete',count:300,expected_count:300,error:null,response_model:'gpt'};
function mockDetector() {
  const calls=[];
  return {calls,detector:{builtAt:'2026-10-25',async detect(config,{signal,onSample}){
    calls.push(config);
    for(let i=0;i<config.count;i++) onSample(i,{state:'queued',count:0,expected_count:300});
    for(let i=0;i<config.count;i++) onSample(i,{state:'waiting',count:0,expected_count:300});
    await sleep(10);
    if (signal.aborted) return {samples:[],analysis:null,error:'Cancelled'};
    for(let i=0;i<config.count;i++) {
      onSample(i,{state:'streaming',count:200,expected_count:300,first_byte_ms:15});
      onSample(i,{...sample,first_byte_ms:15});
    }
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

test('live callbacks report bounded sample progress without leaking replies or Gateway keys',async()=>{
  let entered, release;
  const inProgress = new Promise(resolve=>{entered=resolve});
  const proceed = new Promise(resolve=>{release=resolve});
  const jobs = new JobManager(async()=>({builtAt:'test',async detect(config,{signal,onSample}){
    assert.equal(typeof onSample,'function');
    assert.ok(signal instanceof AbortSignal);
    onSample(0,{state:'queued',count:0,expected_count:300});
    onSample(1,{state:'queued',count:0,expected_count:301});
    onSample(0,{state:'waiting',count:0,expected_count:300});
    onSample(0,{state:'streaming',count:145,expected_count:300,first_byte_ms:18.25,
      text:'private model reply 123',raw_text:'never return this',error:'Gateway top-secret-key'});
    entered();
    await proceed;
    onSample(0,{...sample,first_byte_ms:18.25});
    onSample(1,{...sample,expected_count:301,first_byte_ms:22});
    return {samples:[sample,{...sample,expected_count:301}],analysis:{decision:'partial',results:[]},error:null};
  }}));
  const j = await jobs.start({...base,count:2,strict:false,repeat:1},gateway,['provider/gpt']);
  await inProgress;
  const running = jobs.get(j.jobId);
  assert.equal(running.round,1);
  assert.equal(running.completed,0);
  assert.equal(running.currentSamples.length,2);
  assert.equal(running.currentSamples[0].state,'streaming');
  assert.equal(running.currentSamples[0].count,145);
  assert.equal(running.currentSamples[0].firstByteMs,18.25);
  assert.equal(running.currentSamples[1].state,'queued');
  assert.match(running.currentSamples[0].error,/\[REDACTED\]/);
  assert.equal(JSON.stringify(running).includes('private model reply'),false);
  assert.equal(JSON.stringify(running).includes('never return this'),false);
  assert.equal(JSON.stringify(running).includes(gateway.key),false);
  release();
  for(let i=0;i<30 && jobs.get(j.jobId).state==='running';i++)await sleep(10);
  const finished=jobs.get(j.jobId);
  assert.equal(finished.state,'done');
  assert.equal(finished.completed,2);
  assert.deepEqual(finished.currentSamples,[]);
  assert.equal(finished.rounds[0].samples[1].expectedCount,301);
});

test('cancellation freezes live status and ignores late sample callbacks',async()=>{
  let entered, release;
  const ready=new Promise(resolve=>{entered=resolve});
  const gate=new Promise(resolve=>{release=resolve});
  const jobs=new JobManager(async()=>({builtAt:'test',async detect(config,{onSample}){
    onSample(0,{state:'waiting',count:0,expected_count:300});
    entered();
    await gate;
    onSample(0,{...sample}); // late callback must not resurrect cancelled state
    return {samples:[sample],analysis:{decision:'scored'},error:null};
  }}));
  const j=await jobs.start({...base,count:1,strict:false,repeat:2},gateway,['provider/gpt']);
  await ready;
  const cancelled=jobs.cancel(j.jobId);
  assert.equal(cancelled.state,'cancelled');
  assert.equal(cancelled.currentSamples[0].state,'cancelled');
  release();
  await sleep(10);
  assert.equal(jobs.get(j.jobId).state,'cancelled');
  assert.equal(jobs.get(j.jobId).rounds.length,0);
});
