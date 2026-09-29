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

/**
 * "Payment Status" as the matrix uses it.
 *
 * Tested as "not Paid" rather than "equals Unpaid" on purpose. Legacy rows
 * carry a blank status - that is observation N-28, fixed separately - and an
 * equality test would drop every one of them off its tab until the backfill
 * had run. This excludes paid bills, which is what was actually reported,
 * without making tab membership depend on the backfill.
 */
const NOT_PAID = { $ne: "Paid" };

export const TABS = ["home", "incoming", "forwarded"];

/** Roles that have an Incoming tab at all. */
export const ROLES_WITH_INCOMING = ["site_pimo", "pimo_mumbai", "accounts"];

/** Treat the two PIMO role names as one team, and trustee/director as one. */
const canon = (role) =>
  ({ pimo_mumbai: "site_pimo", trustees: "director" }[role] || role);

const HOME = {
  // On hold at site, and PIMO has not yet acknowledged it.
  //
  // This used to require column 61 BLANK and currentCount 1, which meant a
  // bill dispatched to PIMO but not yet received there fell off Site Home -
  // and Site Forwarded needs column 62, which it does not have either, so it
  // appeared on no tab at all (observation N-34). Keying on 62 rather than 61
  // keeps it at site until PIMO actually receives it.
  site_officer: {
    "pimoMumbai.dateReceived": BLANK,
    siteStatus: "hold",
    "accountsDept.status": NOT_PAID,
  },

  // col 62 - received at PIMO, accepted at site, not yet paid.
  //
  // Reject and Proforma bills were appearing here, and so were paid ones
  // (observation N-27; she named 2600025, 2600027, 2600028 and 2600029).
  site_pimo: {
    "pimoMumbai.dateReceived": FILLED,
    "accountsDept.dateReceived": BLANK,
    siteStatus: "accept",
    "accountsDept.status": NOT_PAID,
  },

  // col 82 - received in Accounts, not yet paid, and accepted at site.
  //
  // This was deliberately loosened to "not Reject and not Proforma", on the
  // reasoning that nothing guaranteed the status had reached accept by the
  // time a bill got to Accounts. The client has confirmed that it does:
  //
  //   "The bill must be forwarded from Site Team to PIMO Team and then only to
  //    Accounts Team. Once the bill is accepted in PIMO, Status at Site changes
  //    to Accept... Site Team can't send the bill to Accounts Team."
  //
  // So the strict test is safe, and is what the matrix asks for.
  accounts: {
    "accountsDept.dateReceived": FILLED,
    "accountsDept.paymentDate": BLANK,
    siteStatus: "accept",
  },

  // Hold or Accept, and unpaid.
  director: {
    siteStatus: { $in: ["hold", "accept"] },
    "accountsDept.paymentDate": BLANK,
    "accountsDept.status": NOT_PAID,
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
    siteStatus: { $in: ["hold", "accept"] },
    "accountsDept.status": NOT_PAID,
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
  // col 66 filled, OR the bill was forwarded as Proforma / Reject at site.
  // The second clause is new (observation N-17): those bills never come back
  // from QS, so column 66 alone left them on the QS Home tab for ever.
  qs_site: {
    $or: [
      { "pimoMumbai.dateReturnedFromQs": FILLED },
      { siteStatus: { $in: ["proforma", "reject"] } },
    ],
  },
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
    // col 40 first, then 35, then 64. She asked for Prov COP to lead
    // (observation N-35); the fallback chain itself stays.
    qs_site: ["qsCOP.dateGiven", "qsInspection.dateGiven", "qsMumbai.dateGiven"], // 40 -> 35 -> 64
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
