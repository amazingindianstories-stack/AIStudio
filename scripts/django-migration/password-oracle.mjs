import { readFileSync } from 'node:fs';
import { hashPassword, verifyPassword, validatePassword } from '../../src/lib/password.js';
const request = JSON.parse(readFileSync(0,'utf8'));
if (request.operation === 'hash') console.log(JSON.stringify(request.passwords.map(password => ({...hashPassword(password), validation:validatePassword(password)}))));
else console.log(JSON.stringify(request.entries.map(entry => ({verified:verifyPassword(entry.password,entry.hash,entry.salt), validation:validatePassword(entry.password)}))));
