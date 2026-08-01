import { describe, expect, it } from "vitest";
import { buildTeamCreateInsert, didTransferTeams, summarizeTeamHistory } from "@/lib/teams";

describe("buildTeamCreateInsert", () => {
  it("always starts a new team pending admin approval", () => {
    const payload = buildTeamCreateInsert({
      name: "  Blue Marlins  ",
      abbreviation: " BLM ",
      clubLogoUrl: null,
      captainId: "coach-1",
    });
    expect(payload.name).toBe("Blue Marlins");
    expect(payload.abbreviation).toBe("BLM");
    expect(payload.approved_by_admin).toBe(false);
    expect(payload.captain_id).toBe("coach-1");
  });
});

describe("volume-by-volume team transfer", () => {
  it("preserves each volume's historical team distinctly after a transfer", () => {
    const history = [
      { volumeNumber: 1, volumeName: "SSC Vol. 1", teamId: "team-blue", teamName: "Blue Marlins" },
      { volumeNumber: 2, volumeName: "SSC Vol. 2", teamId: "team-rip", teamName: "Riptide" },
    ];

    expect(didTransferTeams(history)).toBe(true);
    expect(summarizeTeamHistory(history)).toBe(
      "Blue Marlins (Vol. 1) → Riptide (Vol. 2)",
    );
  });

  it("does not report a transfer when the same team is kept across volumes", () => {
    const history = [
      { volumeNumber: 1, volumeName: "SSC Vol. 1", teamId: "team-blue", teamName: "Blue Marlins" },
      { volumeNumber: 2, volumeName: "SSC Vol. 2", teamId: "team-blue", teamName: "Blue Marlins" },
    ];

    expect(didTransferTeams(history)).toBe(false);
    expect(summarizeTeamHistory(history)).toBe(
      "Blue Marlins (Vol. 1) → Blue Marlins (Vol. 2)",
    );
  });

  it("treats swimming unattached as a distinct 'team' for transfer purposes", () => {
    const history = [
      { volumeNumber: 1, volumeName: "SSC Vol. 1", teamId: null, teamName: null },
      { volumeNumber: 2, volumeName: "SSC Vol. 2", teamId: "team-blue", teamName: "Blue Marlins" },
    ];

    expect(didTransferTeams(history)).toBe(true);
    expect(summarizeTeamHistory(history)).toBe(
      "Unattached (Vol. 1) → Blue Marlins (Vol. 2)",
    );
  });

  it("orders history oldest-volume-first regardless of input order", () => {
    const history = [
      { volumeNumber: 2, volumeName: "SSC Vol. 2", teamId: "team-rip", teamName: "Riptide" },
      { volumeNumber: 1, volumeName: "SSC Vol. 1", teamId: "team-blue", teamName: "Blue Marlins" },
    ];

    expect(summarizeTeamHistory(history)).toBe(
      "Blue Marlins (Vol. 1) → Riptide (Vol. 2)",
    );
  });
});
