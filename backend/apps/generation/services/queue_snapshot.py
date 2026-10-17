"""Single-query queue fairness/spend snapshot, ported from the source contract.

lane_running skips video jobs whose provider task has finished (poller.DOWNLOAD_PENDING, or the provider reported
succeeded) and only our download is left: BytePlus no longer runs them. Spend skips failures marked unbilled (a throttle).
"""
SQL = r'''
with global_user_limit as (
      select coalesce(
        max(case when value ~ '^[0-9]{1,9}$' and value::int >= 1 then value::int end),
        %(user_default)s
      ) as value
      from settings where key = 'maxConcurrentJobs'
    ), running_by_user as (
      select user_id, count(*)::int as n
      from generations
      where status = 'running' and kind in ('image', 'video') and user_id is not null
      group by user_id
    ), ranked_queue as (
      select q.id, q.kind, q.model, q.created_at,
        row_number() over (
          partition by coalesce(q.user_id::text, q.id::text)
          order by q.created_at asc, q.id asc
        ) as user_rank,
        coalesce(r.n, 0) as user_running,
        least(coalesce(
          case when ul.value ~ '^[0-9]{1,9}$' and ul.value::int >= 1 then ul.value::int end,
          gl.value
        ), %(user_max)s) as user_cap
      from generations q
      cross join global_user_limit gl
      left join running_by_user r on r.user_id = q.user_id
      left join user_limits ul on ul.user_id = q.user_id and ul.key = 'maxConcurrentJobs'
      where q.status = 'queued' and q.kind in ('image', 'video') and q.user_id is not null
    ), eligible_queue as (
      select * from ranked_queue
      where user_rank <= greatest(user_cap - user_running, 0)
    )
    select
      (select count(*) from generations
        where status = 'running' and kind = %(kind)s) as running,
      (select count(*) from eligible_queue
        where id <> %(item_id)s::uuid and kind = %(kind)s
          and (created_at, id) < (%(created_at)s, %(item_id)s::uuid)) as older,
      exists(select 1 from eligible_queue where id = %(item_id)s::uuid) as user_eligible,
      (select count(*) from generations
        where status = 'running' and kind = 'video' and model = any(%(lane_models)s::text[])
          and coalesce(provider_status, '') not in ('DOWNLOAD_PENDING', 'succeeded')) as lane_running,
      (select count(*) from eligible_queue
        where id <> %(item_id)s::uuid and kind = 'video' and model = any(%(lane_models)s::text[])
          and (created_at, id) < (%(created_at)s, %(item_id)s::uuid)) as lane_older,
      (select coalesce(sum(
          case when status = 'running' then cost_cents * %(best_of)s else cost_cents end
        ), 0) from generations
        where created_at > %(skirt_start)s
          and updated_at >= %(window_start)s
          and status in ('running', 'succeeded', 'failed')
          and ((kind = 'image' and model not in ('Seedream 5.0 Pro', 'seedream-5-pro')) or model = 'Gemini Omni Flash')
          and not (status = 'failed' and (coalesce(error, '') like '%%429%%' or coalesce(provider_responses @> '[{"unbilled": true}]', false)))
      ) as window_cents,
      (select count(*) from generations
        where created_at > %(skirt_start)s
          and updated_at >= %(window_start)s
          and status in ('running', 'succeeded', 'failed')
          and ((kind = 'image' and model not in ('Seedream 5.0 Pro', 'seedream-5-pro')) or model = 'Gemini Omni Flash')
          and not (status = 'failed' and (coalesce(error, '') like '%%429%%' or coalesce(provider_responses @> '[{"unbilled": true}]', false)))
      ) as window_rows,
      (select min(updated_at) from generations
        where created_at > %(skirt_start)s
          and updated_at >= %(window_start)s
          and status in ('running', 'succeeded', 'failed')
          and ((kind = 'image' and model not in ('Seedream 5.0 Pro', 'seedream-5-pro')) or model = 'Gemini Omni Flash')
          and not (status = 'failed' and (coalesce(error, '') like '%%429%%' or coalesce(provider_responses @> '[{"unbilled": true}]', false)))
      ) as oldest_updated_at
'''
