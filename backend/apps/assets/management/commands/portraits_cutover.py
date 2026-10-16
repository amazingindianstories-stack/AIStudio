"""One-off cleanup before automatic portraits go live: remove every old BytePlus portrait asset and group.

    python manage.py portraits_cutover                                                dry run (default): list and count
    python manage.py portraits_cutover --apply --expect-assets N --expect-groups M    delete, then retire the old rows

Lists every AIGC asset group and asset in the BytePlus account except Veevee's own pool group (the one named
``veevee-portraits`` or stored in the pool row), which this command refuses to touch. ``--apply`` runs only when the live
counts equal ``--expect-assets`` and ``--expect-groups`` exactly (copy them from the dry run); it deletes every listed
asset, then every listed group (NotFound counts as done), then marks every ``portrait_assets`` row ``Retired``. The rows
stay because old generations and media grants refer to their image URLs. Safe to re-run: with nothing left to delete it
passes ``--expect-assets 0 --expect-groups 0`` and only re-marks rows. Output names ids and groups, so run it privately.
"""
import time
from collections import Counter

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Count

from apps.assets import managed_pool
from apps.assets.byteplus import BytePlusAssetError, BytePlusClient, config_from_env
from apps.assets.models import ManagedPortraitPool, PortraitAsset, PortraitGroup

GONE = ('NotFound', 'NotFound.asset_id', 'NotFound.group_id')
PAGES = 1000


class CutoverTransport(managed_pool.PoolAssetTransport):
    """Exact allowlist for this command: list and delete only (no create, no get); exempt from the paid guard like the pool's."""
    ACTIONS = {
        'ListAssetGroups': {'Filter', 'MaxResults', 'NextToken', 'ProjectName'},
        'ListAssets': {'Filter', 'MaxResults', 'NextToken', 'ProjectName'},
        'DeleteAsset': {'Id', 'ProjectName'},
        'DeleteAssetGroup': {'Id', 'ProjectName'},
    }


def cutover_client():
    config = config_from_env()
    config['is_mock'] = False
    client = BytePlusClient(config, transport=CutoverTransport(allowed_hosts={managed_pool.ASSET_HOST}, timeout=30))
    if not client.available:
        raise CommandError('BytePlus asset credentials are not configured in this process.')
    return client


def pages(fetch):
    """Every item of a paginated BytePlus listing."""
    items, token, seen = [], None, set()
    for _ in range(PAGES):
        page = fetch(token)
        items += page.get('Items') or []
        token = page.get('NextToken')
        if not token or token in seen:
            return items
        seen.add(token)
    raise CommandError('BytePlus listing did not end; nothing was deleted.')


class Command(BaseCommand):
    help = 'Delete every old BytePlus portrait asset and group (not the pool group), then retire the old portrait rows.'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true', help='delete (default: dry run)')
        parser.add_argument('--expect-assets', type=int, help='refuse unless exactly this many assets are listed')
        parser.add_argument('--expect-groups', type=int, help='refuse unless exactly this many groups are listed')

    def handle(self, *args, apply=False, expect_assets=None, expect_groups=None, **options):
        if apply and (expect_assets is None or expect_groups is None):
            raise CommandError('--apply needs --expect-assets and --expect-groups (copy them from the dry run).')
        client = cutover_client()
        pool_ids, groups, assets = self.survey(client)
        self.report('before', groups, assets)
        if not apply:
            self.stdout.write('Dry run: nothing was changed. Re-run with --apply --expect-assets '
                              f'{len(assets)} --expect-groups {len(groups)} to delete these.')
            return
        if (len(assets), len(groups)) != (expect_assets, expect_groups):
            raise CommandError(f'Live counts differ from what you expected (assets {len(assets)} vs {expect_assets}, '
                               f'groups {len(groups)} vs {expect_groups}); nothing was deleted. Run the dry run again.')
        failed = [f'asset {item["Id"]}: {code}' for item in assets if (code := self.delete(client.delete_asset, item['Id'], pool_ids))]
        if failed:
            raise CommandError('Some assets could not be deleted; groups were left alone and the rows were not retired:\n' + '\n'.join(failed))
        failed = [f'group {item["Id"]}: {code}' for item in groups if (code := self.delete(client.delete_asset_group, item['Id'], pool_ids))]
        if failed:
            raise CommandError('Some groups could not be deleted; the rows were not retired:\n' + '\n'.join(failed))
        _, left_groups, left_assets = self.survey(client)
        self.report('after', left_groups, left_assets)
        if left_groups or left_assets:
            raise CommandError('BytePlus still lists old groups or assets; the rows were not retired. Run the dry run again.')
        retired = PortraitAsset.objects.exclude(status='Retired').update(status='Retired', updated_at=int(time.time() * 1000))
        self.stdout.write(f'retired {retired} portrait_assets row(s); {self.rows()}')

    def survey(self, client):
        """(pool group ids, groups to remove, assets to remove) from the live account."""
        every_group = pages(lambda token: client.list_asset_groups(max_results=50, next_token=token))
        pool_ids = {item['Id'] for item in every_group if item.get('Name') == managed_pool.POOL_GROUP_NAME}
        stored = ManagedPortraitPool.objects.filter(pk=1).values_list('byteplus_group_id', flat=True).first()
        if stored:
            pool_ids.add(stored)
        groups = [item for item in every_group if item['Id'] not in pool_ids]
        every_asset = pages(lambda token: client.list_assets(max_results=100, next_token=token))
        assets = [item for item in every_asset if item.get('Status') != 'Deleted' and item.get('GroupId') not in pool_ids]
        return pool_ids, groups, assets

    def delete(self, call, identifier, pool_ids):
        """None when the item is gone (deleted or already absent), else the error code."""
        if identifier in pool_ids:
            raise CommandError('Refusing to delete the pool group or one of its assets.')
        try:
            call(identifier)
        except BytePlusAssetError as error:
            return None if error.code in GONE else str(error.code)
        except Exception as error:
            return type(error).__name__
        return None

    def rows(self):
        counts = dict(PortraitAsset.objects.values_list('status').annotate(total=Count('id')).order_by('status'))
        return f'portrait_assets by status={counts} portrait_groups={PortraitGroup.objects.count()}'

    def report(self, label, groups, assets):
        per_group = Counter(item.get('GroupId') for item in assets)
        self.stdout.write(f'[{label}] BytePlus: {len(groups)} group(s), {len(assets)} asset(s) to remove (pool group excluded); {self.rows()}')
        for item in groups:
            self.stdout.write(f'  group {item["Id"]} name={item.get("Name")!r} assets={per_group.pop(item["Id"], 0)}')
        for group_id, count in per_group.items():
            self.stdout.write(f'  assets without a listed group {group_id}: {count}')
