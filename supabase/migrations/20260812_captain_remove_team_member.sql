-- ===========================================================================
-- A captain can drop a swimmer from their roster.
--
-- The capability was already granted by RLS in spirit — captains manage their
-- team — but there was no way to do it. And the obvious implementation is
-- wrong: the roster is public.athletes.team_id, NOT public.team_memberships.
-- Deleting a membership row leaves team_id set, so the swimmer stays on the
-- roster while the UI reports success. Many roster members have no membership
-- row at all (invited swimmers, or ones an admin placed directly).
--
-- Clearing team_id is the real operation, and no policy on public.athletes
-- lets a captain do it, hence SECURITY DEFINER with the captaincy check made
-- explicitly inside.
--
-- Safe on a live meet: it adds a function and grants execute. Nothing
-- existing changes behaviour until a captain actually uses it.
-- ===========================================================================

create or replace function public.captain_remove_team_member(p_athlete_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team    uuid;
  v_user    uuid;
  v_captain uuid;
  v_squads  integer;
begin
  select a.team_id, a.user_id into v_team, v_user
  from public.athletes a
  where a.id = p_athlete_id;

  if v_team is null then
    raise exception 'That swimmer is not on a team.';
  end if;

  if not public.is_team_captain_of(v_team) then
    raise exception 'Only the team captain may remove a member.';
  end if;

  select captain_id into v_captain from public.teams where id = v_team;
  if v_user is not null and v_user = v_captain then
    raise exception
      'A captain cannot remove themselves from their own team. Ask an admin to reassign the captaincy first.';
  end if;

  -- A relay squad requires every leg to be on the team
  -- (public.validate_relay_squad). That validator only re-runs when the LEGS
  -- change, so silently clearing team_id here would leave a committed squad
  -- that is invalid and would never be re-checked — it would simply race with
  -- an ineligible swimmer. Refusing is the honest outcome: the captain drops
  -- them from the squad first, which is a decision only they should make.
  select count(*) into v_squads
  from public.relay_legs rl
  join public.relay_squads rs on rs.id = rl.squad_id
  where rl.athlete_id = p_athlete_id and rs.team_id = v_team;

  if v_squads > 0 then
    raise exception
      'This swimmer is in % relay squad(s) for your team. Remove them from those squads first.',
      v_squads;
  end if;

  update public.athletes set team_id = null where id = p_athlete_id;

  -- Clear the membership record too, so they are free to apply again. The
  -- one_pending_team_membership_per_user index means a stale accepted row
  -- would otherwise sit in their way.
  if v_user is not null then
    delete from public.team_memberships
    where user_id = v_user and team_id = v_team;
  end if;
end;
$$;

comment on function public.captain_remove_team_member(uuid) is
  'Drops a swimmer from the caller''s team by clearing athletes.team_id — the '
  'column that IS the roster — and removing their team_memberships row. '
  'Refuses to remove the captain, or a swimmer still committed to one of the '
  'team''s relay squads. Past volume affiliations are never rewritten.';

grant execute on function public.captain_remove_team_member(uuid) to authenticated;
