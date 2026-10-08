import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const input=JSON.parse(readFileSync(0,'utf8'));
const origin=new URL(input.url);
assert.equal(origin.hostname,'127.0.0.1');
assert.equal(process.env.MIGRATION_TEST_ISOLATED,'1');
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext();
  await context.addCookies([{name:'veevee_session',value:input.cookie,url:origin.origin,httpOnly:true,sameSite:'Lax'}]);
  const page=await context.newPage();
  // Minimal controlled document; this qualifies fetch/cookies through the real
  // proxy, not Asset Library UI acceptance or an app-wide browser suite.
  await page.route('**/migration-browser-contract',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Migration contract</title>'}));
  await page.goto(origin.origin+'/migration-browser-contract');
  const cases=[{path:'/api/settings',status:200,expected:input.expected},...(input.extraCases||[])];
  const report=[];
  for (const entry of cases) {
    assert.ok(entry.path.startsWith('/api/') && !entry.path.startsWith('//'));
    await context.addCookies([{name:'veevee_session',value:input.cookie,url:origin.origin,httpOnly:true,sameSite:'Lax'}]);
    const result=await page.evaluate(async path=>{
      const response=await fetch(path);
      return {status:response.status,body:await response.json(),requestId:response.headers.get('x-request-id'),url:response.url};
    },entry.path);
    assert.equal(result.status,entry.status);
    assert.equal(new URL(result.url).origin,origin.origin);
    assert.ok(result.requestId);
    assert.deepEqual(result.body,entry.expected);
    const cookie=(await context.cookies()).find(cookie=>cookie.name==='veevee_session');
    assert.ok(cookie.httpOnly);
    assert.equal(cookie.sameSite,'Lax');
    assert.ok(cookie.value!==input.cookie,'Session renewal missing');
    report.push({path:entry.path,status:result.status,body_equal:true,same_origin:true,django_request_id:true,renewal:true});
  }
  console.log(JSON.stringify({same_origin_fetch:true,django_request_id:true,http_only_renewal:true,lax_cookie:true,cases:report}));
} finally {await browser.close();}
