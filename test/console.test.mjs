import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startConsole } from '../src/console.mjs';

const samples = Array.from({length:3}, (_,i) => ({state:'complete',count:300,expected_count:300,error:null,response_model:'gpt'}));
const fakeDetector = { builtAt:'test-reference', async detect(config){return {samples,analysis:{decision:'scored',prediction:'gpt',prediction_name:'GPT',used_outputs:3,results:[{model:'gpt',display_name:'GPT',score:1,probability:.9}]},error:null}} };

test('browser console enforces one-use links, sessions, CSRF, and never exposes Gateway key', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'magpie-detector-test-'));
  const fakeFetch=async url=>{
    assert.equal(url,'http://127.0.0.1:3425/v1/models');
    return new Response(JSON.stringify({data:[{id:'demo/gpt'}]}),{headers:{'Content-Type':'application/json'}});
  };
  const instance=await startConsole({dataDir:dir,detectorLoader:async()=>fakeDetector,fetcher:fakeFetch,
    gatewayURL:'http://127.0.0.1:3425',gatewayKey:'test-key'});
  t.after(async()=>{instance.close();await rm(dir,{recursive:true,force:true})});
  const origin=instance.origin;
  const ticket=instance.issueURL();
  let res=await fetch(origin+'/');assert.equal(res.status,401);
  res=await fetch(ticket,{redirect:'manual'});assert.equal(res.status,303);
  const cookie=res.headers.get('set-cookie').split(';')[0];
  const headers={Cookie:cookie,Origin:origin,'X-LMFPD-Console':'1','Content-Type':'application/json'};
  assert.match(res.headers.get('set-cookie'),/HttpOnly/);
  res=await fetch(ticket,{redirect:'manual'});assert.equal(res.status,401);
  res=await fetch(origin+'/',{headers});assert.equal(res.status,200);assert.match(await res.text(),/模型指纹检测/);
  res=await fetch(origin+'/app.js',{headers});assert.equal(res.status,200);assert.match(await res.text(),/LMFPD-Console/);
  res=await fetch(origin+'/api/state',{headers});assert.equal(res.status,200);
  let state=await res.json();assert.equal(JSON.stringify(state).includes('test-key'),false);
  res=await fetch(origin+'/api/config',{method:'POST',headers:{...headers,Origin:'http://other.example'},body:JSON.stringify({gatewayUrl:'http://127.0.0.1:3425',gatewayKey:'secret-from-user'})});
  assert.equal(res.status,403);
  res=await fetch(origin+'/api/config',{method:'POST',headers,body:JSON.stringify({gatewayUrl:'http://127.0.0.1:3425',gatewayKey:'secret-from-user'})});
  assert.equal(res.status,200);
  const body=await res.json();assert.equal(body.config.hasGatewayKey,true);
  assert.equal(JSON.stringify(body).includes('secret-from-user'),false);
  const local=await readFile(path.join(dir,'config.json'),'utf8');assert.match(local,/secret-from-user/);
  res=await fetch(origin+'/api/models',{headers});assert.equal(res.status,200);assert.deepEqual((await res.json()).models,['demo/gpt']);
  res=await fetch(origin+'/api/jobs',{method:'POST',headers,body:JSON.stringify({model:'demo/gpt',repeat:2})});
  assert.equal(res.status,202);
  let job=await res.json();
  for(let i=0;i<30;i++){
    res=await fetch(origin+'/api/jobs/'+job.jobId,{headers});job=await res.json();
    if(job.state!=='running')break;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(job.state,'done');assert.equal(job.rounds.length,2);
  assert.equal(JSON.stringify(job).includes('secret-from-user'),false);
  res=await fetch(origin+'/api/reference',{headers});assert.equal(res.status,200);assert.deepEqual(await res.json(),{builtAt:'test-reference'});
  res=await fetch(origin+'/api/state',{headers});state=await res.json();assert.equal(state.jobs.length,1);
  res=await fetch(origin+'/api/config',{method:'POST',headers,body:JSON.stringify({gatewayUrl:'https://remote.example.com/v1',gatewayKey:''})});
  assert.equal(res.status,200); // key intentionally reuses the stored user-supplied key
  res=await fetch(origin+'/api/config',{method:'POST',headers,body:JSON.stringify({gatewayUrl:'http://remote.example.com',gatewayKey:'remote-key'})});
  assert.equal(res.status,400);
});
