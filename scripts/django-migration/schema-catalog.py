"""Semantic catalog evidence for isolated schema equivalence qualification.

Only disposable loopback migration databases are accepted. No production/shared
connection is supported by this test utility. Future production baselining needs
a separately authorized operational review and checkpoint.
"""
import json
import os
import sys
from urllib.parse import urlsplit
import psycopg

QUERIES = {
    'tables': "SELECT c.relname, c.relkind, c.relpersistence FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY 1",
    'columns': "SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,collation_name,is_identity,identity_generation,is_generated,generation_expression FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
    'constraints': "SELECT t.relname,c.conname,c.contype,c.condeferrable,c.condeferred,c.convalidated,pg_get_constraintdef(c.oid,true) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' ORDER BY 1,2",
    'indexes': "SELECT t.relname AS table_name,i.relname AS index_name,x.indisunique,x.indisvalid,x.indisready,pg_get_indexdef(i.oid),pg_get_expr(x.indpred,x.indrelid) FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' ORDER BY 1,2",
    'triggers': "SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY 1,2",
    'functions': "SELECT p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') ORDER BY 1,2",
    'extensions': "SELECT extname,extversion FROM pg_extension ORDER BY extname",
}


def snapshot(connection):
    result = {}
    # Catalog categories must come from one consistent snapshot.
    with connection.transaction():
        with connection.cursor() as cursor:
            cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
            for category, query in QUERIES.items():
                cursor.execute(query)
                fields = [column.name for column in cursor.description]
                result[category] = [dict(zip(fields, row)) for row in cursor.fetchall()]
    return result


def compare(left, right):
    # No normalization hides differences; name/default/SQL expression changes
    # require a reviewed equivalence decision, rather than an automatic waiver.
    differences = []
    for category in sorted(set(left) | set(right)):
        if left.get(category) != right.get(category):
            differences.append(category)
    return differences


def main():
    if len(sys.argv) == 4 and sys.argv[1] == 'compare':
        with open(sys.argv[2]) as file: left = json.load(file)
        with open(sys.argv[3]) as file: right = json.load(file)
        differences = compare(left, right)
        print(json.dumps({'equivalent': not differences, 'different_categories': differences}))
        raise SystemExit(bool(differences))
    url = os.environ.get('DATABASE_URL', '')
    target = urlsplit(url)
    if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or target.hostname != '127.0.0.1' or target.path != '/veevee_django_migration':
        raise SystemExit('Disposable local migration database required')
    with psycopg.connect(url) as connection:
        print(json.dumps(snapshot(connection), sort_keys=True, indent=2))

if __name__ == '__main__': main()
