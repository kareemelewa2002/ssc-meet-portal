-- ===========================================================================
-- Which meet volumes are visible, and to whom.
--
-- Visibility is defined in exactly one place — public.volume_is_public():
--
--     visible to the public  <=>  is_public = true AND status <> 'planned'
--
-- Admins bypass that (every policy reads `is_admin() or volume_is_public(..)`),
-- which is deliberate: someone has to be able to build the next volume before
-- it is announced. So "an admin can see Vol. 2" is correct behaviour, not a
-- leak. What would be a leak is a NON-admin seeing it.
--
-- SECTION 1 is read-only and safe to run against production at any time.
-- SECTION 2 is commented out and only needed if section 1 shows something
-- exposed that should not be.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. REPORT — what every volume's visibility currently is.
-- ---------------------------------------------------------------------------
select
  mv.volume_number,
  mv.name,
  mv.status,
  mv.is_public,
  public.volume_is_public(mv.id) as visible_to_everyone,
  case
    when public.volume_is_public(mv.id) then 'PUBLIC — every signed-in role sees this'
    else 'HIDDEN — admins only'
  end as effect,
  (select count(*) from public.entries e
     join public.events ev on ev.id = e.event_id
     join public.sessions s on s.id = ev.session_id
    where s.meet_volume_id = mv.id) as entries
from public.meet_volumes mv
order by mv.volume_number;

-- ---------------------------------------------------------------------------
-- 2. FIX — hide everything except Vol. 1.
--
-- Only needed if section 1 reports a volume other than 1 as PUBLIC. Setting
-- is_public = false is enough on its own; status is left alone so a volume
-- mid-build keeps whatever state it was in.
--
-- Uncomment to run.
-- ---------------------------------------------------------------------------
-- update public.meet_volumes
--    set is_public = false
--  where volume_number <> 1
--    and is_public = true;

-- ---------------------------------------------------------------------------
-- 3. CONFIRM — Vol. 1 itself is actually public.
--
-- The opposite failure is just as likely and much noisier: if Vol. 1 is
-- is_public = false or still 'planned', every non-admin sees an empty app and
-- cannot register at all.
-- ---------------------------------------------------------------------------
do $$
declare
  v_visible boolean;
  v_status text;
  v_public boolean;
begin
  select public.volume_is_public(id), status::text, is_public
    into v_visible, v_status, v_public
  from public.meet_volumes where volume_number = 1;

  if v_visible is null then
    raise notice 'Vol. 1 does not exist in this database.';
  elsif v_visible then
    raise notice 'OK — Vol. 1 is public (status=%, is_public=%).', v_status, v_public;
  else
    raise notice
      'PROBLEM — Vol. 1 is HIDDEN (status=%, is_public=%). Non-admins cannot see or enter the meet. Fix with: update public.meet_volumes set is_public = true, status = ''scheduled'' where volume_number = 1;',
      v_status, v_public;
  end if;
end;
$$;
