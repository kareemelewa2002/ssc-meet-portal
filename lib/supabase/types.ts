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
// call-room attendance and time entry); 'team_captain' folded into 'coach'
// (teams.captain_id already tracks "who manages this team" independently
// of the role column — a coach can be a team's captain without a distinct
// role value for it).
export type UserRole = "admin" | "referee" | "coach" | "athlete" | "parent";

export type PublicSignupRole = "athlete" | "parent" | "coach" | "referee";

export type AgeGroup = "U14" | "U17" | "Open";

export type PublishStatus = "draft" | "published";

export type MembershipStatus = "pending" | "accepted";

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

export type AttendanceStatus = "pending" | "present" | "absent";

export type AwardType = "best_swimmer" | "most_improved";

export type ParentLinkStatus = "none" | "pending" | "verified";

export type EntryStatus = "pending_payment" | "confirmed";

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

export type TeamMembershipRow = {
  id: string;
  team_id: string;
  user_id: string;
  status: MembershipStatus;
  requested_at: string;
  responded_at: string | null;
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
  created_at: string;
  updated_at: string;
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
  created_at: string;
};

export type HeatRow = {
  id: string;
  event_id: string;
  heat_group: HeatGroup;
  heat_number: number;
  heat_order: number;
  status: PublishStatus;
  created_at: string;
  updated_at: string;
};

export type HeatLaneRow = {
  id: string;
  heat_id: string;
  lane_number: number;
  entry_id: string | null;
  attendance_status: AttendanceStatus;
  attendance_marked_at: string | null;
  attendance_marked_by: string | null;
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
      athletes: Table<AthleteRow>;
      volume_team_affiliations: Table<VolumeTeamAffiliationRow>;
      meet_volumes: Table<MeetVolumeRow>;
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
      attendance_status: AttendanceStatus;
      award_type: AwardType;
      parent_link_status: ParentLinkStatus;
      entry_status: EntryStatus;
    };
  };
};
