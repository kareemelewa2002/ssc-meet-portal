/**
 * Where "back" goes, for every page in the app.
 *
 * WHY NOT router.back()
 * ---------------------
 * The header used to call router.back(), which walks BROWSER HISTORY — "the
 * page you were on", not "the page above this one". Those differ constantly
 * in this app: a parent who opens a child's athlete profile from a push
 * notification, an admin who lands on /admin/seeding from a bookmark, anyone
 * who followed a shared heat-sheet link. History-back sent them somewhere
 * unrelated, or nowhere at all when there was no history to pop, leaving a
 * back button that visibly did nothing.
 *
 * Hierarchy is a property of the route, so it is defined here rather than
 * discovered at runtime, and it is the same for every visitor regardless of
 * how they arrived.
 *
 * THE DEFAULT RULE
 * ----------------
 * Drop the last path segment: /captain/roster -> /captain, /settings/
 * notifications -> /settings, /athletes/<id> -> /athletes. Most of the app
 * nests exactly this way, so new routes get correct behaviour with no edit
 * here. Only routes whose parent is NOT their URL prefix need an entry in
 * PARENT_OVERRIDES below.
 */

/**
 * Routes whose logical parent differs from their URL prefix.
 *
 * /events/<volume>/... is the whole reason this table exists: dropping a
 * segment yields /events/<volume>, which is not a page — there is no volume
 * landing route, only its heats/results/schedule/leaderboard tabs. The list
 * of volumes lives at /meets, so that is the parent of every one of them.
 */
const EVENT_TAB_PATTERN = /^\/events\/[^/]+(\/.*)?$/;

/** Pages that sit directly under the home page, with nothing above them. */
const TOP_LEVEL = "/";

/**
 * The page one level above `pathname`, or null when there is none (the home
 * page itself, and any path that is not a real route).
 *
 * Returning null is meaningful: the caller HIDES the back control rather than
 * rendering one that goes nowhere. A dead back button is worse than no back
 * button — it invites a tap that does nothing and reads as a broken page.
 */
export function parentPathFor(pathname: string | null | undefined): string | null {
  if (!pathname) return null;

  // Tolerate a trailing slash and any accidental query/hash so a caller can
  // hand us window.location.pathname without sanitising it first.
  const clean = pathname.split("?")[0].split("#")[0].replace(/\/+$/, "");

  // "" is what "/" becomes after the trailing-slash strip.
  if (clean === "" || clean === TOP_LEVEL) return null;

  // Every /events/<volume>/<tab> page belongs to the meet list, not to a
  // volume landing page — there isn't one.
  if (EVENT_TAB_PATTERN.test(clean)) return "/meets";

  const segments = clean.split("/").filter(Boolean);
  if (segments.length <= 1) return TOP_LEVEL;

  return `/${segments.slice(0, -1).join("/")}`;
}

/**
 * Human label for the back destination, used as the control's accessible
 * name so a screen reader announces where it goes rather than just "Back".
 */
const PARENT_LABELS: Record<string, string> = {
  "/": "Home",
  "/admin": "Command Center",
  "/athletes": "Teams & Athletes",
  "/captain": "Captain Dashboard",
  "/dashboard": "Athlete Dashboard",
  "/leaderboards": "Leaderboards",
  "/meets": "Meets",
  "/parent": "Parent Portal",
  "/referee": "Referee Deck",
  "/settings": "Settings",
  "/teams": "Teams",
};

export function parentLabelFor(parentPath: string | null): string | null {
  if (!parentPath) return null;
  return PARENT_LABELS[parentPath] ?? "Back";
}
