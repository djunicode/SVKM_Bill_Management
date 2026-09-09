/**
 * Which bills appear on which tab, for which team.
 *
 * Transcribed from the "Sorting & Home & Forwarded Tab" sheet (rule 4) of the
 * observations workbook, which supersedes the Logic sheet's earlier version.
 * Column numbers refer to the Field entry register.
 *
 *                 HOME                              FORWARDED
 *   Site          at site, not yet dispatched       62 filled, or manually
 *                                                   Proforma/Reject
 *   PIMO Mumbai   62 filled (a bill created at      82 filled
 *                 PIMO is stamped at creation)
 *   Accounts      82 filled                         89 filled
 *   Trustee       Hold/Accept AND Unpaid            Hold/Accept AND Paid
 *   QS            35 or 40 or 64 filled,            66 filled
 *                 AND 66 blank
 *
 *                 INCOMING (dispatched to them, not yet acknowledged)
 *   PIMO Mumbai   61 filled AND 62 blank
 *   Accounts      80 filled AND 82 blank
 *
 * Previously each of these was written inline, twice, and PIMO and Accounts
 * keyed their HOME tab off the SENDING date (61 and 80) rather than the
 * RECEIVED date (62 and 82). That put a bill on the home tab the moment it was
 * dispatched, so the Incoming tab and its "Mark as received" step were bypassed
 * and the received-date columns never meant anything.
 */

const FILLED = { $ne: null };
const BLANK = null;

export const TABS = ["home", "incoming", "forwarded"];

/** Roles that have an Incoming tab at all. */
export const ROLES_WITH_INCOMING = ["site_pimo", "pimo_mumbai", "accounts"];

/** Treat the two PIMO role names as one team, and trustee/director as one. */
const canon = (role) =>
  ({ pimo_mumbai: "site_pimo", trustees: "director" }[role] || role);

const HOME = {
  // Bills sitting at site: received there, not yet dispatched to PIMO.
  site_officer: {
    "pimoMumbai.dateGiven": BLANK,
    siteStatus: "hold",
    currentCount: 1,
  },

  // col 62 - received at PIMO. A bill raised at PIMO is stamped at creation.
  site_pimo: {
    "pimoMumbai.dateReceived": FILLED,
    "accountsDept.dateReceived": BLANK,
  },

  // col 82 - received in Accounts, not yet paid.
  accounts: {
    "accountsDept.dateReceived": FILLED,
    "accountsDept.paymentDate": BLANK,
  },

  // Hold or Accept, and unpaid.
  director: {
    siteStatus: { $in: ["hold", "accept"] },
    "accountsDept.paymentDate": BLANK,
  },

  // Given to QS (measure, prov COP, or QS Mumbai) and not yet returned.
  qs_site: {
    $and: [
      { "pimoMumbai.dateReturnedFromQs": BLANK },
      {
        $or: [
          { "qsInspection.dateGiven": FILLED },
          { "qsCOP.dateGiven": FILLED },
          { "qsMumbai.dateGiven": FILLED },
        ],
      },
    ],
  },
};

const INCOMING = {
  // col 61 filled, col 62 blank - dispatched from site, awaiting receipt.
  site_pimo: {
    "pimoMumbai.dateGiven": FILLED,
    "pimoMumbai.dateReceived": BLANK,
  },
  // col 80 filled, col 82 blank - given to Accounts, awaiting receipt.
  accounts: {
    "accountsDept.dateGiven": FILLED,
    "accountsDept.dateReceived": BLANK,
  },
};

const FORWARDED = {
  // col 62 filled, or the bill was manually marked Proforma / Reject Invoice,
  // which the spec says also stamps 62 and 89 and moves it here.
  site_officer: {
    $or: [
      { "pimoMumbai.dateReceived": FILLED },
      { siteStatus: { $in: ["proforma", "reject"] } },
    ],
  },
  site_pimo: { "accountsDept.dateReceived": FILLED },
  accounts: { "accountsDept.paymentDate": FILLED },
  director: {
    siteStatus: { $in: ["hold", "accept"] },
    "accountsDept.paymentDate": FILLED,
  },
  qs_site: { "pimoMumbai.dateReturnedFromQs": FILLED },
};

const BY_TAB = { home: HOME, incoming: INCOMING, forwarded: FORWARDED };

/**
 * The mongo filter for one team's tab.
 * @returns {object|null} null when that team has no such tab
 */
export const tabFilter = (role, tab) => {
  const table = BY_TAB[tab];
  if (!table) return null;
  const filter = table[canon(role)];
  return filter ? structuredClone(filter) : null;
};

/**
 * Home plus Incoming for a team, as one query.
 *
 * The dashboard fetches once and splits the two client-side, so the default
 * response has to carry both. Passing an explicit tab returns just that tab.
 */
export const homeAndIncomingFilter = (role) => {
  const home = tabFilter(role, "home");
  const incoming = tabFilter(role, "incoming");
  if (!home) return {};
  if (!incoming) return home;
  return { $or: [home, incoming] };
};

/** The column each tab sorts on, latest first, with Sr no as tiebreaker. */
export const SORT_FIELD = {
  home: {
    site_officer: "taxInvRecdAtSite", // col 24
    site_pimo: "pimoMumbai.dateReceived", // col 62
    accounts: "accountsDept.dateReceived", // col 82
    director: "taxInvRecdAtSite", // col 24
    qs_site: ["qsInspection.dateGiven", "qsCOP.dateGiven", "qsMumbai.dateGiven"], // 35 -> 40 -> 64
  },
  incoming: {
    site_pimo: "pimoMumbai.dateGiven", // col 61
    accounts: "accountsDept.dateGiven", // col 80
  },
  forwarded: {
    site_officer: "pimoMumbai.dateGiven", // col 61
    site_pimo: "accountsDept.dateGiven", // col 80
    accounts: "accountsDept.paymentDate", // col 89
    director: "accountsDept.paymentDate", // col 89
    qs_site: "pimoMumbai.dateReturnedFromQs", // col 66
  },
};

/**
 * Value to sort a bill by. QS falls back 35 -> 40 -> 64, per the spec, so a
 * bill sent straight for Prov COP is not left without a sort date.
 */
export const sortValueFor = (bill, role, tab) => {
  const field = SORT_FIELD[tab]?.[canon(role)];
  if (!field) return bill?.billDate ?? null;

  const read = (path) =>
    path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), bill);

  if (Array.isArray(field)) {
    for (const f of field) {
      const v = read(f);
      if (v) return v;
    }
    return null;
  }
  return read(field) ?? null;
};

export { canon as canonicalRole };
