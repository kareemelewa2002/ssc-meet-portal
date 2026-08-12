// Hand-written types mirroring supabase/schema.sql.
// Regenerate with `supabase gen types typescript` once the project is linked,
// and replace this file — keep the shape identical so imports don't break.
//
// NOTE: Row types are declared with `type`, not `interface`. Interfaces don't
// get an implicit index signature in TypeScript, so they fail the
// `Record<string, unknown>` structural check that @supabase/postgrest-js
// uses internally — that mismatch silently collapses every table's inferred
// type to `never`.

// Scope-locked to exactly 5 roles. 'usher'/'entry_helper' folded into
// 'referee' (a single consolidated deck-official role now handles both
// lane assignment and time entry); 'team_captain' folded into 'coach'
// (teams.captain_id already tracks "who manages this team" independently
// of the role column — a coach can be a team's captain without a distinct
// role value for it).
// 'coach' retired: captaincy is teams.captain_id, a relationship, not a role.
export type UserRole = "admin" | "referee" | "athlete" | "parent";

// No 'coach': captaincy is granted by an admin setting teams.captain_id,
// not claimed at signup.
export type PublicSignupRole = "athlete" | "parent" | "referee";

export type AgeGroup = "U14" | "U17" | "Open";

export type PublishStatus = "draft" | "published";

export type MembershipStatus = "pending" | "accepted" | "invited";

export type HeatGroup = "U13_14" | "U17_OPEN";

export type DqReason =
  | "false_start"
  | "stroke_infraction"
  | "turn_infraction"
  | "turn_stroke_violation"
  | "finish_infraction"
  | "unsporting_conduct"
  | "other";

export type ResultOutcome = "valid" | "dq" | "no_show";

export type SkinsResponse = "pending" | "accepted" | "declined";

export type Gender = "male" | "female";

export type VolumeStatus = "planned" | "scheduled" | "completed";


export type AwardType = "best_swimmer" | "most_improved";

export type ParentLinkStatus = "none" | "pending" | "verified";

/**
 * 'hold_expired' is an unpaid entry whose capacity hold lapsed. The slot is
 * released, but the entry survives — deleting it would make a swimmer's
 * registration vanish with nothing left to reclaim.
 */
export type EntryStatus = "pending_payment" | "confirmed" | "hold_expired";

export type AppSettingsRow = {
  id: boolean;
  superadmin_email: string;
  updated_at: string;
};

export type UserRow = {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  profile_image_url: string | null;
  role: UserRole;
  created_at: string;
  updated_at: string;
};

export type TeamRow = {
  id: string;
  name: string;
  abbreviation: string | null;
  team_logo_url: string | null;
  captain_id: string | null;
  approved_by_admin: boolean;
  created_at: string;
  updated_at: string;
};

/** public.heat_projected_starts — a VIEW. Projected wall-clock start per
 * heat: session start + the turnaround of every preceding heat in that
 * session. Computed with the view owner's privileges so DRAFT heats still
 * count toward the ordinal — a client summing only the heats it can read
 * (heats' policy is status = 'published') reports a start that is too early.
 * Approximate by nature: assumes no breaks, scratches or delay. */
export type HeatProjectedStartRow = {
  heat_id: string;
  session_id: string;
  /** 'HH:MM:SS' */
  projected_start: string;
};

/** public.event_results — overall standings across every heat of an event.
 * Includes DQ and NS rows: they carry is_ranked = false and a null place, so
 * a disqualified swimmer shows at the bottom of the standing rather than
 * vanishing from it. */
export type EventResultRow = {
  event_id: string;
  event_name: string;
  stroke: string;
  distance_m: number;
  session_id: string;
  /** Running order within the meet. Sort standings by
   * (session_number, event_order) — sorting by event_name is alphabetical,
   * which puts "100m Free" ahead of "50m Fly" and produces an order matching
   * no session that was ever swum. */
  session_number: number;
  event_order: number;
  meet_volume_id: string;
  /** Time-drop points for this swim. A property of the swim rather than of a
   * board, so the same value appears on every board row for that swim. */
  improvement_points: number;
  /** The board this row belongs to. Not mutually exclusive: "Open" means
   * open to all ages, so a U14 swimmer appears in both U14 and Open. */
  age_group: AgeGroup;
  /** The swimmer's actual age group, which differs from age_group on an
   * Open-board row for a younger swimmer. */
  own_age_group: AgeGroup;
  /** True when this row is a younger swimmer ranked in the Open standings. */
  is_open_entry: boolean;
  gender: Gender;
  athlete_id: string;
  athlete_name: string;
  team_name: string | null;
  /** Restarts per (age group, gender) — identifies a heat only together with
   * those. heat_order is the event-wide running order. */
  heat_number: number;
  heat_order: number;
  lane_number: number;
  /** Null on DQ and NS — neither produced a time. */
  official_time_ms: number | null;
  result_outcome: ResultOutcome;
  dq_code: DqReason | null;
  /** False for DQ/NS. The flag standings sort on. */
  is_ranked: boolean;
  /** World Aquatics points, or null when the event has no base time on file
   * (relays, Skins, the switch events) — "unrated", never zero. */
  wa_points: number | null;
  /** Null on DQ and NS: they have no place, and a 0 would read as one. */
  event_place: number | null;
};

/** public.performance_highlights — every published swim scored in World
 * Aquatics points, flagged if it is the best anywhere or best in its event.
 * Switch events never appear: no base time, so no points, by design. */
export type PerformanceHighlightRow = {
  result_id: string;
  athlete_id: string;
  athlete_name: string;
  team_name: string | null;
  gender: Gender;
  age_group: AgeGroup;
  event_id: string;
  event_name: string;
  stroke: string;
  distance_m: number;
  meet_volume_id: string;
  volume_number: number;
  volume_name: string;
  official_time_ms: number;
  wa_points: number;
  swam_at: string;
  is_best_overall: boolean;
  is_best_in_event: boolean;
};

/** public.wa_base_times — World Aquatics base times per stroke x distance x
 * gender (short course). An event with no row here is deliberately
 * unrateable, which callers must render as "—" and never as 0. */
export type WaBaseTimeRow = {
  stroke: string;
  distance_m: number;
  gender: Gender;
  base_time_ms: number;
  updated_at: string;
};

/** public.relay_squads — a team's four-swimmer entry for a relay event. */
export type RelaySquadRow = {
  id: string;
  event_id: string;
  team_id: string;
  age_group: AgeGroup;
  squad_letter: string;
  status: EntryStatus;
  /** When an unpaid squad stops holding its relay-event capacity slot. Same
   * mechanism as entries.hold_expires_at. Null once paid. */
  hold_expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** One row per PAID relay squad — the captain is billed for the whole squad,
 * never split across the four swimmers on it. */
export type RelaySquadPaymentRow = {
  id: string;
  squad_id: string;
  amount_egp: number;
  method: string;
  collected_by: string | null;
  collected_at: string;
  note: string | null;
};

/** Captain-authored, team-wide message. Distinct from public.notifications —
 * this is the message itself; each member's own notification is a
 * per-recipient pointer back to it. */
export type TeamAnnouncementRow = {
  id: string;
  team_id: string;
  author_id: string | null;
  title: string;
  body: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
};

/** One append-only row per privileged write: a role change, a payment
 * override/cash confirmation, or a pricing change. Written exclusively by
 * database triggers (see log_admin_action() in schema.sql) — never inserted
 * from application code directly. */
export type AdminActionRow = {
  id: string;
  created_at: string;
  actor_id: string;
  action: string;
  target_table: string;
  target_id: string | null;
  details: Record<string, unknown>;
};

export type RelayLegRow = {
  id: string;
  squad_id: string;
  leg_number: number;
  athlete_id: string;
  created_at: string;
};

export type TeamMembershipRow = {
  id: string;
  team_id: string;
  user_id: string;
  status: MembershipStatus;
  requested_at: string;
  responded_at: string | null;
};

export type TeamInviteLinkRow = {
  id: string;
  team_id: string;
  token: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  use_count: number;
};

export type AthleteRow = {
  id: string;
  user_id: string;
  team_id: string | null;
  parent_id: string | null;
  date_of_birth: string;
  age: number;
  age_group: AgeGroup;
  gender: Gender;
  /** Safety & privacy acknowledgement. NULL = outstanding. For a U14 this can
   * only be set by their linked parent (public.accept_safety_acknowledgement). */
  safety_accepted_at: string | null;
  safety_accepted_by: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  specialty_events: string[];
  parent_link_status: ParentLinkStatus;
  pending_parent_email: string | null;
  approved_by_admin: boolean;
  created_at: string;
  updated_at: string;
};

// public.volume_team_affiliations — historical team representation per
// volume. Distinct from athletes.team_id (the swimmer's current team),
// since past result ledgers must keep showing the team they actually swam
// for at the time, even after they transfer.
export type VolumeTeamAffiliationRow = {
  id: string;
  athlete_id: string;
  meet_volume_id: string;
  team_id: string | null;
  created_at: string;
  updated_at: string;
};

export type MeetVolumeRow = {
  id: string;
  volume_number: number;
  name: string;
  meet_date: string | null;
  status: VolumeStatus;
  /** Announced to the public. A volume is visible to non-admins only when
   * BOTH this is true AND status !== 'planned' — see volume_is_public() in
   * schema.sql, the single enforced definition of that rule. */
  is_public: boolean;
  created_at: string;
  updated_at: string;
};

/** public.meet_settings — the Admin Control Unit's per-volume dials. The
 * source of truth for pricing: there is deliberately no client-side default,
 * only the DB column default (see supabase/schema.sql). */
/** One Control Unit row per (volume, session 1-3). Session start/end times are
 * NOT here — public.sessions owns those; see the table comment in schema.sql. */
export type PricingTierValue = "early_bird" | "standard" | "late";

export type EventAvailabilityValue = "available" | "selling_out_soon" | "full";

export type NotificationCategoryValue =
  | "team"
  | "entry_payment"
  | "waitlist"
  | "results_schedule"
  | "announcement";

export type WaitlistStatusValue =
  | "waiting"
  | "offered"
  | "claimed"
  | "expired"
  | "withdrawn";

export type EmailDeliveryStatusValue = "pending" | "sent" | "failed" | "skipped";

/**
 * One row per VOLUME. It was one row per session for a single release; pricing
 * moved to packages counted across the whole meet, and turnaround moved to
 * public.events, which left the per-session shape holding nothing.
 */
export type MeetSettingsRow = {
  id: string;
  meet_volume_id: string;
  athlete_capacity: number;
  lane_count: number;
  inter_session_break_minutes: number;
  athlete_event_limit: number;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  late_registration_enabled: boolean;
  hold_window_hours: number;
  waitlist_claim_hours: number;
  selling_out_threshold_percent: number;
  default_event_capacity: number;
  relay_swimmer_price_egp: number;
  pinned_pricing_tier: PricingTierValue | null;
  refund_percent: number;
  refund_deadline_days: number | null;
  refund_policy_note: string | null;
  updated_at: string;
};

export type PricingTierRow = {
  id: string;
  meet_volume_id: string;
  tier: PricingTierValue;
  starts_at: string;
  ends_at: string;
  created_at: string;
};

export type PricingPackageRow = {
  id: string;
  meet_volume_id: string;
  /** 1-4 are the packages; 0 is the each-additional-race price. */
  race_count: number;
  tier: PricingTierValue;
  price_egp: number;
  updated_at: string;
};

export type RaceShapeTemplateRow = {
  id: string;
  distance_m: number | null;
  stroke: string | null;
  is_relay: boolean;
  turnaround_seconds: number;
  surcharge_egp: number;
  updated_at: string;
};

export type EventWaitlistRow = {
  id: string;
  event_id: string;
  athlete_id: string;
  status: WaitlistStatusValue;
  requested_at: string;
  offered_at: string | null;
  offer_expires_at: string | null;
  resolved_at: string | null;
};

export type EntryPaymentRow = {
  id: string;
  athlete_id: string;
  meet_volume_id: string;
  tier: PricingTierValue;
  amount_egp: number;
  method: string;
  external_reference: string | null;
  collected_by: string | null;
  collected_at: string;
  note: string | null;
};

export type EntryPaymentItemRow = {
  id: string;
  payment_id: string;
  entry_id: string | null;
  kind: "package" | "surcharge" | "additional_race" | "relay";
  label: string;
  amount_egp: number;
};

export type NotificationRow = {
  id: string;
  user_id: string;
  category: NotificationCategoryValue;
  title: string;
  body: string;
  link_url: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

export type NotificationPreferenceRow = {
  user_id: string;
  category: NotificationCategoryValue;
  email_enabled: boolean;
  updated_at: string;
};

export type EmailOutboxRow = {
  id: string;
  notification_id: string | null;
  user_id: string;
  to_email: string;
  subject: string;
  body: string;
  status: EmailDeliveryStatusValue;
  is_digest: boolean;
  scheduled_for: string;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
};

export type SessionRow = {
  id: string;
  meet_volume_id: string;
  session_number: 1 | 2 | 3;
  name: string;
  meet_date: string;
  start_time: string;
  end_time: string;
  created_at: string;
};

export type EventRow = {
  id: string;
  session_id: string;
  name: string;
  stroke: string;
  distance_m: number;
  event_order: number;
  is_skins: boolean;
  is_relay: boolean;
  /** The 50m stroke-switch events: always entered NT, seeded from World
   * Aquatics points instead of a seed time. */
  seeds_as_nt: boolean;
  /** Wall-clock budget for one heat of THIS race. Seeded from the race-shape
   * template on insert, editable per event — a 50 sprint and a 400 IM do not
   * clear the pool at the same rate. */
  turnaround_seconds: number | null;
  /** Added to the athlete's package price for entering this race. */
  surcharge_egp: number | null;
  /** Maximum entries this race accepts. */
  capacity_cap: number | null;
  created_at: string;
};

export type EntryRow = {
  id: string;
  event_id: string;
  athlete_id: string;
  seed_time_ms: number | null;
  is_nt: boolean;
  status: EntryStatus;
  age_group_at_entry: AgeGroup | null;
  /** When an unpaid entry stops holding its capacity slot. Null once paid. */
  hold_expires_at: string | null;
  created_at: string;
};

export type HeatRow = {
  id: string;
  event_id: string;
  heat_group: HeatGroup;
  gender: Gender | null;
  heat_number: number;
  heat_order: number;
  status: PublishStatus;
  /** Skins only. A Skins board is (age category x gender), which heat_group
   * cannot express because it folds U17 in with Open — so these three carry
   * the board and round identity, and are null on every ordinary heat. */
  skins_category: AgeGroup | null;
  skins_round: number | null;
  skins_swim_off: boolean;
  created_at: string;
  updated_at: string;
};

export type HeatLaneRow = {
  id: string;
  heat_id: string;
  lane_number: number;
  entry_id: string | null;
};

export type ResultRow = {
  id: string;
  heat_lane_id: string;
  result_outcome: ResultOutcome | null;
  official_time_ms: number | null;
  finish_place: number | null;
  dq_code: DqReason | null;
  is_no_show: boolean;
  placement_points: number;
  improvement_points: number;
  status: PublishStatus;
  recorded_by: string | null;
  created_at: string;
  updated_at: string;
};

export type LeaderboardRow = {
  id: string;
  meet_volume_id: string;
  athlete_id: string;
  category: AgeGroup;
  placement_points: number;
  improvement_points: number;
  total_points: number;
  updated_at: string;
};

export type AwardRow = {
  id: string;
  athlete_id: string;
  meet_volume_id: string;
  award_type: AwardType;
  category: AgeGroup;
  gender: Gender;
  created_at: string;
};

// public.series_leaderboards — read-only view summing every volume's
// leaderboard rows per athlete/category.
export type SeriesLeaderboardRow = {
  athlete_id: string;
  category: AgeGroup;
  placement_points: number;
  improvement_points: number;
  total_points: number;
  volumes_counted: number;
};

export type AllTimeBestPerformanceRow = {
  result_id: string;
  athlete_id: string;
  athlete_name: string;
  profile_image_url: string | null;
  team_name: string | null;
  gender: Gender;
  age_group: AgeGroup;
  // Swimmer's age AT THIS RACE (derived from date_of_birth + the volume's
  // meet_date) — never their current live age. See public.age_at_date().
  age_at_swim: number;
  stroke: string;
  distance_m: number;
  event_name: string;
  meet_volume_id: string;
  volume_number: number;
  volume_name: string;
  official_time_ms: number;
  finish_place: number | null;
  swam_at: string;
  rank: number;
};

export type AllTimeBestPerformerRow = {
  athlete_id: string;
  athlete_name: string;
  profile_image_url: string | null;
  team_name: string | null;
  gender: Gender;
  age_group: AgeGroup;
  // Age at the specific race that produced best_time_ms, not the athlete's
  // current age.
  age_at_swim: number;
  stroke: string;
  distance_m: number;
  best_time_ms: number;
  races_counted: number;
  rank: number;
};

export type SkinsQualificationRow = {
  id: string;
  skins_event_id: string;
  athlete_id: string;
  category: AgeGroup;
  source_rank: number;
  best_time_ms: number;
  response: SkinsResponse;
  responded_at: string | null;
  responded_by: string | null;
  created_at: string;
  updated_at: string;
};

export type SkinsQualifierRpcRow = {
  athlete_id: string;
  athlete_name: string;
  team_name: string | null;
  category: AgeGroup;
  gender: Gender;
  source_rank: number;
  best_time_ms: number;
  response: SkinsResponse;
  is_active_qualifier: boolean;
  is_confirmed: boolean;
  slot_number: number | null;
};

// Matches @supabase/postgrest-js's GenericTable shape (Row/Insert/Update/Relationships).
type Table<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

// Matches GenericView's non-updatable shape (Row/Relationships only).
type View<Row> = {
  Row: Row;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      app_settings: Table<AppSettingsRow>;
      users: Table<UserRow>;
      teams: Table<TeamRow>;
      team_memberships: Table<TeamMembershipRow>;
      team_invite_links: Table<TeamInviteLinkRow>;
      event_results: Table<EventResultRow>;
      heat_projected_starts: Table<HeatProjectedStartRow>;
      relay_squads: Table<RelaySquadRow>;
      relay_legs: Table<RelayLegRow>;
      relay_squad_payments: Table<RelaySquadPaymentRow>;
      team_announcements: Table<TeamAnnouncementRow>;
      admin_actions: Table<AdminActionRow>;
      performance_highlights: Table<PerformanceHighlightRow>;
      athletes: Table<AthleteRow>;
      volume_team_affiliations: Table<VolumeTeamAffiliationRow>;
      meet_volumes: Table<MeetVolumeRow>;
      meet_settings: Table<MeetSettingsRow>;
      pricing_tiers: Table<PricingTierRow>;
      pricing_packages: Table<PricingPackageRow>;
      race_shape_templates: Table<RaceShapeTemplateRow>;
      event_waitlist: Table<EventWaitlistRow>;
      entry_payments: Table<EntryPaymentRow>;
      entry_payment_items: Table<EntryPaymentItemRow>;
      notifications: Table<NotificationRow>;
      notification_preferences: Table<NotificationPreferenceRow>;
      email_outbox: Table<EmailOutboxRow>;
      wa_base_times: Table<WaBaseTimeRow>;
      sessions: Table<SessionRow>;
      events: Table<EventRow>;
      entries: Table<EntryRow>;
      heats: Table<HeatRow>;
      heat_lanes: Table<HeatLaneRow>;
      results: Table<ResultRow>;
      leaderboards: Table<LeaderboardRow>;
      awards: Table<AwardRow>;
      skins_qualifications: Table<SkinsQualificationRow>;
    };
    Views: {
      series_leaderboards: View<SeriesLeaderboardRow>;
      all_time_best_performances: View<AllTimeBestPerformanceRow>;
      all_time_best_performers: View<AllTimeBestPerformerRow>;
    };
    Functions: {
      create_team_invite_link: {
        Args: { p_team_id: string };
        Returns: string;
      };
      redeem_team_invite_token: {
        Args: { p_token: string };
        Returns: string | null;
      };
      preview_team_invite_token: {
        Args: { p_token: string };
        Returns: string | null;
      };
      get_skins_qualifiers: {
        Args: { event_id_param: string };
        Returns: SkinsQualifierRpcRow[];
      };
      sync_skins_invitations: {
        Args: { event_id_param: string };
        Returns: number;
      };
      claim_pending_parent_links: {
        Args: Record<string, never>;
        Returns: number;
      };
      // Team/join-request domain guards (supabase/schema.sql section 4).
      meet_in_progress: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      can_captain_team: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      // NOTE: event_results and performance_highlights are VIEWS, exposed
      // read-only through Tables below.
      accept_safety_acknowledgement: {
        Args: { p_athlete_id: string };
        Returns: undefined;
      };
      my_pending_safety_acceptances: {
        Args: Record<string, never>;
        Returns: { athlete_id: string; full_name: string; age_group: AgeGroup }[];
      };
      visible_contacts: {
        Args: { p_user_ids: string[] };
        Returns: { user_id: string; email: string | null; phone: string | null }[];
      };
      materialise_skins_heat: {
        Args: {
          p_skins_event_id: string;
          p_category: AgeGroup;
          p_gender: Gender;
          p_athlete_ids: string[];
          /** Positional with p_athlete_ids: index i is that swimmer's lane. */
          p_lane_numbers: number[];
          p_round: number;
          p_swim_off: boolean;
        };
        Returns: {
          athlete_id: string;
          entry_id: string;
          heat_lane_id: string;
          lane_number: number;
        }[];
      };
      best_previous_official_time: {
        Args: { p_athlete_id: string; p_event_id: string };
        Returns: number | null;
      };
      athlete_best_wa_points: {
        Args: { p_athlete_id: string };
        Returns: number | null;
      };
      world_aquatics_points: {
        Args: {
          p_stroke: string;
          p_distance_m: number;
          p_gender: Gender;
          p_time_ms: number;
        };
        Returns: number | null;
      };
      active_pricing_tier: {
        Args: { p_meet_volume_id: string };
        Returns: PricingTierValue;
      };
      quote_athlete_entries: {
        Args: {
          p_athlete_id: string;
          p_meet_volume_id: string;
          p_include_statuses?: string[];
        };
        Returns: {
          kind: "package" | "additional_race" | "surcharge" | "relay";
          label: string;
          entry_id: string | null;
          amount_egp: number;
          tier: PricingTierValue;
        }[];
      };
      event_capacity: {
        Args: { p_event_id: string };
        Returns: {
          capacity_cap: number;
          paid_count: number;
          held_count: number;
          free_count: number;
          availability: EventAvailabilityValue;
        }[];
      };
      events_capacity_bulk: {
        Args: { p_event_ids: string[] };
        Returns: {
          event_id: string;
          capacity_cap: number;
          paid_count: number;
          held_count: number;
          free_count: number;
          availability: EventAvailabilityValue;
        }[];
      };
      waitlist_position: {
        Args: { p_event_id: string; p_athlete_id: string };
        Returns: number | null;
      };
      reclaim_entry_slot: {
        Args: { p_entry_id: string };
        Returns: boolean;
      };
      claim_waitlist_offer: {
        Args: { p_waitlist_id: string };
        Returns: boolean;
      };
      sweep_expired_holds: {
        Args: Record<string, never>;
        Returns: {
          holds_expired: number;
          offers_made: number;
          offers_lapsed: number;
          relay_holds_expired: number;
        }[];
      };
      relay_event_capacity: {
        Args: { p_event_id: string };
        Returns: {
          capacity_cap: number;
          paid_count: number;
          held_count: number;
          free_count: number;
          availability: EventAvailabilityValue;
        }[];
      };
      quote_relay_squad_egp: {
        Args: { p_squad_id: string };
        Returns: { legs_filled: number; amount_egp: number; payable: boolean }[];
      };
      confirm_relay_squad_payment: {
        Args: { p_squad_id: string; p_note?: string };
        Returns: string;
      };
      reclaim_relay_squad_hold: {
        Args: { p_squad_id: string };
        Returns: boolean;
      };
      offer_waitlist_slots: {
        Args: { p_event_id: string };
        Returns: number;
      };
      pending_cash_total: {
        Args: { p_meet_volume_id: string };
        Returns: { athlete_count: number; total_egp: number }[];
      };
    };
    Enums: {
      user_role: UserRole;
      public_signup_role: PublicSignupRole;
      age_group: AgeGroup;
      publish_status: PublishStatus;
      membership_status: MembershipStatus;
      heat_group: HeatGroup;
      dq_reason: DqReason;
      result_outcome: ResultOutcome;
      skins_response: SkinsResponse;
      gender: Gender;
      volume_status: VolumeStatus;
      award_type: AwardType;
      parent_link_status: ParentLinkStatus;
      entry_status: EntryStatus;
    };
  };
};
