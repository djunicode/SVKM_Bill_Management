/**
 * Role helpers.
 *
 * user-model.js declares `role: [String]` and getSignedToken() signs that array
 * straight into the JWT, so `req.user.role` is ALWAYS an array — ["accounts"],
 * ["admin"], or several at once for a user who wears more than one hat.
 *
 * Parts of the codebase were written against a scalar, e.g.
 *
 *     if (!roles.includes(req.user.role) && req.user.role !== 'admin')
 *
 * which is false on both halves for an array, so it refused every user on every
 * route it guarded — all fifteen reports among them. These helpers normalise
 * once so the comparison is done the same way everywhere.
 *
 * Tolerates a scalar too, because middleware's development bypass still sets
 * `role: 'admin'` as a string.
 */

/** Always an array of role strings. */
export const asRoles = (role) => {
  if (Array.isArray(role)) return role.filter(Boolean);
  if (typeof role === "string" && role) return [role];
  return [];
};

/** True when the user holds any of `allowed`. */
export const hasAnyRole = (userRole, allowed) => {
  const held = asRoles(userRole);
  const want = asRoles(allowed);
  return held.some((r) => want.includes(r));
};

/** True when the user is an admin. */
export const isAdminRole = (userRole) => asRoles(userRole).includes("admin");

/**
 * The single role to act as, for the many places that still need one — the
 * team lookups in excel-controller, the workflow step map, and so on.
 * Prefers a non-admin role so that a user holding ["accounts","admin"] is
 * treated as Accounts rather than losing their team.
 */
export const primaryRole = (userRole) => {
  const held = asRoles(userRole);
  return held.find((r) => r !== "admin") ?? held[0] ?? null;
};

/** Readable form for error messages: ["a","b"] -> "a, b". */
export const describeRoles = (userRole) => asRoles(userRole).join(", ") || "none";

/**
 * Login role -> the team name the send-to workflow dispatches on.
 *
 * changeBatchWorkflowState() picks its branch from `fromUser.role`, which
 * arrives in the REQUEST BODY, and the dashboard builds that value from a
 * browser cookie using exactly this mapping (SendBoxModal.jsx). Nothing
 * checked that the caller actually held the team they claimed, so any
 * signed-in user could drive any transition on any bill.
 *
 * The names on the right are the ones the controller's branches test for.
 */
const WORKFLOW_TEAM = {
  site_officer: "site_team",
  qs_site: "qs_team",
  site_pimo: "pimo_mumbai",
  pimo_mumbai: "pimo_mumbai",
  director: "trustee",
  accounts: "accounts",
};

/** Every workflow team this user may act as. Admin may act as any. */
export const workflowTeamsFor = (userRole) =>
  asRoles(userRole)
    .map((r) => WORKFLOW_TEAM[r])
    .filter(Boolean);

/**
 * May this user send as `claimedTeam`?
 *
 * An admin may act for anyone. A user with no mapped team - `viewer`, or a
 * role added to the schema without being added above - may not send at all.
 */
export const canActAsWorkflowTeam = (userRole, claimedTeam) => {
  if (isAdminRole(userRole)) return true;
  const mine = workflowTeamsFor(userRole);
  if (mine.length === 0) return false;
  if (!claimedTeam) return true; // no claim: the caller's own team is used
  return asRoles(claimedTeam).some((t) => mine.includes(t));
};

export { WORKFLOW_TEAM };

/**
 * The team name a person reads, as distinct from the role key stored on the
 * user or the workflow team name used for dispatch.
 *
 * "Site Team" was renamed to "IMD Site Team" on the front end (observation
 * N-22); this keeps the printed checklists saying the same thing.
 */
export const TEAM_LABEL = {
  site_officer: "IMD Site Team",
  qs_site: "QS Team",
  site_pimo: "PIMO Mumbai Team",
  pimo_mumbai: "PIMO Mumbai Team",
  accounts: "Accounts Team",
  director: "Trustee, Advisor & Director",
  admin: "Admin",
};

/** The label for whichever team this user acts as. */
export const teamLabelFor = (userRole) => TEAM_LABEL[primaryRole(userRole)] || "";
