import { describe, expect, it } from "vitest";
import { assignCompetitionRanks, resolveCutoff, withCompetitionRanks } from "@/lib/ranking";
import { rankBestPerformances, rankBestPerformers, type RacePerformance } from "@/lib/all-time-rankings";

const ranksOf = (times: number[]) =>
  assignCompetitionRanks(times.map((t) => ({ t })), (r) => r.t).map((r) => r.rank);

describe("assignCompetitionRanks — standard competition ranking", () => {
  it("the stated rule: two tied for first, the next swimmer is third", () => {
    expect(ranksOf([2500, 2500, 2600])).toEqual([1, 1, 3]);
  });

  it("skips exactly as many places as there were tied swimmers", () => {
    expect(ranksOf([2500, 2500, 2500, 2600])).toEqual([1, 1, 1, 4]);
    expect(ranksOf([2400, 2500, 2500, 2500, 2500, 2600])).toEqual([1, 2, 2, 2, 2, 6]);
  });

  it("is not dense ranking (which would say 2) and not a row number (which would split the tie)", () => {
    const ranks = ranksOf([2500, 2500, 2600]);
    expect(ranks).not.toEqual([1, 2, 3]); // row_number
    expect(ranks).not.toEqual([1, 1, 2]); // dense_rank
  });

  it("handles ties in the middle and at the end", () => {
    expect(ranksOf([2400, 2500, 2500, 2700])).toEqual([1, 2, 2, 4]);
    expect(ranksOf([2400, 2500, 2500])).toEqual([1, 2, 2]);
  });

  it("no ties behaves exactly like a row number", () => {
    expect(ranksOf([2400, 2500, 2600, 2700])).toEqual([1, 2, 3, 4]);
  });

  it("handles empty and single-element input", () => {
    expect(ranksOf([])).toEqual([]);
    expect(ranksOf([2500])).toEqual([1]);
  });

  it("ties on exact hundredths — times are whole centiseconds, so 10ms apart is NOT a tie", () => {
    // 25.00 vs 25.01: adjacent hundredths, genuinely different times.
    expect(ranksOf([25000, 25010])).toEqual([1, 2]);
    expect(ranksOf([25000, 25000])).toEqual([1, 1]);
  });

  it("only keyOf decides a tie — a display tiebreaker must not split it", () => {
    const rows = [
      { time: 2500, swamAt: "2026-10-02T09:00:00Z" },
      { time: 2500, swamAt: "2026-10-02T10:00:00Z" },
      { time: 2600, swamAt: "2026-10-02T09:30:00Z" },
    ];
    expect(withCompetitionRanks(rows, (r) => r.time).map((r) => r.rank)).toEqual([1, 1, 3]);
  });
});

describe("all-time rankings apply the tie rule", () => {
  const race = (id: string, athleteId: string, name: string, ms: number): RacePerformance => ({
    resultId: id,
    athleteId,
    athleteName: name,
    teamName: null,
    stroke: "Freestyle",
    distanceM: 50,
    ageGroup: "Open",
    gender: "male",
    officialTimeMs: ms,
    ageAtSwim: 20,
    volumeName: "SSC Vol. 1",
    swamAt: "2026-10-02T09:00:00Z",
  });

  it("Best Performances ties two identical times and skips to third", () => {
    const ranked = rankBestPerformances([
      race("r1", "a1", "Tied One", 25000),
      race("r2", "a2", "Tied Two", 25000),
      race("r3", "a3", "Third", 25500),
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 1, 3]);
  });

  it("Best Performers ties two athletes' identical bests and skips to third", () => {
    const ranked = rankBestPerformers([
      race("r1", "a1", "Tied One", 25000),
      race("r2", "a2", "Tied Two", 25000),
      race("r3", "a3", "Third", 25500),
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 1, 3]);
  });

  it("a tie straddling the cutoff keeps every tied swimmer rather than cutting one arbitrarily", () => {
    // Three-way tie for 2nd with limit 3: all three hold 2nd, so all three
    // are returned — dropping one on array position would be arbitrary.
    const ranked = rankBestPerformances(
      [
        race("r1", "a1", "First", 24000),
        race("r2", "a2", "Tie A", 25000),
        race("r3", "a3", "Tie B", 25000),
        race("r4", "a4", "Tie C", 25000),
        race("r5", "a5", "Fifth", 26000),
      ],
      {},
      3,
    );
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 2, 2]);
    expect(ranked.some((r) => r.athleteName === "Fifth")).toBe(false);
  });
});

describe("resolveCutoff — a tie on the cutoff is never split by sort order", () => {
  const field = (times: number[]) => times.map((t, i) => ({ id: `s${i}`, t }));
  const run = (times: number[], cutoff: number) => resolveCutoff(field(times), cutoff, (x) => x.t);

  it("holds two swimmers tied for the last advancing place", () => {
    const r = run([100, 200, 300, 300], 3);
    expect(r.advancing.map((a) => a.t)).toEqual([100, 200]);
    expect(r.swimOff.map((a) => a.t)).toEqual([300, 300]);
    expect(r.slotsRemaining).toBe(1);
  });

  it("a tie wholly inside the cutoff advances untouched", () => {
    const r = run([100, 100, 300, 400], 3);
    expect(r.advancing).toHaveLength(3);
    expect(r.swimOff).toHaveLength(0);
  });

  it("a tie wholly outside the cutoff is irrelevant", () => {
    const r = run([100, 200, 300, 400, 400], 3);
    expect(r.advancing.map((a) => a.t)).toEqual([100, 200, 300]);
    expect(r.swimOff).toHaveLength(0);
  });

  it("three level for two remaining places contest both", () => {
    const r = run([100, 200, 200, 200], 3);
    expect(r.advancing.map((a) => a.t)).toEqual([100]);
    expect(r.swimOff).toHaveLength(3);
    expect(r.slotsRemaining).toBe(2);
  });

  it("a field no larger than the cutoff never needs a swim-off", () => {
    const r = run([100, 100], 4);
    expect(r.advancing).toHaveLength(2);
    expect(r.swimOff).toHaveLength(0);
  });

  it("every swimmer level at the very top still contests the cutoff", () => {
    const r = run([100, 100, 100, 100], 2);
    expect(r.advancing).toHaveLength(0);
    expect(r.swimOff).toHaveLength(4);
    expect(r.slotsRemaining).toBe(2);
  });

  it("a clean cutoff advances exactly the cutoff count", () => {
    const r = run([100, 200, 300, 400, 500], 3);
    expect(r.advancing).toHaveLength(3);
    expect(r.swimOff).toHaveLength(0);
    expect(r.slotsRemaining).toBe(0);
  });
});
