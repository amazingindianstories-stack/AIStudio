import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const input=JSON.parse(readFileSync(0,'utf8'));
const origin=new URL(input.url);
assert.equal(origin.hostname,'127.0.0.1');
assert.equal(process.env.MIGRATION_TEST_ISOLATED,'1');
assert.equal(origin.protocol,input.secure?'https:':'http:');
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext({ignoreHTTPSErrors:!!input.secure});
  await context.addCookies([{name:'veevee_session',value:input.cookie,url:origin.origin,httpOnly:true,sameSite:'Lax',secure:!!input.secure}]);
  const page=await context.newPage();
  // Minimal controlled document; this qualifies fetch/cookies through the real
  // proxy, not Asset Library UI acceptance or an app-wide browser suite.
  await page.route('**/migration-browser-contract',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Migration contract</title>'}));
  await page.goto(origin.origin+'/migration-browser-contract');
  const cases=[{path:'/api/settings',status:200,expected:input.expected},...(input.extraCases||[])];
  const report=[];
  for (const entry of cases) {
    assert.ok(entry.path.startsWith('/api/') && !entry.path.startsWith('//'));
    await context.addCookies([{name:'veevee_session',value:input.cookie,url:origin.origin,httpOnly:true,sameSite:'Lax',secure:!!input.secure}]);
    const started=Date.now();
    const result=await page.evaluate(async entry=>{
      const path=entry.path;
      const response=await fetch(path);
      return {status:response.status,body:entry.raw?await response.text():await response.json(),requestId:response.headers.get('x-request-id'),url:response.url};
    },entry);
    const finished=Date.now();
    assert.equal(result.status,entry.status);
    assert.equal(new URL(result.url).origin,origin.origin);
    assert.ok(result.requestId);
    if (entry.watermark) {
      assert.deepEqual(Object.keys(result.body).sort(),['items','now']);
      assert.deepEqual(result.body.items,entry.expected);
      assert.ok(result.body.now>=started && result.body.now<=finished);
    } else assert.deepEqual(result.body,entry.expected);
    const cookie=(await context.cookies()).find(cookie=>cookie.name==='veevee_session');
    assert.ok(cookie.httpOnly);
    assert.equal(cookie.secure,!!input.secure);
    assert.equal(cookie.sameSite,'Lax');
    assert.equal(cookie.value!==input.cookie,entry.renewal!==false,'Session renewal contract');
    if (entry.renewal!==false) {
      // Do not reset/reinject cookies: Chromium must send the renewed cookie.
      const followup=await page.evaluate(async()=>{
        const response=await fetch('/api/settings');
        return {status:response.status,body:await response.json(),requestId:response.headers.get('x-request-id'),url:response.url,visibleCookie:document.cookie};
      });
      assert.equal(followup.status,200,'Renewed session rejected');
      assert.deepEqual(followup.body,input.expected);
      assert.ok(followup.requestId);
      assert.equal(new URL(followup.url).origin,origin.origin);
      assert.ok(!followup.visibleCookie.includes('veevee_session'),'HttpOnly session exposed');
      const after=(await context.cookies()).find(value=>value.name==='veevee_session');
      assert.equal(after.value,cookie.value,'Fresh session renewed on every request');
    }
    report.push({path:entry.path,status:result.status,body_equal:true,same_origin:true,django_request_id:true,renewal:entry.renewal!==false,renewed_followup_accepted:entry.renewal!==false?true:null,server_watermark_bounded:!!entry.watermark});
  }
  console.log(JSON.stringify({same_origin_fetch:true,django_request_id:true,http_only_renewal:true,lax_cookie:true,secure_cookie:!!input.secure,cases:report}));
} finally {await browser.close();}
