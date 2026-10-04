import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Real Chromium against the production bundle and a deliberately fake API.
// No Python backend, real market source, model, broker or credential is used.
test('desktop/mobile research workflow preserves uncertain-send recovery', { timeout: 45000 }, async () => {
  const browserPath = ['/usr/bin/chromium','/usr/bin/google-chrome','/opt/google/chrome/chrome'].find(existsSync);
  assert.ok(browserPath, 'Chromium unavailable: browser gate is blocked, not skipped');
  const requests=[];
  const mime={'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture');
    if(url.pathname.startsWith('/sessions')) {
      requests.push({method:req.method,path:url.pathname});res.setHeader('Content-Type','application/json');
      if(req.method==='GET') return res.end('[]');
      if(url.pathname==='/sessions') return res.end('{"session_id":"browser-fixture"}');
      res.statusCode=503;return res.end('{"error":"fixture: uncertain send"}');
    }
    if(url.pathname.startsWith('/api/') || url.pathname==='/live') {res.setHeader('Content-Type','application/json');return res.end('{}');}
    const file=path.join(process.cwd(),'dist',path.extname(url.pathname)?url.pathname:'index.html');
    try {res.setHeader('Content-Type',mime[path.extname(file)] || 'text/html');res.end(readFileSync(file));}
    catch {res.statusCode=404;res.end('missing fixture asset');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const profile=mkdtempSync(path.join(tmpdir(),'jay-browser-'));
  const chrome=spawn(browserPath,['--headless','--no-sandbox','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let ws;
  try {
    const endpoint=await new Promise((resolve,reject)=>{
      let log='';const timer=setTimeout(()=>reject(new Error('Chromium debugger unavailable')),10000);
      chrome.stderr.on('data',chunk=>{log+=chunk;const match=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
      chrome.once('error',reject);
    });
    ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
    let id=0;const pending=new Map();const exceptions=[];const external=[];
    function send(method,params={},sessionId) {return new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params,sessionId}));});}
    ws.addEventListener('message',async event=>{
      const msg=JSON.parse(event.data);
      if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);if(msg.error)p.reject(new Error(JSON.stringify(msg.error)));else p.resolve(msg.result);}
      if(msg.method==='Runtime.exceptionThrown')exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if(msg.method==='Fetch.requestPaused'){
        const {requestId,request}=msg.params;
        if(request.url.startsWith(base+'/')) await send('Fetch.continueRequest',{requestId},msg.sessionId);
        else {external.push(request.url);await send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'},msg.sessionId);}
      }
    });
    const {targetId}=await send('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
    const command=(method,params={})=>send(method,params,sessionId);
    await command('Runtime.enable');await command('Page.enable');await command('Fetch.enable',{patterns:[{urlPattern:'*'}]});
    async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;}
    async function until(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(50);}assert.fail(`Browser condition timed out: ${expression}`);}
    await command('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await command('Page.navigate',{url:base+'/'});
    await until('document.body?.innerText.includes("服务已连接")');
    await evaluate('[...document.querySelectorAll("button")].find(x=>x.getAttribute("aria-label")==="研究 贵州茅台").click()');
    await evaluate('[...document.querySelectorAll("button")].find(x=>x.textContent.includes("预览研究任务")).click()');
    await until('!!document.querySelector(".stock-preview")');
    assert.ok(await evaluate('document.querySelector(".stock-preview").textContent.includes("600519.SH")'));
    const output = process.env.QUALITY_RUN_DIR || 'quality-artifacts';
    mkdirSync(output,{recursive:true});
    const desktop=await command('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(output,'browser-desktop.png'),Buffer.from(desktop.data,'base64'));
    await evaluate('[...document.querySelectorAll("button")].find(x=>x.getAttribute("aria-label")==="添加自选 贵州茅台").click()');
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile layout overflows horizontally');
    const mobile=await command('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(output,'browser-mobile.png'),Buffer.from(mobile.data,'base64'));
    await evaluate('const b=[...document.querySelectorAll("button")].find(x=>x.textContent.includes("确认并开始分析"));b.click();b.click()');
    await until('document.body?.innerText.includes("会话已创建，但发送结果尚未确认")');
    assert.equal(requests.filter(x=>x.method==='POST'&&x.path==='/sessions').length,1);
    assert.equal(requests.filter(x=>x.method==='POST'&&x.path.endsWith('/messages')).length,1);
    assert.equal(await evaluate('document.querySelector(".stock-error a").getAttribute("href")'),'/agent?session=browser-fixture');
    await command('Page.reload');await until('document.body?.innerText.includes("服务已连接")');
    assert.ok(await evaluate('[...document.querySelectorAll("button")].some(x=>x.getAttribute("aria-label")==="删除自选 贵州茅台")'));
    assert.deepEqual(exceptions,[]);assert.deepEqual(external,[]);
    writeFileSync(path.join(output,'browser.json'),JSON.stringify({browser:await send('Browser.getVersion'),viewports:[[1280,900],[390,844]],requests,exceptions,external},null,2));
  } finally {
    ws?.close();chrome.kill();await new Promise(r=>chrome.exitCode!==null?r():chrome.once('exit',r));
    await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true});
  }
});
