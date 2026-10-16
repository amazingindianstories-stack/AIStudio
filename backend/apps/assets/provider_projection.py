"""Provider-path projections that never query users.

The generation worker's database role cannot read ``users``; the API
serializers include uploader details, so provider execution uses these.
"""


def provider_portrait_projection(row):
    result = {'id': str(row.id), 'groupId': str(row.group_id), 'assetType': row.asset_type,
              'role': row.role, 'imageUrl': row.image_url, 'status': row.status,
              'createdAt': row.created_at, 'updatedAt': row.updated_at}
    for field, key in (('byteplus_asset_id', 'byteplusAssetId'), ('name', 'name'), ('status_message', 'statusMessage')):
        value = getattr(row, field)
        if value is not None:
            result[key] = value
    if row.created_by_id:
        result['createdById'] = str(row.created_by_id)
    return result


def provider_asset_projection(row):
    result = {'id': str(row.id), 'kind': row.kind, 'name': row.name, 'slug': row.slug,
              'images': row.images if row.images is not None else [], 'createdAt': row.created_at, 'updatedAt': row.updated_at}
    if row.description is not None:
        result['description'] = row.description
    if row.project_id is not None:
        result['projectId'] = str(row.project_id)
    result['createdById'] = str(row.created_by_id) if row.created_by_id else None
    return result
