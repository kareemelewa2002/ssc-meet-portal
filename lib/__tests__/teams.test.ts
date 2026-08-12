import { describe, expect, it } from "vitest";
import {
  buildTeamCreateInsert,
  didTransferTeams,
  summarizeTeamHistory,
  validateTeamBranding,
} from "@/lib/teams";

describe("buildTeamCreateInsert", () => {
  it("always starts a new team pending admin approval", () => {
    const payload = buildTeamCreateInsert({
      name: "  Blue Marlins  ",
      abbreviation: " BLM ",
      teamLogoUrl: null,
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

describe("validateTeamBranding", () => {
  const base = { name: "Riptide Swim Club", abbreviation: "RIP", logoUrl: "" };

  it("accepts a plain valid edit", () => {
    const res = validateTeamBranding(base);
    expect(res.ok).toBe(true);
    expect(res.values.name).toBe("Riptide Swim Club");
    expect(res.values.abbreviation).toBe("RIP");
  });

  it("uppercases the abbreviation rather than rejecting lowercase", () => {
    // The requirement is that stored abbreviations are uppercase. Correcting
    // "rip" exactly is friendlier than erroring on something unambiguous.
    const res = validateTeamBranding({ ...base, abbreviation: "rip" });
    expect(res.ok).toBe(true);
    expect(res.values.abbreviation).toBe("RIP");
  });

  it("trims, and stores an empty abbreviation or logo as null", () => {
    // The columns are nullable; an empty string would render as a blank badge
    // and as a broken image rather than as "not set".
    const res = validateTeamBranding({ name: "  Tidalwave  ", abbreviation: "  ", logoUrl: "  " });
    expect(res.values.name).toBe("Tidalwave");
    expect(res.values.abbreviation).toBeNull();
    expect(res.values.teamLogoUrl).toBeNull();
  });

  it("rejects an empty name", () => {
    const res = validateTeamBranding({ ...base, name: "   " });
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/needs a name/);
  });

  it("enforces the abbreviation length limits", () => {
    expect(validateTeamBranding({ ...base, abbreviation: "A" }).ok).toBe(false);
    expect(validateTeamBranding({ ...base, abbreviation: "TOOLONG" }).ok).toBe(false);
    expect(validateTeamBranding({ ...base, abbreviation: "AB" }).ok).toBe(true);
    expect(validateTeamBranding({ ...base, abbreviation: "ABCDEF" }).ok).toBe(true);
  });

  it("rejects punctuation in an abbreviation", () => {
    const res = validateTeamBranding({ ...base, abbreviation: "R-P" });
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/letters and numbers/);
  });

  it("requires https for a logo, since http is blocked as mixed content", () => {
    // An http image on an https page is silently blocked by the browser — the
    // logo would simply never appear, with nothing to explain why.
    expect(validateTeamBranding({ ...base, logoUrl: "http://x.test/a.png" }).ok).toBe(false);
    expect(validateTeamBranding({ ...base, logoUrl: "x.test/a.png" }).ok).toBe(false);
    expect(validateTeamBranding({ ...base, logoUrl: "https://x.test/a.png" }).ok).toBe(true);
  });
});
