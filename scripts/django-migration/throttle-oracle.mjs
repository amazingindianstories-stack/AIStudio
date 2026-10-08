import { readFileSync } from 'node:fs';
import { maxLoginAttempts, loginRetryAfterMs, admitsLoginAttempt } from '../../src/lib/login-throttle.js';
const request=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify({maximums:request.values.map(value=>maxLoginAttempts(value===null?{}:{LOGIN_MAX_ATTEMPTS:value})), retries:request.retries.map(([oldest,now])=>loginRetryAfterMs(oldest,now)), admissions:request.admissions.map(value=>admitsLoginAttempt(value))}));
