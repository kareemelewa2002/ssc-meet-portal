// Hand-written types mirroring supabase/schema.sql.
// Regenerate with `supabase gen types typescript` once the project is linked,
// and replace this file — keep the shape identical so imports don't break.
//
// NOTE: Row types are declared with `type`, not `interface`. Interfaces don't
// get an implicit index signature in TypeScript, so they fail the
// `Record<string, unknown>` structural check that @supabase/postgrest-js
// uses internally — that mismatch silently collapses every table's inferred
// type to `never`.

export type UserRole =
  | "admin"
  | "referee"
  | "coach"
  | "team_captain"
  | "athlete"
  | "parent";

export type PublicSignupRole = "athlete" | "parent" | "coach" | "referee";

export type AgeGroup = "U13_14" | "U17" | "Open";

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
  role: UserRole;
  created_at: string;
  updated_at: string;
};

export type TeamRow = {
  id: string;
  name: string;
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
  created_at: string;
  updated_at: string;
};

export type SessionRow = {
  id: string;
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
  created_at: string;
};

export type EntryRow = {
  id: string;
  event_id: string;
  athlete_id: string;
  seed_time_ms: number | null;
  is_nt: boolean;
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
  athlete_id: string;
  category: AgeGroup;
  placement_points: number;
  improvement_points: number;
  total_points: number;
  updated_at: string;
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

export type Database = {
  public: {
    Tables: {
      app_settings: Table<AppSettingsRow>;
      users: Table<UserRow>;
      teams: Table<TeamRow>;
      team_memberships: Table<TeamMembershipRow>;
      athletes: Table<AthleteRow>;
      sessions: Table<SessionRow>;
      events: Table<EventRow>;
      entries: Table<EntryRow>;
      heats: Table<HeatRow>;
      heat_lanes: Table<HeatLaneRow>;
      results: Table<ResultRow>;
      leaderboards: Table<LeaderboardRow>;
      skins_qualifications: Table<SkinsQualificationRow>;
    };
    Views: Record<string, never>;
    Functions: {
      get_skins_qualifiers: {
        Args: { event_id_param: string };
        Returns: SkinsQualifierRpcRow[];
      };
      sync_skins_invitations: {
        Args: { event_id_param: string };
        Returns: number;
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
    };
  };
};
