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
  const result=await page.evaluate(async()=>{
    const response=await fetch('/api/settings');
    return {status:response.status,body:await response.json(),requestId:response.headers.get('x-request-id')};
  });
  assert.equal(result.status,200);
  assert.ok(result.requestId);
  assert.deepEqual(result.body,input.expected);
  const cookie=(await context.cookies()).find(cookie=>cookie.name==='veevee_session');
  assert.ok(cookie.httpOnly);
  assert.equal(cookie.sameSite,'Lax');
  assert.notEqual(cookie.value,input.cookie);
  console.log(JSON.stringify({same_origin_fetch:true,django_request_id:true,http_only_renewal:true,lax_cookie:true}));
} finally {await browser.close();}
