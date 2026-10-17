import { execFile } from 'node:child_process';

/** Parameterized SQL through Python, confined to the disposable test cluster. */
export function fixtureDatabase(databaseUrl) {
  const target = new URL(databaseUrl);
  if (process.env.MIGRATION_TEST_ISOLATED !== '1' ||
      !['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/veevee_django_migration') {
    throw new Error('Browser fixtures require the verified disposable Django database.');
  }
  function build(strings, values) {
    let query = strings[0];
    const parameters = [];
    values.forEach((value, index) => {
      if (value && Object.hasOwn(value, 'fixtureList')) {
        if (!value.fixtureList.length) throw new Error('Empty fixture SQL list');
        query += '(' + value.fixtureList.map(() => '%s').join(',') + ')';
        parameters.push(...value.fixtureList);
      } else {
        query += '%s';
        parameters.push(value);
      }
      query += strings[index + 1];
    });
    return { query, parameters };
  }
  function run(payload) {
    return new Promise((resolve, reject) => {
      const child = execFile(process.env.E2E_PYTHON || 'python3', ['scripts/dev/browser-db.py'],
        { env: { ...process.env, DATABASE_URL: databaseUrl }, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
          if (error) reject(error);
          else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
        });
      child.stdin.end(JSON.stringify(payload));
    });
  }
  function database(strings, ...values) {
    if (!Array.isArray(strings.raw)) return { fixtureList: strings };
    return run(build(strings, values));
  }
  /** Builds one statement for `transaction` without running it. */
  database.statement = (strings, ...values) => build(strings, values);
  /** Runs statements in order in one transaction; resolves to the last statement's rows. */
  database.transaction = (statements) => run({ statements });
  database.end = async () => {};
  return database;
}
