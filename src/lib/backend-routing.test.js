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
