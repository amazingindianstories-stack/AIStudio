// Pure current-source oracle: no DB, dotenv, storage or provider imports.
import { readFileSync } from 'node:fs';
import { LIMIT_DEFINITIONS, parseLimitValue } from '../../src/lib/limits.js';
const inputs = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify(inputs.map(raw => Object.fromEntries(LIMIT_DEFINITIONS.map(def => [def.key, parseLimitValue(raw, def)])))));
