import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
const manifest=JSON.parse(readFileSync('docs/django-migration/route-ownership.yaml','utf8'));
const local=JSON.parse(readFileSync('docs/django-migration/local-implementation.json','utf8'));
const deployed=Object.values(manifest.routes).flatMap(route=>Object.values(route.methods));
const modeled=[];
for(const app of readdirSync('backend/apps',{withFileTypes:true})) {
  const file=path.join('backend/apps',app.name,'models.py');
  if(!app.isDirectory()||!existsSync(file)) continue;
  for(const match of readFileSync(file,'utf8').matchAll(/class (\w+)\(models.Model\):([\s\S]*?)(?=\nclass |$)/g)) {
    const table=match[2].match(/db_table\s*=\s*['"]([^'"]+)/)?.[1];
    if(table) modeled.push({model:`${app.name}.${match[1]}`,table});
  }
}
const report=`# Local Django implementation status\n\nGenerated from local-implementation.json and source; historical production ownership is separate.\n\n| Measure | Local undeployed source |\n|---|---|\n| Implemented methods | ${local.methods.filter(m=>m.state==='DJANGO_IMPLEMENTED_LOCAL').length} / ${local.methods.length} |\n| Intentional authenticated 410 retirements | ${local.methods.filter(m=>m.state==='INTENTIONALLY_RETIRED_LOCAL').length} |\n| Added local upload methods | ${local.additions?.length ?? 0}; not deployed |\n| Managed physical models | ${new Set(modeled.map(m=>m.table)).size} |\n| Schema authority | ${local.schema_authority_local} |\n| Node source retirement | ${local.source_retirement} |\n| Historical manifest Django traffic owners | ${deployed.filter(m=>m.owner==='django').length} / ${deployed.length}; live routing not inspected |\n| Production adoption/deployment | Pending separate authorization |\n\n## Method coverage\n\n| Method | Route | Local state | Test source |\n|---|---|---|---|\n${local.methods.map(m=>`| ${m.method} | ${m.path} | ${m.state} | ${m.evidence.at(-1)} |`).join('\n')}\n\nThe method registry verifies actual Django URL resolution and declared verbs. Domain tests\ncover behavior and negative paths; source links alone are not execution evidence. See\nqualification-index.md for commands, complete results and limits. The HTTP schema endpoint\nand browser-triggered executor return authenticated 410 responses; schema operations use\ncontrolled Django commands and workers invoke Python services directly.\n\n## Managed model ownership\n\n${modeled.map(m=>`- ${m.model}: ${m.table}`).join('\n')}\n\nThe model-registry.md artifact records columns, defaults, indexes, checks and foreign keys.\nNo local result establishes a live provider, hosted proxy or production schema cutover.\n`;
const destination='docs/django-migration/status.md';
if(process.argv.includes('--check')) {
  if(readFileSync(destination,'utf8')!==report) {console.error('Migration status is stale; run node scripts/django-migration/status-report.mjs');process.exitCode=1;}
} else writeFileSync(destination,report);
