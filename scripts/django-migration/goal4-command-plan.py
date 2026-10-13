"""Shipped, read-only NOOP hook templates. Print exact commands; never run them.

Unsupported provider/platform mutation APIs remain explicit operator inputs with
concrete dashboard procedures. No guessed cloud mutation schema is executable.
"""
import argparse
import json
from pathlib import Path


def commands(plan):
    values = plan.get('targets', {})
    extra = plan.get('command_inputs', {})
    def value(key):
        return values.get(key, extra.get(key, '<VERIFIED_' + key.upper() + '>'))
    def ssh(service, instance, *command):
        return ['railway', 'ssh', '--project', value('railway_project_id'), '--environment', value('railway_environment_id'),
                '--service', value(service), '--deployment-instance', value(instance), '--', *command]
    def scale(service, replicas):
        return ['railway', 'scale', '--service', service, '--environment', value('railway_environment_id'), value('railway_region') + '=' + str(replicas), '--json']
    fence = [scale(service, 0) for service in extra.get('old_writer_service_ids', ['<VERIFIED_OLD_API_ID>', '<VERIFIED_OLD_GENERATION_ID>', '<VERIFIED_OLD_EXPORT_ID>', '<VERIFIED_OLD_SCHEDULER_ID>'])]
    readonly = 'BEGIN READ ONLY; SELECT current_database(),current_user,inet_server_addr(),inet_server_port(); SHOW server_version; SELECT app,name FROM django_migrations ORDER BY app,name; COMMIT;'
    result = {
        'inventory': {'argv': [['psql', '--no-psqlrc', '--no-password', '--set', 'ON_ERROR_STOP=1', '--command', readonly],
            ['gcloud', 'storage', 'buckets', 'describe', 'gs://' + value('bucket_identity'), '--format=json(name,location,uniform_bucket_level_access,public_access_prevention,cors_config)'],
            ['vercel', 'inspect', value('vercel_current_deployment_id')]],
            'operator_check': 'Approved PGSERVICE reader identity; Railway project/environment/service/deployment ID console inventory, source image/config/PORT/secret names. No variables or customer-row dump.'},
        'backup': {'argv': [['pg_dump', '--no-password', '--format=custom', '--file', value('private_backup_path')]],
            'operator_check': 'Use separately approved backup reader for the verified DB; encrypt/protect private backup. Check actual PITR earliest/latest restore points and tested restore receipt in DB-provider console; media/master backups and paid-receipt boundary must match.'},
        'fence': {'argv': fence, 'operator_check': 'Explicit linked Railway project verified first. Include all regions, old API paid enqueue, writers, cron/autodeploy; stop external GPU supervisor separately and drain/reconcile active leases. Validate replicas actually0; never treat CLI return as a drain.'},
        'reconcile': {'argv': [], 'operator_check': 'Use 04 provider paid-work reconciliation: approved read-only receipt/account metadata; classify accepted/pending/ambiguous, preserve task IDs/winners and V1/V2 manifests. Ambiguous paid work HOLD; no submission/replay command exists.'},
        'migrate': {'argv': [ssh('migration_runner_service_id', 'migration_runner_deployment_instance_id', 'python', 'manage.py', 'migrate', '--plan'),
            ssh('migration_runner_service_id', 'migration_runner_deployment_instance_id', 'python', 'manage.py', 'migrate', '--noinput')],
            'operator_check': 'A separately controlled no-traffic migration release runner contains exact reviewed image/DB identity. Stop after --plan for review. Populated historical adoption uses the reviewed catalog/history-only procedure first; never fake-initial. Provisioning runner/API form remains explicit operator input.'},
        'verify_schema': {'argv': [ssh('migration_runner_service_id', 'migration_runner_deployment_instance_id', 'python', 'manage.py', 'check'),
            ['psql', '--no-psqlrc', '--no-password', '--set', 'ON_ERROR_STOP=1', '--file', value('reviewed_catalog_sql_path')]],
            'operator_check': 'Execute reviewed read-only catalog/count/hash queries from05 against verified reader, compare approved before/after metadata and migration names; no synthetic adoption probe against production.'},
        'frontend': {'argv': [['vercel', 'promote', value('vercel_new_production_deployment_id'), '--timeout', '5m', '--scope', value('vercel_team_id')]],
            'operator_check': 'Must be existing Production-built deployment with frozen source, Node22, correct gateway/env scopes; Preview promotion may rebuild and requires separate qualification. Check actual aliases and auth/download smoke afterward.'},
        'smoke': {'argv': [['curl', '--fail', '--silent', '--show-error', '--max-time', '10', value('api_https_origin') + '/api/health']],
            'operator_check': 'Then07 real Chromium/ZIP/direct-GCS/auth acceptance with approved synthetic assets and separate capped provider budget. No paid test auto-execution; exact receipts/hashes required.'},
        'rollback_fence': {'argv': [scale(value(key), 0) for key in ('api_service_id', 'generation_service_id', 'export_service_id', 'scheduler_service_id')],
            'operator_check': 'Stop every region/new writer/cron and externalGPU; reconcile uncertain claims/paid receipts before next step.'},
        'rollback_compatible': {'argv': [['vercel', 'rollback', value('vercel_previous_production_deployment_id'), '--timeout', '5m', '--scope', value('vercel_team_id')]],
            'operator_check': 'First restore Railway pre-reviewed forward-schema-compatible image using exact UI procedure below. Vercel plan entitlement may restrict rollback depth; no schema reversal/DB snapshot overwrite/Node writer fallback.'},
        'rollback_verify': {'argv': [['curl', '--fail', '--silent', '--show-error', '--max-time', '10', value('api_https_origin') + '/api/health'],
            ['psql', '--no-psqlrc', '--no-password', '--set', 'ON_ERROR_STOP=1', '--file', value('reviewed_catalog_sql_path')]],
            'operator_check': 'Prove postmigration schema/counts/hash/master keys/receipts preserved, one scheduler, correct aliases and user smoke before unfencing.'}
    }
    for role, command in (('api', None), ('generation', 'generation_worker'), ('export', 'media_export_worker'), ('scheduler', 'run_scheduler')):
        result[role] = {'argv': [] if command is None else [ssh(role + '_service_id', role + '_deployment_instance_id', 'python', 'manage.py', command, '--once')],
            'image_digest': value('api_image_digest' if role in ('api', 'export', 'scheduler') else 'worker_image_digest'),
            'operator_check': 'In verified project/environment/service ID: open Settings>Source, select registry image at approved immutable digest (not latest tag); review correct role config/start command, roots, mounts and secret scopes; stage only this service change and apply after schema gate. Verify actual deployment instance image digest/revision then run tick/health. Keep other writers fenced. Exact platform mutation command OPERATOR_INPUT_REQUIRED: official image-source API form was unavailable; do not guess GraphQL or use source-rebuilding railway up/redeploy as immutable promotion.'}
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', default='docs/goal3/goal4-operator-plan.json')
    parser.add_argument('--step')
    args = parser.parse_args()
    matrix = commands(json.loads(Path(args.plan).read_text()))
    if args.step:
        matrix = {args.step: matrix[args.step]}
    print(json.dumps({'mode': 'NOOP_COMMAND_TEMPLATES', 'remote_calls': 0, 'mutations': 0, 'commands': matrix}, indent=2))
