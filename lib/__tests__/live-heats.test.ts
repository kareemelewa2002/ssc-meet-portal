import { describe, expect, it } from "vitest";
import { firstOf, transformLiveEvents, type RawEvent } from "@/lib/live-heats";

describe("firstOf", () => {
  it("returns the value itself when given a single object", () => {
    expect(firstOf({ a: 1 })).toEqual({ a: 1 });
  });

  it("returns the first element when given an array", () => {
    expect(firstOf([{ a: 1 }, { a: 2 }])).toEqual({ a: 1 });
  });

  it("returns null for null, undefined, or an empty array", () => {
    expect(firstOf(null)).toBeNull();
    expect(firstOf(undefined)).toBeNull();
    expect(firstOf([])).toBeNull();
  });
});

describe("transformLiveEvents", () => {
  it("sorts heats by heat_number and lanes by lane_number", () => {
    const raw: RawEvent[] = [
      {
        id: "ev1",
        name: "50 Free",
        stroke: "Freestyle",
        distance_m: 50,
        is_skins: false,
        heats: [
          {
            id: "heat2",
            heat_number: 2,
            heat_group: "U17_OPEN",
      gender: "male",
            status: "published",
            heat_lanes: [
              {
                lane_number: 4,
                entries: {
                  id: "e1",
                  seed_time_ms: 30000,
                  is_nt: false,
                  athletes: {
                    id: "a1",
                    gender: "male",
                    age_group: "Open",
                    users: { full_name: "Fast Guy" },
                    teams: { name: "Sharks" },
                  },
                },
                results: null,
              },
            ],
          },
          {
            id: "heat1",
            heat_number: 1,
            heat_group: "U17_OPEN",
      gender: "male",
            status: "draft",
            heat_lanes: [
              {
                lane_number: 3,
                entries: {
                  id: "e2",
                  seed_time_ms: null,
                  is_nt: true,
                  athletes: {
                    id: "a2",
                    gender: "female",
                    age_group: "U17",
                    users: [{ full_name: "NT Swimmer" }],
                    teams: [{ name: "Riptide" }],
                  },
                },
                results: null,
              },
              {
                lane_number: 1,
                entries: {
                  id: "e3",
                  seed_time_ms: 32000,
                  is_nt: false,
                  athletes: {
                    id: "a3",
                    gender: "male",
                    age_group: "U14",
                    users: { full_name: "Younger Swimmer" },
                    teams: null,
                  },
                },
                results: null,
              },
            ],
          },
        ],
      },
    ];

    const result = transformLiveEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0].heats.map((h) => h.heatNumber)).toEqual([1, 2]);
    expect(result[0].heats[0].lanes.map((l) => l.laneNumber)).toEqual([1, 3]);
  });

  it("normalizes array-shaped nested embeds the same as object-shaped ones", () => {
    const raw: RawEvent[] = [
      {
        id: "ev1",
        name: "50 Free",
        stroke: "Freestyle",
        distance_m: 50,
        is_skins: false,
        heats: [
          {
            id: "heat1",
            heat_number: 1,
            heat_group: "U17_OPEN",
      gender: "male",
            status: "published",
            heat_lanes: [
              {
                lane_number: 4,
                entries: [
                  {
                    id: "e1",
                    seed_time_ms: 29000,
                    is_nt: false,
                    athletes: [
                      {
                        id: "a1",
                        gender: "female",
                        age_group: "Open",
                        users: [{ full_name: "Array Swimmer" }],
                        teams: [{ name: "Blue Marlins" }],
                      },
                    ],
                  },
                ],
                results: [
                  {
                    result_outcome: "valid",
                    official_time_ms: 28500,
                    finish_place: 1,
                    dq_code: null,
                    status: "published",
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    const [lane] = transformLiveEvents(raw)[0].heats[0].lanes;
    expect(lane.athleteName).toBe("Array Swimmer");
    expect(lane.teamName).toBe("Blue Marlins");
    expect(lane.result?.officialTimeMs).toBe(28500);
    expect(lane.result?.finishPlace).toBe(1);
  });

  it("drops lanes with no entry (empty lanes) from the output", () => {
    const raw: RawEvent[] = [
      {
        id: "ev1",
        name: "50 Free",
        stroke: "Freestyle",
        distance_m: 50,
        is_skins: false,
        heats: [
          {
            id: "heat1",
            heat_number: 1,
            heat_group: "U13_14",
      gender: "male",
            status: "published",
            heat_lanes: [
              { lane_number: 1, entries: null, results: null },
              {
                lane_number: 4,
                entries: {
                  id: "e1",
                  seed_time_ms: 31000,
                  is_nt: false,
                  athletes: {
                    id: "a1",
                    gender: "male",
                    age_group: "U14",
                    users: { full_name: "Only Swimmer" },
                    teams: null,
                  },
                },
                results: null,
              },
            ],
          },
        ],
      },
    ];

    const lanes = transformLiveEvents(raw)[0].heats[0].lanes;
    expect(lanes).toHaveLength(1);
    expect(lanes[0].athleteName).toBe("Only Swimmer");
    expect(lanes[0].teamName).toBeNull();
  });

  it("maps DQ results including the dq_code", () => {
    const raw: RawEvent[] = [
      {
        id: "ev1",
        name: "50 Free",
        stroke: "Freestyle",
        distance_m: 50,
        is_skins: false,
        heats: [
          {
            id: "heat1",
            heat_number: 1,
            heat_group: "U17_OPEN",
      gender: "male",
            status: "published",
            heat_lanes: [
              {
                lane_number: 4,
                entries: {
                  id: "e1",
                  seed_time_ms: 30000,
                  is_nt: false,
                  athletes: {
                    id: "a1",
                    gender: "male",
                    age_group: "Open",
                    users: { full_name: "DQ Swimmer" },
                    teams: null,
                  },
                },
                results: {
                  result_outcome: "dq",
                  official_time_ms: null,
                  finish_place: null,
                  dq_code: "false_start",
                  status: "published",
                },
              },
            ],
          },
        ],
      },
    ];

    const [lane] = transformLiveEvents(raw)[0].heats[0].lanes;
    expect(lane.result?.outcome).toBe("dq");
    expect(lane.result?.dqCode).toBe("false_start");
    expect(lane.result?.officialTimeMs).toBeNull();
  });
});
