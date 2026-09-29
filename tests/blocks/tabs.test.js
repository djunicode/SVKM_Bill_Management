/**
 * BLOCK: tabs
 *
 * The Home / Incoming / Forwarded matrix from the "Sorting & Home & Forwarded
 * Tab" sheet, rule 4. Twelve team-and-tab combinations: five Home, five
 * Forwarded, two Incoming.
 *
 * The rule these encode, and which the code did not follow, is that PIMO and
 * Accounts take a bill onto their HOME tab when they RECEIVE it (cols 62, 82),
 * not when it is SENT to them (cols 61, 80). Until it is received it belongs on
 * their Incoming tab.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { startDb, stopDb, clearDb } from "../helpers/db.js";

let app, seed, tokenFor, fixtures, Bill;

before(async () => {
  await startDb();
  ({ buildApp: app } = await import("../helpers/app.js"));
  seed = await import("../helpers/seed.js");
  ({ tokenFor } = seed);
  ({ default: Bill } = await import("../../models/bill-model.js"));
  app = app();
});

after(async () => await stopDb());

beforeEach(async () => {
  await clearDb();
  fixtures = await seed.seedAll();
});

const D = (s) => new Date(s);

/** A bill at each point in the journey, keyed by the last thing that happened. */
const STAGE = {
  atSite: {
    siteStatus: "hold",
    currentCount: 1,
  },
  withQs: {
    siteStatus: "hold",
    currentCount: 1,
    "qsInspection.dateGiven": D("2026-07-05"), // col 35
  },
  returnedByQs: {
    siteStatus: "hold",
    currentCount: 1,
    "qsInspection.dateGiven": D("2026-07-05"),
    "pimoMumbai.dateReturnedFromQs": D("2026-07-09"), // col 66
  },
  dispatchedToPimo: {
    siteStatus: "hold",
    currentCount: 3,
    "pimoMumbai.dateGiven": D("2026-07-10"), // col 61
  },
  receivedAtPimo: {
    siteStatus: "accept",
    currentCount: 3,
    "pimoMumbai.dateGiven": D("2026-07-10"),
    "pimoMumbai.dateReceived": D("2026-07-12"), // col 62
  },
  givenToAccounts: {
    siteStatus: "accept",
    currentCount: 5,
    "pimoMumbai.dateGiven": D("2026-07-10"),
    "pimoMumbai.dateReceived": D("2026-07-12"),
    "accountsDept.dateGiven": D("2026-07-20"), // col 80
  },
  receivedInAccounts: {
    siteStatus: "accept",
    currentCount: 5,
    "pimoMumbai.dateGiven": D("2026-07-10"),
    "pimoMumbai.dateReceived": D("2026-07-12"),
    "accountsDept.dateGiven": D("2026-07-20"),
    "accountsDept.dateReceived": D("2026-07-22"), // col 82
  },
  paid: {
    siteStatus: "accept",
    currentCount: 5,
    "pimoMumbai.dateGiven": D("2026-07-10"),
    "pimoMumbai.dateReceived": D("2026-07-12"),
    "accountsDept.dateGiven": D("2026-07-20"),
    "accountsDept.dateReceived": D("2026-07-22"),
    "accountsDept.paymentDate": D("2026-08-01"), // col 89
    "accountsDept.status": "Paid",
  },
};

let n = 0;
const makeBill = async (stage, extra = {}) =>
  Bill.create({
    srNo: "26270" + String(++n).padStart(4, "0"),
    projectDescription: "Mithibai College - Block A",
    vendor: fixtures.vendor._id,
    poCreated: "No",
    taxInvNo: "INV-" + n,
    taxInvDate: D("2026-07-01"),
    taxInvAmt: 100000,
    taxInvRecdAtSite: D("2026-07-03"), // col 24
    billDate: D("2026-07-01"),
    amount: 100000,
    currency: fixtures.currencies[0]._id,
    region: "MUMBAI",
    natureOfWork: fixtures.natures[0]._id,
    ...STAGE[stage],
    ...extra,
  });

const homeOrIncoming = (role, tab) =>
  request(app)
    .get("/bill/get-filtered-bills")
    .query({ role, ...(tab ? { tab } : {}) })
    .set("Authorization", `Bearer ${tokenFor(fixtures.users[role])}`);

const forwarded = (role) =>
  request(app)
    .get(`/sentBills/${role}`)
    .set("Authorization", `Bearer ${tokenFor(fixtures.users[role])}`);

/**
 * Sr numbers from a tab response. getFilteredBills answers with a bare array,
 * sentBills with { data: [...] }, and a role with no such tab answers 400 with
 * an object - which must read as "no bills", not throw.
 */
const srNos = (res) => {
  const body = Array.isArray(res.body) ? res.body : res.body?.data;
  return Array.isArray(body) ? body.map((b) => b.srNo).sort() : [];
};

/* ================================================================== *
 * HOME
 * ================================================================== */
describe("HOME tab", () => {
  test("Site: bills at site, and those in transit to PIMO", async () => {
    // A dispatched-but-unreceived bill now STAYS on Site Home (observation
    // N-34). Until PIMO acknowledges it, it is still the site's problem, and
    // previously it belonged to no tab at all.
    const atSite = await makeBill("atSite");
    const inTransit = await makeBill("dispatchedToPimo");
    const res = await homeOrIncoming("site_officer", "home");
    assert.deepEqual(srNos(res), [atSite.srNo, inTransit.srNo].sort());
  });

  test("Site: drops off once PIMO receives it", async () => {
    await makeBill("receivedAtPimo");
    const res = await homeOrIncoming("site_officer", "home");
    assert.deepEqual(srNos(res), []);
  });

  test("PIMO: keyed on col 62 received, NOT col 61 dispatched", async () => {
    await makeBill("dispatchedToPimo"); // sent but not received - Incoming, not Home
    const keep = await makeBill("receivedAtPimo");
    const res = await homeOrIncoming("site_pimo", "home");
    assert.deepEqual(
      srNos(res),
      [keep.srNo],
      "a bill only reaches the PIMO home tab once PIMO marks it received"
    );
  });

  test("PIMO: drops off once Accounts receives it", async () => {
    await makeBill("receivedInAccounts");
    const res = await homeOrIncoming("site_pimo", "home");
    assert.deepEqual(srNos(res), []);
  });

  test("Accounts: keyed on col 82 received, NOT col 80 given", async () => {
    await makeBill("givenToAccounts"); // given but not received - Incoming
    const keep = await makeBill("receivedInAccounts");
    const res = await homeOrIncoming("accounts", "home");
    assert.deepEqual(
      srNos(res),
      [keep.srNo],
      "a bill only reaches the Accounts home tab once Accounts marks it received"
    );
  });

  test("Accounts: drops off once paid", async () => {
    await makeBill("paid");
    const res = await homeOrIncoming("accounts", "home");
    assert.deepEqual(srNos(res), []);
  });

  test("Trustee: Hold or Accept and unpaid", async () => {
    const a = await makeBill("atSite"); // hold, unpaid
    const b = await makeBill("receivedAtPimo"); // accept, unpaid
    await makeBill("paid"); // paid - belongs on Forwarded
    const res = await homeOrIncoming("director", "home");
    assert.deepEqual(srNos(res), [a.srNo, b.srNo].sort());
  });

  test("QS: given to QS and not yet returned", async () => {
    const keep = await makeBill("withQs");
    await makeBill("returnedByQs");
    await makeBill("atSite"); // never went to QS
    const res = await homeOrIncoming("qs_site", "home");
    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("QS: a bill sent straight for Prov COP still appears (col 40)", async () => {
    const keep = await makeBill("atSite", { "qsCOP.dateGiven": D("2026-07-06") });
    const res = await homeOrIncoming("qs_site", "home");
    assert.deepEqual(srNos(res), [keep.srNo]);
  });
});

/* ================================================================== *
 * INCOMING
 * ================================================================== */
describe("INCOMING tab", () => {
  test("PIMO: dispatched (61) but not received (62)", async () => {
    const keep = await makeBill("dispatchedToPimo");
    await makeBill("receivedAtPimo"); // already received - Home
    await makeBill("atSite"); // never dispatched
    const res = await homeOrIncoming("site_pimo", "incoming");
    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("Accounts: given (80) but not received (82)", async () => {
    const keep = await makeBill("givenToAccounts");
    await makeBill("receivedInAccounts"); // already received - Home
    const res = await homeOrIncoming("accounts", "incoming");
    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("a bill is on exactly one of Home and Incoming, never both", async () => {
    await makeBill("dispatchedToPimo");
    await makeBill("receivedAtPimo");

    const home = srNos(await homeOrIncoming("site_pimo", "home"));
    const inc = srNos(await homeOrIncoming("site_pimo", "incoming"));
    assert.equal(home.length, 1);
    assert.equal(inc.length, 1);
    assert.equal(
      home.filter((s) => inc.includes(s)).length,
      0,
      "the two tabs must not overlap"
    );
  });

  test("with no tab given, the response carries Home and Incoming together", async () => {
    // The dashboard fetches once and splits client-side, so the default
    // response has to contain both.
    await makeBill("dispatchedToPimo");
    await makeBill("receivedAtPimo");
    const res = await homeOrIncoming("site_pimo");
    assert.equal(srNos(res).length, 2);
  });
});

/* ================================================================== *
 * FORWARDED
 * ================================================================== */
describe("FORWARDED tab", () => {
  test("Site: col 62 filled", async () => {
    const keep = await makeBill("receivedAtPimo");
    await makeBill("atSite");
    const res = await forwarded("site_officer");
    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("Site: a bill manually set to Proforma or Reject also appears", async () => {
    const a = await makeBill("atSite", { siteStatus: "proforma" });
    const b = await makeBill("atSite", { siteStatus: "reject" });
    const res = await forwarded("site_officer");
    assert.deepEqual(srNos(res), [a.srNo, b.srNo].sort());
  });

  test("PIMO: col 82 filled", async () => {
    const keep = await makeBill("receivedInAccounts");
    await makeBill("receivedAtPimo");
    const res = await forwarded("site_pimo");
    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("Accounts: col 89 filled", async () => {
    const keep = await makeBill("paid");
    await makeBill("receivedInAccounts");
    const res = await forwarded("accounts");
    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("Trustee: Hold or Accept and paid", async () => {
    const keep = await makeBill("paid");
    await makeBill("receivedAtPimo"); // unpaid - Home
    const res = await forwarded("director");
    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("QS: col 66 filled", async () => {
    const keep = await makeBill("returnedByQs");
    await makeBill("withQs");
    const res = await forwarded("qs_site");
    assert.deepEqual(srNos(res), [keep.srNo]);
  });
});

/* ================================================================== *
 * A bill never disappears
 * ================================================================== */
describe("no bill falls out of every tab", () => {
  const JOURNEY = [
    "atSite",
    "withQs",
    "returnedByQs",
    "dispatchedToPimo",
    "receivedAtPimo",
    "givenToAccounts",
    "receivedInAccounts",
    "paid",
  ];
  const ROLES = ["site_officer", "qs_site", "site_pimo", "accounts", "director"];

  for (const stage of JOURNEY) {
    test(`a bill at "${stage}" is visible to at least one team`, async () => {
      const bill = await makeBill(stage);
      const seen = [];
      for (const role of ROLES) {
        for (const tab of ["home", "incoming"]) {
          const res = await homeOrIncoming(role, tab);
          if (srNos(res).includes(bill.srNo)) seen.push(`${role}/${tab}`);
        }
        const f = await forwarded(role);
        if (srNos(f).includes(bill.srNo)) seen.push(`${role}/forwarded`);
      }
      assert.ok(
        seen.length > 0,
        `a bill at "${stage}" appears on no tab for any team - this is the "bill vanished" complaint`
      );
    });
  }
});

/* ================================================================== *
 * Region scoping
 * ================================================================== */
describe("region scoping", () => {
  test("a user only sees bills in their own region", async () => {
    await makeBill("atSite", { region: "MUMBAI" });
    await makeBill("atSite", { region: "INDORE" });
    const res = await homeOrIncoming("site_officer", "home");
    const regions = (res.body.data ?? res.body ?? []).map((b) => b.region);
    assert.ok(
      regions.every((r) => r === "MUMBAI" || (Array.isArray(r) && r.includes("MUMBAI"))),
      `a MUMBAI user must not see other regions, saw: ${JSON.stringify(regions)}`
    );
  });

  test("the forwarded tab is region scoped too", async () => {
    await makeBill("receivedAtPimo", { region: "MUMBAI" });
    await makeBill("receivedAtPimo", { region: "INDORE" });
    const res = await forwarded("site_officer");
    const regions = (res.body.data ?? []).map((b) => b.region);
    assert.ok(
      regions.every((r) => r === "MUMBAI" || (Array.isArray(r) && r.includes("MUMBAI"))),
      `forwarded leaked other regions: ${JSON.stringify(regions)}`
    );
  });

  test("the forwarded endpoint requires a token", async () => {
    const res = await request(app).get("/sentBills/site_officer");
    assert.equal(res.status, 401);
  });
});

/* ================================================================== *
 * Reject Payment (29.09 reply, question 5)
 *
 * The rule changed after this was first built. It used to send the bill all
 * the way back to Site; the client has since said it must stay with Accounts:
 *
 *   "if reject payment, then only date of payment should be removed... and the
 *    bill should move from forwarded tab to Home tab of Accounts Team. No other
 *    data should be removed. It should not go back to PIMO/Site Team. Status at
 *    Site should remain 'accept' only."
 * ================================================================== */
describe("Reject Payment", () => {
  const reject = (billId, role = "accounts") =>
    request(app)
      .post("/bill/reject-payment")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users[role])}`)
      .send({ billId });

  test("the bill moves from Accounts Forwarded to Accounts HOME", async () => {
    const bill = await makeBill("paid");
    assert.deepEqual(srNos(await forwarded("accounts")), [bill.srNo]);

    const res = await reject(bill._id.toString());
    assert.equal(res.status, 200, res.text?.slice(0, 200));

    assert.deepEqual(
      srNos(await homeOrIncoming("accounts", "home")),
      [bill.srNo],
      "it belongs on the Accounts home tab"
    );
    assert.deepEqual(srNos(await forwarded("accounts")), [], "and not on their forwarded tab");
  });

  test("it does NOT go back to Site or PIMO", async () => {
    // This is the behaviour that was removed: the previous rule cleared
    // columns 61, 62, 80 and 82 and set the status to Hold.
    const bill = await makeBill("paid");
    await reject(bill._id.toString());

    assert.deepEqual(srNos(await homeOrIncoming("site_officer", "home")), []);
    assert.deepEqual(srNos(await homeOrIncoming("site_pimo", "home")), []);
  });

  test("only the payment date is cleared - nothing else", async () => {
    const bill = await makeBill("paid");
    const before = await Bill.findById(bill._id).lean();

    await reject(bill._id.toString());
    const after = await Bill.findById(bill._id).lean();

    assert.equal(after.accountsDept.paymentDate, null, "col 89 cleared");
    assert.equal(after.siteStatus, "accept", "Status at Site must stay accept");

    for (const [path, label] of [
      ["accountsDept.dateGiven", "col 80"],
      ["accountsDept.dateReceived", "col 82"],
      ["pimoMumbai.dateGiven", "col 61"],
      ["pimoMumbai.dateReceived", "col 62"],
    ]) {
      const [a_, b_] = path.split(".");
      assert.deepEqual(
        String(after[a_]?.[b_] ?? null),
        String(before[a_]?.[b_] ?? null),
        `${label} must be untouched`
      );
    }
  });

  test("payment status follows the date back to blank", async () => {
    // Not "Unpaid" - the client removed that value entirely (29.09, item 15).
    const bill = await makeBill("paid");
    await reject(bill._id.toString());

    const after = await Bill.findById(bill._id).lean();
    assert.ok(!after.accountsDept.status, "status must be blank, shown as '-'");
  });

  test("the Trustee forwarded tab loses it too", async () => {
    const bill = await makeBill("paid");
    await reject(bill._id.toString());
    assert.deepEqual(srNos(await forwarded("director")), []);
  });
});

/* ================================================================== *
 * The status matrix (mail of 24 September, item 2)
 *
 * Until now a tab was decided purely by which dates were filled. The client
 * has added a second axis: Status at Site and Payment Status.
 * ================================================================== */
describe("status and payment narrow the tabs", () => {
  test("PIMO Home excludes Reject and Proforma", async () => {
    // "Bills with status at site - Reject and Proforma - are appearing in Home
    // tab of PIMO Team. Only status accept should appear."
    const keep = await makeBill("receivedAtPimo", { siteStatus: "accept" });
    await makeBill("receivedAtPimo", { siteStatus: "reject" });
    await makeBill("receivedAtPimo", { siteStatus: "proforma" });
    await makeBill("receivedAtPimo", { siteStatus: "hold" });

    const res = await homeOrIncoming("site_pimo", "home");
    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("PIMO Home excludes paid bills", async () => {
    // She named 2600025, 2600027, 2600028 and 2600029 as paid bills sitting
    // on the PIMO home tab.
    const keep = await makeBill("receivedAtPimo", { siteStatus: "accept" });
    await makeBill("receivedAtPimo", {
      siteStatus: "accept",
      "accountsDept.paymentDate": D("2026-07-25"), // status follows the date
    });

    const res = await homeOrIncoming("site_pimo", "home");
    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("a blank payment status does not hide a bill", async () => {
    // Legacy rows carry no status at all. Membership is tested as "not Paid"
    // rather than "equals Unpaid" so those rows stay visible until the N-28
    // backfill has run.
    const keep = await makeBill("receivedAtPimo", { siteStatus: "accept" });
    await Bill.updateOne({ _id: keep._id }, { $unset: { "accountsDept.status": "" } });

    const res = await homeOrIncoming("site_pimo", "home");
    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("Accounts Home takes only accepted bills", async () => {
    // This was deliberately looser until the client confirmed the workflow
    // guarantees the status: "Site Team can't send the bill to Accounts Team...
    // Once the bill is accepted in PIMO, Status at Site changes to Accept."
    const keep = await makeBill("receivedInAccounts", { siteStatus: "accept" });
    await makeBill("receivedInAccounts", { siteStatus: "hold" });
    await makeBill("receivedInAccounts", { siteStatus: "reject" });

    const res = await homeOrIncoming("accounts", "home");
    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("QS Forwarded also takes Proforma and Reject bills", async () => {
    // observation N-17: those bills never come back from QS, so column 66
    // alone left them on the QS home tab for ever.
    const returned = await makeBill("returnedByQs");
    const proforma = await makeBill("withQs", { siteStatus: "proforma" });
    const reject = await makeBill("withQs", { siteStatus: "reject" });

    const res = await forwarded("qs_site");
    assert.deepEqual(srNos(res), [returned.srNo, proforma.srNo, reject.srNo].sort());
  });

  test("QS Home sorts on col 40 before col 35", async () => {
    // observation N-35.
    const { SORT_FIELD } = await import("../../utils/tab-predicates.js");
    assert.deepEqual(SORT_FIELD.home.qs_site, [
      "qsCOP.dateGiven",       // 40
      "qsInspection.dateGiven", // 35
      "qsMumbai.dateGiven",     // 64
    ]);
  });
});
