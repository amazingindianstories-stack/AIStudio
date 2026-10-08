import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export function checkOwnership(root, manifest) {
  const errors = [];
  const states = new Set(['NOT_STARTED', 'IMPLEMENTING', 'PARITY_VERIFIED', 'PREVIEW_VERIFIED', 'PRODUCTION_CANARY', 'DJANGO_AUTHORITATIVE', 'NODE_REMOVED']);
  const files = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === 'route.js' || /^route\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path.relative(root, file));
    }
  }
  walk(path.join(root, 'src/app/api'));
  const known = new Set(Object.values(manifest.routes).map(r => r.source));
  for (const file of files) if (!known.has(file)) errors.push(`Unregistered Node route: ${file}`);
  if (!['DRIZZLE', 'TRANSITION', 'DJANGO'].includes(manifest.schema_authority)) errors.push('Invalid schema authority');
  if (!['NEXT', 'TRANSITION', 'DJANGO'].includes(manifest.auth_authority)) errors.push('Invalid auth authority');
  for (const [url, route] of Object.entries(manifest.routes)) {
    const present = existsSync(path.join(root, route.source));
    const source = present ? readFileSync(path.join(root, route.source), 'utf8') : '';
    const methods = [...source.matchAll(/export\s+(?:(?:async\s+)?function|const|let|var)\s+(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\b/g)].map(m => m[1]);
    for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const entry of match[1].split(',')) {
        const name = entry.trim().split(/\s+as\s+/).at(-1);
        if (/^(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)$/.test(name)) methods.push(name);
      }
    }
    for (const method of methods) if (!route.methods[method]) errors.push(`Unregistered Node method: ${method} ${url}`);
    for (const [method, item] of Object.entries(route.methods)) {
      if (!states.has(item.state) || !['next', 'django'].includes(item.owner) || !['active', 'rollback', 'removed'].includes(item.next_status)) errors.push(`Invalid ownership: ${method} ${url}`);
      if (item.next_status === 'removed' && methods.includes(method)) errors.push(`Retired implementation restored: ${method} ${url}`);
      if (item.next_status !== 'removed' && !methods.includes(method)) errors.push(`Missing retained implementation: ${method} ${url}`);
      if (item.owner === 'next' && item.next_status !== 'active') errors.push(`Next owner must be active: ${method} ${url}`);
      if (item.owner === 'django' && !['PRODUCTION_CANARY', 'DJANGO_AUTHORITATIVE', 'NODE_REMOVED'].includes(item.state)) errors.push(`Django traffic owner lacks cutover state: ${method} ${url}`);
      if (item.owner === 'django' && (!item.evidence?.length || item.evidence.some(file => !existsSync(path.join(root, file))))) errors.push(`Missing cutover evidence: ${method} ${url}`);
    }
    // Freeze business route growth. A reviewed exception is bound to exact bytes,
    // so a blanket 'temporary exception' cannot silently authorize later changes.
    if (present && createHash('sha256').update(source).digest('hex') !== route.baseline_sha256) {
      const hash = createHash('sha256').update(source).digest('hex');
      const exception = manifest.exceptions?.find(e => e.path === route.source && e.sha256 === hash && e.reason && e.issue);
      if (!exception) errors.push(`Node business change requires an explicit migration exception: ${route.source}`);
    }
  }
  for (const [file, hash] of Object.entries(manifest.frozen_backend_files ?? {})) {
    const group = file.startsWith('src/lib/providers/') || file.startsWith('src/worker/') ? 'workers' : 'schema';
    const frozen = group === 'schema' ? manifest.schema_authority === 'DJANGO' : manifest.workers.generation === 'PYTHON';
    if (frozen && existsSync(path.join(root, file)) && createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') !== hash) errors.push(`Retired ${group} authority modified: ${file}`);
  }
  if (manifest.workers.generation === 'PYTHON') {
    for (const directory of ['src/lib/providers', 'src/worker']) {
      if (!existsSync(path.join(root, directory))) continue;
      for (const file of readdirSync(path.join(root, directory))) {
        if (/\.[cm]?[jt]s$/.test(file) && !file.includes('.test.') && !file.includes('.integration.')) errors.push(`Node worker/provider implementation remains after transfer: ${directory}/${file}`);
      }
    }
  }
  if (manifest.schema_authority === 'DJANGO') {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json')));
    for (const [name, command] of Object.entries(pkg.scripts)) if (/drizzle-kit\s+push|(?:tsx|node).*migrate-/.test(command)) errors.push(`Node schema command remains after takeover: ${name}`);
    if (existsSync(path.join(root, 'src/app/api/admin/migrate-schema/route.js'))) errors.push('HTTP schema mutation endpoint remains after takeover');
  }
  return errors;
}

export function checkApiContracts(contract, manifest) {
  const errors = [];
  const seen = new Set();
  const dimensions = ['request_body','query_params','authentication','authorization','success','failure','headers','db_reads','db_mutations','storage_effects','provider_effects','worker_effects','idempotency','concurrency','pagination','naming','remaining_qualification'];
  for (const route of contract.routes ?? []) {
    if (seen.has(route.path)) errors.push(`Duplicate API contract: ${route.path}`);
    seen.add(route.path);
    const owner = manifest.routes[route.path];
    if (!owner) { errors.push(`Unregistered API contract: ${route.path}`); continue; }
    if (route.source !== owner.source) errors.push(`API contract source mismatch: ${route.path}`);
    const methods = new Set(route.methods ?? []);
    for (const method of Object.keys(owner.methods)) if (!methods.has(method)) errors.push(`Missing API contract method: ${method} ${route.path}`);
    for (const method of methods) if (!owner.methods[method]) errors.push(`Unregistered API contract method: ${method} ${route.path}`);
    for (const [method, details] of Object.entries(route.method_contracts ?? {})) {
      if (!methods.has(method)) errors.push(`Contract details for undeclared method: ${method} ${route.path}`);
      for (const dimension of dimensions) if (!Object.hasOwn(details, dimension)) errors.push(`Missing API contract dimension ${dimension}: ${method} ${route.path}`);
    }
  }
  for (const url of Object.keys(manifest.routes)) if (!seen.has(url)) errors.push(`Missing API contract route: ${url}`);
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const manifest = JSON.parse(readFileSync('docs/django-migration/route-ownership.yaml'));
  const errors = checkOwnership(root, manifest);
  errors.push(...checkApiContracts(JSON.parse(readFileSync('docs/django-migration/api-contract.yaml')), manifest));
  const base = process.env.BACKEND_OWNERSHIP_BASE;
  if (base) {
    // CI passes the PR base SHA. Changing a baseline must not bless new Node code.
    let old;
    try { old = JSON.parse(execFileSync('git', ['show', `${base}:docs/django-migration/route-ownership.yaml`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* First introduction has no prior manifest. */ }
    if (old) for (const [url, route] of Object.entries(manifest.routes)) {
      if (!old.routes[url]) {
        const exception = manifest.exceptions?.find(e => e.path === route.source && e.sha256 === route.baseline_sha256 && e.reason && e.issue);
        if (!exception) errors.push(`New Node route requires an explicit migration exception: ${url}`);
      }
    }
    if (old) for (const [url, route] of Object.entries(old.routes)) {
      const current = manifest.routes[url];
      if (!current) errors.push(`Historical route removed from manifest: ${url}`);
      else if (current.baseline_sha256 !== route.baseline_sha256) errors.push(`Baseline rewritten: ${url}; use a hash-scoped exception`);
    }
  }
  for (const error of errors) console.error(error);
  console.log(JSON.stringify({ routes: Object.keys(manifest.routes).length, methods: Object.values(manifest.routes).reduce((n, r) => n + Object.keys(r.methods).length, 0), django_authoritative: Object.values(manifest.routes).flatMap(r => Object.values(r.methods)).filter(m => m.owner === 'django').length, errors: errors.length }));
  process.exitCode = errors.length ? 1 : 0;
}
