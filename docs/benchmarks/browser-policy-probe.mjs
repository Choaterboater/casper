// Exploratory agent-browser confirmation probe. Synthetic localhost effects only.
// Usage: node docs/benchmarks/browser-policy-probe.mjs <isolated package directory>
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
const exec=promisify(execFile), root=path.resolve(process.argv[2]);
const dir=await mkdtemp(path.join(root,'policy-')), sockets=await mkdtemp('/tmp/cap-');
await mkdir(path.join(dir,'home'));await mkdir(path.join(dir,'tmp'));await writeFile(path.join(dir,'config.json'),'{}');
const env={PATH:process.env.PATH,HOME:path.join(dir,'home'),TMPDIR:path.join(dir,'tmp'),AGENT_BROWSER_SOCKET_DIR:sockets};
const flags=['--json','--session','p','--namespace','p','--config',path.join(dir,'config.json'),'--profile',path.join(dir,'profile'),
  '--executable-path','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','--idle-timeout','10s','--no-webmcp','--confirm-actions','click'];
const binary=path.join(root,'node_modules/agent-browser/bin/agent-browser-darwin-arm64');
const results={directory:dir,calls:[]};
async function command(...args){let r;try{r=await exec(binary,[...flags,...args],{env,cwd:dir,timeout:15000,maxBuffer:1024*1024})}catch(e){r={stdout:e.stdout,stderr:e.stderr,error:String(e)}}
  const data=JSON.parse(r.stdout);results.calls.push({args,...r,parsed:data});return data;}
let effects=0;
const server=createServer((req,res)=>{if(req.url==='/effect'){effects++;res.end('ok')}else{res.setHeader('Content-Type','text/html');res.end('<button id="effect" onclick="fetch(\'/effect\',{method:\'POST\'})">Synthetic send</button>')}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const wait=()=>new Promise(r=>setTimeout(r,150));
try{
  await command('open',`http://127.0.0.1:${server.address().port}`);
  const pending=await command('click','#effect');await wait();results.effectsBeforeApproval=effects;assert.equal(effects,0);
  await writeFile(path.join(root,'policy-probe.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(pending));
  const id=pending.data?.confirmation_id ?? pending.data?.confirmationId;
  if(!id)throw new Error('Inspect pending confirmation envelope before proceeding');
  await command('deny',id);await wait();results.effectsAfterDenial=effects;assert.equal(effects,0);
  const second=await command('click','#effect');const next=second.data?.confirmation_id ?? second.data?.confirmationId;
  assert(next);await command('confirm',next);await wait();results.effectsAfterApproval=effects;assert.equal(effects,1);
  results.passed=true;
}catch(error){results.error=String(error);console.error(error)}
finally{
  await command('close');await wait();
  results.socketFiles=await readdir(sockets);await rm(sockets,{recursive:true,force:true});
  server.closeAllConnections();await new Promise(r=>server.close(r));
  await writeFile(path.join(root,'policy-probe.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({passed:results.passed,error:results.error,effectsBeforeApproval:results.effectsBeforeApproval,effectsAfterDenial:results.effectsAfterDenial,effectsAfterApproval:results.effectsAfterApproval}));
}
