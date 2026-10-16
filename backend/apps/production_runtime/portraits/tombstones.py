"""Portrait soft deletion (PreviewDeleted tombstones) and local-only uploads.

Ported from the production overlay; installed before upload registration and
remote delete, which build on it. No provider or storage calls happen here.
"""
import ast
import functools
import hashlib
import importlib
import os
from pathlib import Path

SCOPE='GOAL4_PREVIEW_PORTRAIT_LOCAL_TOMBSTONE_ONLY'
TOMBSTONE='PreviewDeleted'


def need(value):
    if not value:raise ValueError('Preview portrait tombstone HOLD')


def visible_assets(assets):
    return [asset for asset in assets if asset.get('status')!=TOMBSTONE]


def visible_groups(groups):
    result=[]
    for group in groups:
        assets=visible_assets(group.get('assets',[]))
        item={**group,'assets':assets,'activeCount':sum(a.get('status')=='Active' for a in assets),
              'processingCount':sum(a.get('status')=='Processing' for a in assets)}
        if any(a.get('status')==TOMBSTONE and a.get('imageUrl')==item.get('primaryAssetId') for a in group.get('assets',[])):
            item['primaryAssetId']=assets[0].get('imageUrl') if assets else None
        result.append(item)
    return result


def visible_result(result):
    result=dict(result)
    if 'assets' in result:result['assets']=visible_assets(result['assets'])
    if 'groups' in result:result['groups']=visible_groups(result['groups'])
    return result


def compile_local_uploads(source,namespace):
    tree=ast.parse(source)
    functions={node.name:node for node in tree.body if isinstance(node,ast.FunctionDef)}
    result={}
    def remote_write(node):
        return any(isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr in ('create_asset','create_asset_group') for n in ast.walk(node))
    for name in ('portraits','group_assets','upload'):
        fn=functions[name];fn.decorator_list=[]
        outer=next(n for n in fn.body if isinstance(n,ast.Try))
        if name=='upload':
            outer.body=[n for n in outer.body if not (isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='client' for t in n.targets)) and not (isinstance(n,ast.Try) and remote_write(n))]
        elif name=='group_assets':
            for n in outer.body:
                if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='client' for t in n.targets):
                    n.value=ast.IfExp(test=ast.Compare(left=ast.Attribute(value=ast.Name(id='request',ctx=ast.Load()),attr='method',ctx=ast.Load()),ops=[ast.Eq()],comparators=[ast.Constant('POST')]),body=ast.Constant(None),orelse=n.value)
            outer.body=[n for n in outer.body if not (isinstance(n,ast.If) and remote_write(n)) and not (isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='signed' for t in n.targets))]
            for n in outer.body:
                if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='remote' for t in n.targets):
                    n.value=ast.Dict(keys=[ast.Constant('Status')],values=[ast.Constant('Active')])
        else:
            for branch in outer.body:
                if isinstance(branch,ast.If):
                    for n in branch.body:
                        if isinstance(n,ast.Assign) and remote_write(n):n.value=ast.Dict(keys=[],values=[])
        need(not remote_write(fn))
        if name in ('upload','group_assets'):
            for node in ast.walk(fn):
                if isinstance(node,ast.Constant) and node.value=='Active':node.value='LocalOnly'
                if isinstance(node,ast.Dict) and any(isinstance(k,ast.Constant) and k.value=='status' for k in node.keys):
                    indexes=[i for i,k in enumerate(node.keys) if isinstance(k,ast.Constant) and k.value=='statusMessage']
                    message=ast.Constant('remote_registration_not_authorized')
                    if indexes:node.values[indexes[0]]=message
                    else:node.keys.append(ast.Constant('statusMessage'));node.values.append(message)
        env=dict(namespace);exec(compile(ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[])),'<preview-local-portrait-upload>','exec'),env)
        result[name]=env[name]
    return result


def install_local_uploads(route):
    compiled=compile_local_uploads(Path(route.__file__).read_text(),route.__dict__)
    for name,replacement in compiled.items():
        view=getattr(route,name)
        handler=view.cls.post
        original=next((cell.cell_contents for cell in (handler.__closure__ or ()) if callable(cell.cell_contents) and getattr(cell.cell_contents,'__name__',None)==name),None)
        need(original is not None and original.__closure__ is None)
        # Preserve existing api_view/auth wrappers and URL-bound callbacks exactly.
        original.__code__=replacement.__code__


def apply(*,route,portrait_sync,db,check_identity):
    """Explicit dependency injection supports actual isolated Django qualification."""
    from django.db import transaction
    from rest_framework.response import Response
    from apps.assets.models import PortraitAsset,PortraitGroup
    from apps.common.leases import now_ms
    need(not getattr(route,'_preview_tombstones_installed',False))
    check_identity()
    install_local_uploads(route)
    old_sync=portrait_sync.sync_portraits
    @functools.wraps(old_sync)
    def sync(*args,**kwargs):
        check_identity()
        return visible_result(old_sync(*args,**kwargs))
    portrait_sync.sync_portraits=sync
    # Imported function aliases must also use the filtered result.
    for name in ('apps.assets.views','apps.assets.portraits'):
        try:module=importlib.import_module(name)
        except ImportError:continue
        if getattr(module,'sync_portraits',None) is old_sync:module.sync_portraits=sync
    if getattr(route,'sync_portraits',None) is old_sync:route.sync_portraits=sync
    old_assets=db.list_portrait_assets;old_all=db.list_all_portrait_assets;old_groups=db.list_portrait_groups
    db.list_portrait_assets=lambda *a,**k:visible_assets(old_assets(*a,**k))
    db.list_all_portrait_assets=lambda *a,**k:visible_assets(old_all(*a,**k))
    db.list_portrait_groups=lambda *a,**k:visible_groups(old_groups(*a,**k))
    old_upsert=db.upsert_portrait_asset
    def upsert(asset):
        check_identity()
        with transaction.atomic():
            PortraitGroup.objects.select_for_update().filter(pk=asset['groupId']).first()
            existing=PortraitAsset.objects.select_for_update().filter(pk=asset['id']).first()
            if existing is None and asset.get('byteplusAssetId'):
                existing=PortraitAsset.objects.select_for_update().filter(byteplus_asset_id=asset['byteplusAssetId']).first()
            if existing and existing.status==TOMBSTONE:return db.asset_json(existing)
            return old_upsert(asset)
    db.upsert_portrait_asset=upsert
    old_status=db.update_portrait_asset_status
    def update_status(identifier,status,message=None):
        check_identity()
        with transaction.atomic():
            row=PortraitAsset.objects.select_for_update().filter(byteplus_asset_id=identifier).first()
            if row and row.status==TOMBSTONE:return db.asset_json(row)
            return old_status(identifier,status,message)
    db.update_portrait_asset_status=update_status
    def archive(asset):
        check_identity()
        with transaction.atomic():
            # Same lock order as stock removal; group markers cannot be raced away.
            PortraitGroup.objects.select_for_update().get(pk=asset['groupId'])
            row=PortraitAsset.objects.select_for_update().get(pk=asset['id'],group_id=asset['groupId'])
            if row.status!=TOMBSTONE:
                PortraitAsset.objects.filter(pk=row.id).update(status=TOMBSTONE,updated_at=now_ms())
    route.remove_portrait_asset=archive
    # Remote identities and original media remain physically intact.
    route.cleanup_deleted_portraits=lambda *a,**k:None
    view=route.portraits;old_delete=view.cls.delete
    def guarded_delete(self,request,*args,**kwargs):
        check_identity()
        if not request.query_params.get('assetId') and request.query_params.get('id'):
            actor=route.lookup(request)
            if actor is not None:
                return Response({'error':'PREVIEW_PORTRAIT_GROUP_DELETE_REQUIRES_ARCHIVE'},status=409)
        return old_delete(self,request,*args,**kwargs)
    view.cls.delete=guarded_delete
    # Defense in depth: no internal caller may hard-delete a group or a marker.
    def group_hold(*args,**kwargs):raise ValueError('Preview portrait group hard delete HOLD')
    db.delete_portrait_group=group_hold
    def asset_archive(identifier):
        asset=db.get_portrait_asset(identifier) or db.get_portrait_asset_by_byteplus_id(identifier)
        if asset:archive(asset)
        return asset
    db.delete_portrait_asset=asset_archive
    route._preview_tombstones_installed=True
    return {'status':'INSTALLED_PREVIEW_PORTRAIT_TOMBSTONES','remote_writes':False,'schema_changes':False}


def install():
    import importlib as _importlib
    route=_importlib.import_module('apps.assets.portraits')
    sync=_importlib.import_module('apps.assets.portrait_sync')
    return apply(route=route,portrait_sync=sync,db=sync.db,check_identity=lambda:None)
