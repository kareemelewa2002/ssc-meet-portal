-- Advances the fresh pre-meet seed (supabase/seed-demo.sql) into a playable
-- "meet in progress" state for Playwright E2E:
--   1. Confirm cash payments  -> generate_heats_on_confirm builds heats/lanes
--   2. Publish 50m Freestyle sample times (Skins source event)
--   3. Materialise + publish Skins Round of 6 for every full board
--
-- Deliberately leaves non-Freestyle heats unscored so freeRegistrationSlots()
-- can still reclaim capacity for the registration specs.
--
-- Requires SUPABASE_DB_URL / a direct postgres connection. Sets auth.uid() to
-- the seeded admin so enforce_entry_status_change / enforce_result_publish /
-- materialise_skins_heat / sync_skins_invitations all pass.

do $$
declare
  v_admin uuid;
  v_skins uuid;
  v_confirmed integer;
  v_results integer;
  r record;
  v_ids uuid[];
  v_lanes integer[] := array[4, 3, 5, 2, 1, 6];
  v_n integer;
  i integer;
  v_lane_ids uuid[];
begin
  select id into v_admin from auth.users where email = 'elewakareem2002@gmail.com';
  if v_admin is null then
    raise exception 'seed-played-meet: admin account elewakareem2002@gmail.com is missing';
  end if;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  -- 1. Confirm every pending individual entry. Relays/Skins stay untouched —
  -- Skins entries are created by materialise_skins_heat; relays are captain-built.
  update public.entries e
  set status = 'confirmed'
  from public.events ev
  where e.event_id = ev.id
    and e.status = 'pending_payment'
    and ev.is_skins = false
    and ev.is_relay = false;
  get diagnostics v_confirmed = row_count;

  if v_confirmed = 0 and not exists (select 1 from public.heats where skins_round is null) then
    raise exception 'seed-played-meet: no pending payments to confirm and no heats exist';
  end if;

  -- 2. Sample published times on 50m Freestyle only — enough for Skins
  -- qualifiers, all-time records, and athlete career ledgers, without locking
  -- every entry behind a result (registration capacity cleanup needs that).
  insert into public.results (
    heat_lane_id,
    result_outcome,
    official_time_ms,
    placement_points,
    improvement_points,
    status
  )
  select
    hl.id,
    'valid',
    26000 + (abs(hashtext(hl.id::text)) % 8000),
    0,
    0,
    'published'
  from public.heat_lanes hl
  join public.heats h on h.id = hl.heat_id
  join public.events ev on ev.id = h.event_id
  where ev.name = '50m Freestyle'
    and ev.is_skins = false
  on conflict (heat_lane_id) do update
    set result_outcome = excluded.result_outcome,
        official_time_ms = excluded.official_time_ms,
        status = 'published';
  get diagnostics v_results = row_count;

  if v_results = 0 then
    raise exception 'seed-played-meet: no 50m Freestyle lanes to score — heats were not generated';
  end if;

  -- 3. Skins: sync invitations from the published Freestyle field, then open
  -- and publish Round of 6 on every board that has active qualifiers.
  select id into v_skins from public.events where is_skins = true limit 1;
  if v_skins is null then
    raise exception 'seed-played-meet: no Skins event (is_skins = true) in the programme';
  end if;

  perform public.sync_skins_invitations(v_skins);

  for r in
    select category, gender
    from (
      select q.category, q.gender, count(*)::int as n
      from public.get_skins_qualifiers(v_skins) q
      where q.is_active_qualifier
      group by 1, 2
    ) s
    where n >= 2
  loop
    select coalesce(array_agg(q.athlete_id order by q.source_rank), '{}')
      into v_ids
    from public.get_skins_qualifiers(v_skins) q
    where q.is_active_qualifier
      and q.category = r.category
      and q.gender = r.gender;

    v_n := coalesce(array_length(v_ids, 1), 0);
    if v_n = 0 then
      continue;
    end if;

    perform public.materialise_skins_heat(
      v_skins,
      r.category,
      r.gender,
      v_ids[1:v_n],
      v_lanes[1:v_n],
      6,
      false
    );

    select array_agg(hl.id order by array_position(v_lanes, hl.lane_number))
      into v_lane_ids
    from public.heats h
    join public.heat_lanes hl on hl.heat_id = h.id
    where h.event_id = v_skins
      and h.skins_category = r.category
      and h.gender = r.gender
      and h.skins_round = 6
      and coalesce(h.skins_swim_off, false) = false;

    for i in 1..coalesce(array_length(v_lane_ids, 1), 0) loop
      insert into public.results (
        heat_lane_id,
        result_outcome,
        official_time_ms,
        finish_place,
        placement_points,
        improvement_points,
        status
      ) values (
        v_lane_ids[i],
        'valid',
        null,
        i,
        greatest(0, 6 - i + 1),
        0,
        'published'
      )
      on conflict (heat_lane_id) do update
        set result_outcome = 'valid',
            finish_place = excluded.finish_place,
            placement_points = excluded.placement_points,
            official_time_ms = null,
            status = 'published';
    end loop;
  end loop;

  -- Join-request specs need athlete39 unattached with no leftover pending
  -- membership row — earlier runs (or a skipped cancel) leave Request buttons
  -- disabled under the single-pending-request rule.
  delete from public.team_memberships
  where status = 'pending'
    and user_id in (select id from auth.users where email = 'athlete39@ssc-demo.test');

  update public.athletes a
  set team_id = null
  from public.users u
  where u.id = a.user_id
    and u.email = 'athlete39@ssc-demo.test';

  raise notice 'seed-played-meet: confirmed % entries, scored % Freestyle lanes, Skins boards ready',
    v_confirmed, v_results;
end $$;
