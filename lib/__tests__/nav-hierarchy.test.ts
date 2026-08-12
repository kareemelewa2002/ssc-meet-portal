import { describe, expect, it } from "vitest";
import { parentLabelFor, parentPathFor } from "@/lib/nav-hierarchy";

describe("parentPathFor", () => {
  it("has no parent for the home page", () => {
    // Null is what tells AppHeader to hide the control entirely, rather than
    // render a back button on the page there is nothing behind.
    expect(parentPathFor("/")).toBeNull();
    expect(parentPathFor("")).toBeNull();
    expect(parentPathFor(null)).toBeNull();
    expect(parentPathFor(undefined)).toBeNull();
  });

  it("sends every top-level page home", () => {
    expect(parentPathFor("/dashboard")).toBe("/");
    expect(parentPathFor("/captain")).toBe("/");
    expect(parentPathFor("/parent")).toBe("/");
    expect(parentPathFor("/admin")).toBe("/");
    expect(parentPathFor("/referee")).toBe("/");
    expect(parentPathFor("/meets")).toBe("/");
    expect(parentPathFor("/teams")).toBe("/");
    expect(parentPathFor("/leaderboards")).toBe("/");
    expect(parentPathFor("/athletes")).toBe("/");
    expect(parentPathFor("/profile")).toBe("/");
    expect(parentPathFor("/settings")).toBe("/");
  });

  it("drops the last segment for a nested page", () => {
    expect(parentPathFor("/captain/roster")).toBe("/captain");
    expect(parentPathFor("/captain/invitations")).toBe("/captain");
    expect(parentPathFor("/dashboard/teams")).toBe("/dashboard");
    expect(parentPathFor("/dashboard/team")).toBe("/dashboard");
    expect(parentPathFor("/admin/audit-logs")).toBe("/admin");
    expect(parentPathFor("/admin/control-unit")).toBe("/admin");
    expect(parentPathFor("/admin/seeding")).toBe("/admin");
    expect(parentPathFor("/leaderboards/all-time")).toBe("/leaderboards");
    expect(parentPathFor("/settings/notifications")).toBe("/settings");
  });

  it("sends a dynamic child to its collection", () => {
    expect(parentPathFor("/athletes/abc-123")).toBe("/athletes");
  });

  it("sends every event tab to /meets, not to a volume page that does not exist", () => {
    // Dropping a segment here would produce /events/1, which is not a route —
    // there is no volume landing page, only its tabs.
    for (const tab of ["heats", "results", "schedule", "leaderboard", "live", "register", "telemetry"]) {
      expect(parentPathFor(`/events/1/${tab}`)).toBe("/meets");
    }
    // Volume ids may be slugs as well as numbers.
    expect(parentPathFor("/events/ssc-vol-1/results")).toBe("/meets");
    expect(parentPathFor("/events/1")).toBe("/meets");
  });

  it("tolerates a trailing slash, a query string and a hash", () => {
    expect(parentPathFor("/captain/roster/")).toBe("/captain");
    expect(parentPathFor("/captain/roster?tab=all")).toBe("/captain");
    expect(parentPathFor("/captain/roster#top")).toBe("/captain");
    expect(parentPathFor("/dashboard/")).toBe("/");
  });
});

describe("parentLabelFor", () => {
  it("names the destination so the control announces where it goes", () => {
    expect(parentLabelFor("/")).toBe("Home");
    expect(parentLabelFor("/captain")).toBe("Captain Dashboard");
    expect(parentLabelFor("/meets")).toBe("Meets");
  });

  it("falls back to a generic label for an unnamed destination", () => {
    expect(parentLabelFor("/something/new")).toBe("Back");
  });

  it("has no label when there is no parent", () => {
    expect(parentLabelFor(null)).toBeNull();
  });
});
