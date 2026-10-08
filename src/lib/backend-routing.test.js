import test from 'node:test';
import assert from 'node:assert/strict';
import { djangoDestination } from './backend-routing.js';
const request='https://frontend.example/api/settings?ignored=1';
const configured={methods:'GET /api/settings',origin:'https://django.example'};
test('same-origin browser path rewrites only selected method and preserves query',()=>{
  assert.equal(djangoDestination(request,'GET',configured).href,'https://django.example/api/settings?ignored=1');
  assert.equal(djangoDestination(request,'POST',configured),null);
  assert.equal(djangoDestination(request,'GET',{}),null);
});
test('routing rejects unimplemented methods, credentials, loops and insecure remote origins',()=>{
  for(const config of [ {...configured,methods:'POST /api/settings'}, {...configured,origin:'http://django.example'}, {...configured,origin:'https://user:pass@django.example'}, {...configured,origin:'https://frontend.example'}, {...configured,origin:'https://django.example/prefix'}]) {
    assert.throws(()=>djangoDestination(request,config.methods.startsWith('POST')?'POST':'GET',config));
  }
});
test('local qualification requires explicit loopback permission',()=>{
  assert.throws(()=>djangoDestination(request,'GET',{...configured,origin:'http://127.0.0.1:8000'}));
  assert.equal(djangoDestination(request,'GET',{...configured,origin:'http://127.0.0.1:8000',allowLocal:'1'}).port,'8000');
});

test('Canvas metadata selection preserves repeated parameters and retains mutations',()=>{
  const url='https://frontend.example/api/canvas-boards?projectId=first&projectId=second';
  const config={...configured,methods:'GET /api/settings, GET /api/canvas-boards'};
  assert.equal(djangoDestination(url,'GET',config).href,'https://django.example/api/canvas-boards?projectId=first&projectId=second');
  assert.equal(djangoDestination(url,'POST',config),null);
  assert.equal(djangoDestination(url,'GET',configured),null);
  assert.throws(()=>djangoDestination(url,'POST',{...config,methods:'POST /api/canvas-boards'}));
});

test('history counts switch is exact and opt-in',()=>{
  const url='https://frontend.example/api/history/counts?kind=audio&favorite=1';
  const config={...configured,methods:'GET /api/history/counts'};
  assert.equal(djangoDestination(url,'GET',config).href,'https://django.example/api/history/counts?kind=audio&favorite=1');
  assert.equal(djangoDestination(url,'GET',configured),null);
  assert.equal(djangoDestination(url,'POST',config),null);
  assert.equal(djangoDestination('https://frontend.example/api/history','GET',config),null);
});

test('update polling switch preserves watermarks and leaves other history methods selected separately',()=>{
  const url='https://frontend.example/api/history/updates?since=2&since=1';
  const config={...configured,methods:'GET /api/history/updates'};
  assert.equal(djangoDestination(url,'GET',config).href,'https://django.example/api/history/updates?since=2&since=1');
  assert.equal(djangoDestination(url,'GET',configured),null);
  assert.equal(djangoDestination(url,'POST',config),null);
  assert.equal(djangoDestination('https://frontend.example/api/history','GET',config),null);
});

test('history reads are separately selected and retain mutation ownership',()=>{
  const url='https://frontend.example/api/history?limit=2&cursor=1.id';
  const config={...configured,methods:'GET /api/history'};
  assert.equal(djangoDestination(url,'GET',config).href,'https://django.example/api/history?limit=2&cursor=1.id');
  for (const method of ['PATCH','DELETE','POST']) assert.equal(djangoDestination(url,method,config),null);
  assert.equal(djangoDestination(url,'GET',configured),null);
  assert.equal(djangoDestination('https://frontend.example/api/history/updates','GET',config),null);
});
