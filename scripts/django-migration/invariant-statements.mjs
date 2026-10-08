// Read current migration statement exports; never execute their DB entrypoints.
if (process.env.MIGRATION_TEST_ISOLATED !== '1') throw new Error('Isolated runner required');
const target = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/veevee_django_migration') throw new Error('Disposable local target required');
const log = console.log;
console.log = () => {};
let hierarchy, naming;
try {
  ({ HIERARCHICAL_FOLDER_STATEMENTS: hierarchy } = await import('../migrate-hierarchical-folders.js'));
  ({ GENERATION_NAMING_STATEMENTS: naming } = await import('../migrate-generation-naming.js'));
} finally {
  console.log = log;
}
process.stdout.write(JSON.stringify({ hierarchy, naming }));
