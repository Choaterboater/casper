// EXPLORATORY COMPARISON ONLY — not Casper production code or an acceptance gate.
// Usage: node docs/benchmarks/browser-compare.mjs <isolated-installed-package-dir> [repetitions]
// Installs nothing. Requires pinned candidates already installed in the supplied directory.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const root = path.resolve(process.argv[2]);
const repetitions = Number(process.argv[3] || 1);
const require = createRequire(path.join(root, 'package.json'));
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const { default: puppeteer } = await load('puppeteer-core');
const { Client } = await load('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await load('@modelcontextprotocol/sdk/client/stdio.js');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const agent = path.join(root, 'node_modules/agent-browser/bin/agent-browser-darwin-arm64');
const mcp = path.join(root, 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js');
const node = '/opt/homebrew/bin/node';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const envFor = (dir) => ({ PATH: process.env.PATH, HOME: path.join(dir, 'home'), TMPDIR: path.join(dir, 'tmp'),
  CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
  AGENT_BROWSER_NO_WEBMCP: '1', AGENT_BROWSER_DEFAULT_TIMEOUT: '2000' });
const metricsExpression = `JSON.stringify({status:document.querySelector('#status').textContent,
  viewport:innerWidth, width:document.documentElement.scrollWidth, crossOriginLoaded:window.crossOriginLoaded===true,
  syntheticSecret:document.cookie.includes('synthetic_fixture_cookie'), pageUrl:location.href})`;
const servers = [];
async function serve(handler) {
  const server = createServer(handler); servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const resourceURL = await serve((req, res) => { res.setHeader('Content-Type', 'text/javascript'); res.end('window.crossOriginLoaded=true;'); });
const fixtureFile = path.join(root, 'fixture.html');
const url = await serve(async (req, res) => {
  if (req.url.startsWith('/broken-api')) { res.writeHead(503, {'Content-Type':'text/plain'}); res.end('synthetic upstream failure'); return; }
  if (req.url.startsWith('/effect')) { effects++; res.end('effect recorded'); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', 'synthetic_fixture_cookie=FAKE_TEST_COOKIE; SameSite=Lax');
  res.setHeader('Content-Type', 'text/html'); res.end(await readFile(fixtureFile));
});
let effects = 0;
function html(fixed) { return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Casper comparison fixture</title>
<style>body{font:18px system-ui;margin:16px}main{width:${fixed ? '100%' : '900px'};background:#e5edff;padding:12px;box-sizing:border-box}button,input{font:inherit}#status{margin-top:16px}</style></head>
<body><main><h1>Local debugging fixture</h1><label>Name <input id="name" aria-label="Name"></label><button id="save">Save</button><div id="status" role="status">Not saved</div>
<button id="effect">Send message (synthetic)</button></main><script src="${resourceURL}/resource.js"></script>
<script>document.querySelector('#save').onclick=()=>document.querySelector('#status').textContent=${fixed ? "'Saved '+document.querySelector('#name').value" : "'Still broken'"};
document.querySelector('#effect').onclick=()=>fetch('/effect',{method:'POST'});
console.error('fixture-console-failure');fetch('/broken-api');setTimeout(()=>{throw new Error('fixture-uncaught-failure')},10);</script></body></html>`; }
const results = { runtime: process.versions, packages: {}, fixture: 'Synthetic interaction + mobile overflow + console/503 + second localhost resource origin',
  limitations: ['Not a live-agent or Casper integration test', 'No token/cost benchmark', 'No production credentials', 'Read-only page evaluation is harness-authored, not model supplied'], trials: [] };
for (const pkg of ['puppeteer-core','chrome-devtools-mcp','agent-browser']) results.packages[pkg] = JSON.parse(await readFile(path.join(root,'node_modules',pkg,'package.json'),'utf8')).version;
async function processes(dir) {
  const { stdout } = await exec('ps', ['-axo','pid=,ppid=,command=']);
  return stdout.split('\n').filter(line => line.includes(dir) && !line.includes('ps -axo')).map(line => ({pid:Number(line.trim().split(/\s+/)[0]), command:line.trim()}));
}
async function initialize(kind, dir, sample) {
  for (const sub of ['home','tmp']) await mkdir(path.join(dir,sub),{recursive:true});
  const env = envFor(dir);
  sample.operations = [];
  const measure = async (name, action) => {
    const start = performance.now();
    try { const value=await action(); sample.operations.push({ name, ms:performance.now()-start, bytes:Buffer.byteLength(JSON.stringify(value) ?? '') }); return value; }
    catch(error) { sample.operations.push({name,ms:performance.now()-start,error:String(error)}); throw error; }
  };
  if (kind === 'puppeteer') {
    let browser, page; const logs=[], networks=[];
    return {
      async open(target) { await measure('launch+open',async()=> {
        browser=await puppeteer.launch({executablePath:chrome,headless:true,userDataDir:path.join(dir,'profile'),env,timeout:15000});
        page=await browser.newPage(); await page.setViewport({width:375,height:700});
        page.on('console',m=>logs.push({type:m.type(),text:m.text()})); page.on('pageerror',e=>logs.push({type:'exception',text:String(e)}));
        page.on('response',r=>networks.push({url:r.url(),status:r.status()}));
        await page.goto(target,{waitUntil:'load',timeout:10000}); return {pid:browser.process().pid}; }); },
      inspect:()=>measure('inspect',()=>page.locator('body').waitHandle().then(async h=>{try{return await h.evaluate(el=>el.innerText)}finally{await h.dispose()}})),
      interact:()=>measure('fill+click',async()=>{await page.locator('#name').fill('Ada');await page.locator('#save').click();return {done:true}}),
      metrics:()=>measure('metrics',async()=>JSON.parse(await page.evaluate(metricsExpression))),
      screenshot:file=>measure('screenshot',async()=>{await page.screenshot({path:file});return {file}}),
      diagnostics:()=>measure('diagnostics',async()=>structuredClone({console:logs,network:networks})),
      reload:()=>measure('reload',async()=>{await page.reload({waitUntil:'load'});return {done:true}}),
      timeout:()=>measure('missing-element',async()=>{try{await page.locator('#missing').setTimeout(600).click();return {timedOut:false}}catch(e){return {timedOut:true,error:String(e)}}}),
      async close(){await measure('close',async()=>{await browser?.close();return {closed:true}})},
      crash:()=>{browser.process().kill('SIGKILL')},
    };
  }
  if(kind==='mcp') {
    let pageId; const client=new Client({name:'casper-browser-comparison',version:'0.0.0'});
    const transport=new StdioClientTransport({command:node,args:[mcp,'--headless','--isolated',`--executable-path=${chrome}`,
      '--no-usage-statistics','--no-performance-crux','--redact-network-headers','--viewport=375x700',`--filesystem-root=${dir}`],env,cwd:dir,stderr:'pipe'});
    let stderr=''; const call=async(name,args={})=>{
      const value=await client.callTool({name,arguments:pageId===undefined?args:{pageId,...args}},undefined,{timeout:15000});
      if(value.isError)throw new Error(JSON.stringify(value)); return value;
    };
    const text = value => value.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n') || '';
    return {
      async open(target){await measure('launch+open',async()=>{await client.connect(transport);transport.stderr?.on('data',chunk=>{stderr+=chunk});
        const tools=await client.listTools(); await writeFile(path.join(dir,'tools.json'),JSON.stringify(tools,null,2));
        const result=await call('new_page',{url:target});await writeFile(path.join(dir,'open.json'),JSON.stringify(result,null,2));
        const match=text(result).match(/(?:^|\n)(\d+):.*\[selected\]/);if(!match)throw new Error('Cannot parse page ID: '+text(result));pageId=Number(match[1]);
        await call('emulate',{viewport:'375x700x1'});return result;})},
      inspect:()=>measure('inspect',()=>call('take_snapshot')),
      interact:()=>measure('fill+click',async()=>{const snap=text(await call('take_snapshot'));const input=snap.match(/uid=([^\s]+) textbox "Name"/);const button=snap.match(/uid=([^\s]+) button "Save"/);
        if(!input||!button)throw new Error('Missing fixture refs: '+snap);
        await call('fill',{uid:input[1],value:'Ada'});return call('click',{uid:button[1]});}),
      metrics:()=>measure('metrics',async()=>{const value=await call('evaluate_script',{function:`() => ${metricsExpression}`,waitForStableDom:false});
        const body=text(value);const match=body.match(/```json\s*([\s\S]*?)\s*```/);if(!match)throw new Error('Unknown eval envelope '+body);
        const parsed=JSON.parse(match[1]);return typeof parsed==='string'?JSON.parse(parsed):parsed;}),
      screenshot:file=>measure('screenshot',()=>call('take_screenshot',{filePath:file})),
      diagnostics:()=>measure('diagnostics',async()=>({console:await call('list_console_messages',{pageSize:10,includeStackTraces:true}),network:await call('list_network_requests',{pageSize:10})})),
      reload:()=>measure('reload',()=>call('navigate_page',{type:'reload',ignoreCache:true})),
      timeout:()=>measure('missing-element',async()=>{const v=await client.callTool({name:'wait_for',arguments:{pageId,text:['NO_SUCH_FIXTURE_TEXT'],timeout:600}},undefined,{timeout:5000});return {timedOut:v.isError===true,result:v}}),
      async close(){await measure('close',async()=>{await client.close();await writeFile(path.join(dir,'stderr.log'),stderr);return {closed:true}})},
      crash:async()=>{ const ps=await processes(dir);const main=ps.find(p=>p.command.includes('Google Chrome')&&p.command.includes('--user-data-dir')&&!p.command.includes('--type='));if(!main)throw new Error('No owned Chrome PID');process.kill(main.pid,'SIGKILL');},
    };
  }
  const socketDir=await mkdtemp('/tmp/cab-'); env.AGENT_BROWSER_SOCKET_DIR=socketDir; sample.socketDir=socketDir;
  await writeFile(path.join(dir,'agent-browser.json'),'{}');
  const flags=['--json','--session','comparison','--namespace',path.basename(dir),'--config',path.join(dir,'agent-browser.json'),
    '--executable-path',chrome,'--profile',path.join(dir,'profile'),'--idle-timeout','15s','--no-webmcp'];
  const cmd=async(args)=>{let r;try{r=await exec(agent,[...flags,...args],{env,cwd:dir,timeout:15000,maxBuffer:2*1024*1024})}catch(error){throw new Error(`${error}\nstdout: ${error.stdout}\nstderr: ${error.stderr}`)}const parsed=JSON.parse(r.stdout);if(!parsed.success)throw new Error(r.stdout);return parsed;};
  return {
    async open(target){await measure('launch+open',async()=>{const value=await cmd(['open',target]);await cmd(['set','viewport','375','700']);return value})},
    inspect:()=>measure('inspect',()=>cmd(['snapshot','-i'])),
    interact:()=>measure('fill+click',async()=>{await cmd(['fill','#name','Ada']);return cmd(['click','#save'])}),
    metrics:()=>measure('metrics',async()=>{const v=await cmd(['eval',metricsExpression]);return typeof v.data.result==='string'?JSON.parse(v.data.result):v.data.result}),
    screenshot:file=>measure('screenshot',()=>cmd(['screenshot',file])),
    diagnostics:()=>measure('diagnostics',async()=>({console:await cmd(['console']),exceptions:await cmd(['errors']),network:await cmd(['network','requests'])})),
    reload:()=>measure('reload',()=>cmd(['reload'])),
    timeout:()=>measure('missing-element',async()=>{try{const v=await cmd(['click','#missing']);return {timedOut:false,result:v}}catch(error){return {timedOut:true,error:String(error)}}}),
    async close(){await measure('close',()=>cmd(['close']));await rm(socketDir,{recursive:true,force:true})},
    crash:async()=>{const ps=await processes(dir);const main=ps.find(p=>p.command.includes('Google Chrome')&&p.command.includes('--user-data-dir')&&!p.command.includes('--type='));if(!main)throw new Error('No owned Chrome PID');process.kill(main.pid,'SIGKILL');},
  };
}
try {
  for(let repeat=0;repeat<repetitions;repeat++) for(const kind of [...['puppeteer','mcp','agent-browser'].slice(repeat%3),...['puppeteer','mcp','agent-browser'].slice(0,repeat%3)]) {
    const dir=path.join(root,`${kind}-${Date.now()}`);await mkdir(dir,{recursive:true});const trial={kind,repeat,dir};results.trials.push(trial);
    let browser;
    try {
      await writeFile(fixtureFile,html(false));browser=await initialize(kind,dir,trial);await browser.open(url);await sleep(150);
      trial.observation=await browser.inspect();await browser.interact();trial.before=await browser.metrics();
      assert.equal(trial.before.status,'Still broken');assert.equal(trial.before.viewport,375);assert(trial.before.width>375);assert.equal(trial.before.crossOriginLoaded,true);
      await browser.screenshot(path.join(dir,'before.png'));trial.diagnostics=await browser.diagnostics();
      assert(JSON.stringify(trial.diagnostics).includes('fixture-console-failure'));assert(JSON.stringify(trial.diagnostics).includes('503'));
      await writeFile(fixtureFile,html(true));await browser.reload();await browser.interact();trial.after=await browser.metrics();
      assert.equal(trial.after.status,'Saved Ada');assert.equal(trial.after.viewport,375);assert.equal(trial.after.width,375);assert.equal(trial.after.crossOriginLoaded,true);
      await browser.screenshot(path.join(dir,'after.png'));
      for(const filename of ['before.png','after.png']){const bytes=await readFile(path.join(dir,filename));assert.equal(bytes.subarray(1,4).toString(),'PNG');trial[filename]={bytes:bytes.length,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};}
      trial.timeout=await browser.timeout();assert.equal(trial.timeout.timedOut,true);
      trial.recovery=await browser.metrics();assert.equal(trial.recovery.status,'Saved Ada');
      trial.activeProcesses=await processes(dir);assert(trial.activeProcesses.length>0,'Cleanup positive control must see owned Chrome');
      if(process.env.BROWSER_COMPARE_CRASH==='1') {
        await browser.crash();await sleep(100);const started=performance.now();
        try{trial.afterCrash=await browser.metrics()}catch(error){trial.afterCrashError=String(error)}
        trial.afterCrashMs=performance.now()-started;
        assert(trial.afterCrashError || trial.afterCrash?.status!=='Saved Ada','Cannot retain old success after browser crash');
      }
      trial.passed=true;
    } catch(error){trial.passed=false;trial.error=String(error);console.error(kind,trial.error);}
    finally {
      try{await browser?.close()}catch(error){trial.closeError=String(error)}
      await sleep(1200);trial.residualProcesses=await processes(dir);
      // Never leave comparison-owned processes running. Record leaks before cleanup.
      for(const p of trial.residualProcesses){try{process.kill(p.pid,'SIGTERM')}catch{}}
      await sleep(300);
      for(const p of await processes(dir)){try{process.kill(p.pid,'SIGKILL')}catch{}}
      await writeFile(path.join(root,'results.json'),JSON.stringify(results,null,2));
      console.log(JSON.stringify({kind,repeat,passed:trial.passed,error:trial.error,closeError:trial.closeError,residual:trial.residualProcesses.length,
        startupMs:trial.operations?.find(o=>o.name==='launch+open')?.ms}));
    }
  }
  results.syntheticEffects=effects;assert.equal(effects,0);results.controlServerAlive=(await fetch(resourceURL)).ok;
} finally {for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await writeFile(path.join(root,'results.json'),JSON.stringify(results,null,2));}
