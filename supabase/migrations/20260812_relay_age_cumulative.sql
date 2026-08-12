-- ===========================================================================
-- Relay squads accept their own age group and younger.
--
-- WHAT WAS WRONG
-- --------------
-- validate_relay_squad() required an EXACT age_group match on all four legs:
--
--     count(*) filter (where a.age_group <> v_squad.age_group)
--
-- Every other board in this schema is cumulative. public.event_results ranks
-- a 14 & Under swimmer in the 14 & Under standing, the 17 & Under standing
-- AND the Open standing, because Open means open to everyone. So a U14 could
-- hold a place on the Open board and still be refused an Open relay — "Open"
-- meant two different things depending on the screen.
--
-- WHAT IT DOES NOW
-- ----------------
--     Open squad -> U14, U17 and Open swimmers
--     U17  squad -> U14 and U17 swimmers
--     U14  squad -> U14 swimmers only
--
-- Cumulative UPWARD only. An older swimmer still cannot drop into a younger
-- squad, which is the entire purpose of the age bands.
--
-- Safe on a live meet: this only RELAXES a validation. Every squad that was
-- legal before is still legal, so no existing squad can be invalidated by it.
-- The trigger is a deferred constraint trigger on relay_legs and is not
-- re-evaluated for rows already committed.
-- ===========================================================================

create or replace function public.relay_age_eligible(
  p_squad_age public.age_group,
  p_athlete_age public.age_group
)
returns boolean
language sql
immutable
as $$
  select case p_squad_age
    when 'Open' then true
    when 'U17'  then p_athlete_age in ('U14', 'U17')
    else p_athlete_age = 'U14'
  end;
$$;

comment on function public.relay_age_eligible(public.age_group, public.age_group) is
  'Whether a swimmer of one age group may swim in a squad of another. '
  'Cumulative: Open accepts every age, 17 & Under accepts 14 & Under too, '
  '14 & Under accepts only itself — the same "this age and younger" rule '
  'public.event_results uses for standings.';

-- ---------------------------------------------------------------------------
-- Re-create the validator with the age check swapped. Everything else in this
-- function is unchanged from schema.sql — team, gender split, "already
-- entered in the meet", and one-squad-per-swimmer-per-event.
-- ---------------------------------------------------------------------------
create or replace function public.validate_relay_squad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_squad_id uuid;
  v_squad public.relay_squads%rowtype;
  v_event public.events%rowtype;
  v_legs integer;
  v_male integer;
  v_female integer;
  v_need_male integer;
  v_need_female integer;
  v_wrong_team integer;
  v_wrong_age integer;
  v_not_entered integer;
  v_volume_id uuid;
begin
  v_squad_id := coalesce(new.squad_id, old.squad_id);

  select * into v_squad from public.relay_squads where id = v_squad_id;
  -- Squad deleted in the same transaction: its legs go with it, nothing to check.
  if v_squad.id is null then
    return null;
  end if;

  select * into v_event from public.events where id = v_squad.event_id;

  if not coalesce(v_event.is_relay, false) then
    raise exception 'Relay squads can only be entered for relay events.';
  end if;

  select s.meet_volume_id into v_volume_id
  from public.sessions s where s.id = v_event.session_id;

  select count(*) into v_legs from public.relay_legs where squad_id = v_squad_id;
  if v_legs <> 4 then
    raise exception 'A relay squad needs exactly 4 swimmers (this one has %).', v_legs;
  end if;

  select
    count(*) filter (where a.gender = 'male'),
    count(*) filter (where a.gender = 'female'),
    count(*) filter (where a.team_id is distinct from v_squad.team_id),
    count(*) filter (where not public.relay_age_eligible(v_squad.age_group, a.age_group))
  into v_male, v_female, v_wrong_team, v_wrong_age
  from public.relay_legs rl
  join public.athletes a on a.id = rl.athlete_id
  where rl.squad_id = v_squad_id;

  if v_wrong_team > 0 then
    raise exception 'Every swimmer in a relay squad must be on that team (% are not).', v_wrong_team;
  end if;

  if v_wrong_age > 0 then
    raise exception
      '% swimmer(s) are too old for a % squad. Squads are open to their own age group and younger.',
      v_wrong_age, v_squad.age_group;
  end if;

  select male_count, female_count into v_need_male, v_need_female
  from public.relay_gender_requirement(v_event.name);

  if v_male <> v_need_male or v_female <> v_need_female then
    raise exception
      '% needs % male and % female swimmers (this squad has % male, % female).',
      v_event.name, v_need_male, v_need_female, v_male, v_female;
  end if;

  -- Already entered in this meet: a relay swimmer must be competing in it,
  -- not brought in for the relay alone.
  select count(*) into v_not_entered
  from public.relay_legs rl
  where rl.squad_id = v_squad_id
    and not exists (
      select 1
      from public.entries en
      join public.events ev on ev.id = en.event_id
      join public.sessions se on se.id = ev.session_id
      where en.athlete_id = rl.athlete_id
        and se.meet_volume_id = v_volume_id
    );
  if v_not_entered > 0 then
    raise exception
      '% swimmer(s) are not entered in this meet. Relay swimmers must already have an individual entry.',
      v_not_entered;
  end if;

  -- One squad per swimmer per event, across every team — checked here rather
  -- than with a unique index because the event lives on the squad, not the leg.
  if exists (
    select 1
    from public.relay_legs rl
    join public.relay_squads rs on rs.id = rl.squad_id
    join public.relay_legs mine on mine.athlete_id = rl.athlete_id
    where mine.squad_id = v_squad_id
      and rs.event_id = v_squad.event_id
      and rs.id <> v_squad_id
  ) then
    raise exception 'A swimmer can only be in one squad per relay event.';
  end if;

  return null;
end;
$$;
