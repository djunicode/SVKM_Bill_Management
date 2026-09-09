/**
 * BLOCK: sorting, scoping and the legacy list endpoint
 *
 * Covers the day-8 work:
 *
 *   - GET /bill (getBills) carried its own hand-written copy of the Home-tab
 *     rules, drifted from the register in utils/tab-predicates.js. It now uses
 *     that register, so the two list endpoints agree.
 *   - Reports took only the FIRST region when the page sent the user's whole
 *     region list, so a multi-region user silently saw one region while the
 *     dropdown read "All Regions" (observations Q-08).
 *   - The Incoming tab sorts on the DISPATCH date (col 61 for PIMO, col 80 for
 *     Accounts), not the received date, which is blank on every incoming bill
 *     by definition (observations, Sorting R36).
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { startDb, stopDb, clearDb } from "../helpers/db.js";

let app, seed, tokenFor, fixtures, Bill, User;

before(async () => {
  await startDb();
  ({ buildApp: app } = await import("../helpers/app.js"));
  seed = await import("../helpers/seed.js");
  ({ tokenFor } = seed);
  ({ default: Bill } = await import("../../models/bill-model.js"));
  ({ default: User } = await import("../../models/user-model.js"));
  app = app();
});

after(async () => await stopDb());

beforeEach(async () => {
  await clearDb();
  fixtures = await seed.seedAll();
});

const D = (s) => new Date(s);
let n = 0;

const makeBill = async (extra = {}) =>
  Bill.create({
    srNo: "26280" + String(++n).padStart(4, "0"),
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
    siteStatus: "hold",
    currentCount: 1,
    ...extra,
  });

const srNos = (res) => {
  const body = Array.isArray(res.body) ? res.body : res.body?.data;
  return Array.isArray(body) ? body.map((b) => b.srNo) : [];
};

/* ================================================================== *
 * GET /bill - the legacy list endpoint
 * ================================================================== */
describe("GET /bill uses the tab register", () => {
  test("Site sees a bill waiting at site", async () => {
    const keep = await makeBill();
    await makeBill({ "pimoMumbai.dateGiven": D("2026-07-10"), currentCount: 3 });

    const res = await request(app)
      .get("/bill")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.site_officer)}`);

    assert.equal(res.status, 200);
    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("Site does NOT see a bill already dispatched to PIMO", async () => {
    // The old inline rule was "col 62 blank", which still matched a bill that
    // had been dispatched but not yet received - it appeared on Site's Home
    // tab and on PIMO's Incoming tab at the same time.
    await makeBill({ "pimoMumbai.dateGiven": D("2026-07-10"), currentCount: 3 });

    const res = await request(app)
      .get("/bill")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.site_officer)}`);

    assert.deepEqual(srNos(res), []);
  });

  test("PIMO sees a received bill, not one merely dispatched", async () => {
    const keep = await makeBill({
      "pimoMumbai.dateGiven": D("2026-07-10"), // col 61
      "pimoMumbai.dateReceived": D("2026-07-12"), // col 62
      currentCount: 3,
    });
    await makeBill({ "pimoMumbai.dateGiven": D("2026-07-10"), currentCount: 3 });

    const res = await request(app)
      .get("/bill")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.site_pimo)}`);

    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("Accounts has a Home tab here too - it had none before", async () => {
    const keep = await makeBill({
      "accountsDept.dateGiven": D("2026-07-20"), // col 80
      "accountsDept.dateReceived": D("2026-07-22"), // col 82
      currentCount: 5,
    });
    await makeBill({ "accountsDept.dateGiven": D("2026-07-20"), currentCount: 5 });

    const res = await request(app)
      .get("/bill")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.accounts)}`);

    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("team_name overrides the caller's own team", async () => {
    const atSite = await makeBill();
    await makeBill({
      "pimoMumbai.dateGiven": D("2026-07-10"),
      "pimoMumbai.dateReceived": D("2026-07-12"),
      currentCount: 3,
    });

    const res = await request(app)
      .get("/bill")
      .query({ team_name: "site_officer" })
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.site_pimo)}`);

    assert.deepEqual(srNos(res), [atSite.srNo]);
  });

  test("QS gets its own home tab, which the role fallback never handled", async () => {
    const keep = await makeBill({ "qsInspection.dateGiven": D("2026-07-05") }); // col 35
    await makeBill(); // never went to QS

    const res = await request(app)
      .get("/bill")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.qs_site)}`);

    assert.deepEqual(srNos(res), [keep.srNo]);
  });

  test("an admin with no team_name sees every bill, not an arbitrary tab", async () => {
    await makeBill();
    await makeBill({ "pimoMumbai.dateGiven": D("2026-07-10"), currentCount: 3 });

    const res = await request(app)
      .get("/bill")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.admin)}`);

    assert.equal(res.status, 200);
    assert.equal(srNos(res).length, 2);
  });

  test("it is region scoped for a non-admin", async () => {
    await makeBill();
    await makeBill({ region: "INDORE" });

    const res = await request(app)
      .get("/bill")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.site_officer)}`);

    assert.equal(srNos(res).length, 1);
  });

  test("the response is flattened - vendor no reaches the client", async () => {
    await makeBill();

    const res = await request(app)
      .get("/bill")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.site_officer)}`);

    assert.equal(res.body[0].vendorNo, 123456); // col 6
    assert.equal(res.body[0].vendorName, "Acme Constructions Pvt Ltd"); // col 7
    assert.equal(res.body[0].region, "MUMBAI"); // col 4, a string not an array
    assert.equal(res.body[0].natureOfWork, "Materials"); // col 3
  });
});

/* ================================================================== *
 * Multi-region reports
 * ================================================================== */
describe("reports honour every region the caller asks for", () => {
  /** A user who covers three regions, as the report pages assume. */
  const multiRegionUser = async () => {
    const u = await User.create({
      name: "Test multi",
      email: "multi@test.example",
      password: "password123",
      role: ["site_officer"],
      department: ["Site"],
      region: ["MUMBAI", "INDORE", "DHULE"],
    });
    return tokenFor(u);
  };

  const atSite = { taxInvRecdAtSite: D("2026-07-03") };

  test("region[]=A&region[]=B returns both, not just the first", async () => {
    await makeBill({ region: "MUMBAI", ...atSite });
    await makeBill({ region: "INDORE", ...atSite });
    await makeBill({ region: "DHULE", ...atSite });

    const token = await multiRegionUser();
    const res = await request(app)
      .get("/api/reports/invoices-received-at-site")
      .query({ region: ["MUMBAI", "INDORE"], startDate: "2026-01-01", endDate: "2026-12-31" })
      .set("Authorization", `Bearer ${token}`);

    assert.equal(res.status, 200);
    const rows = res.body.report.data.filter((r) => !r.isGrandTotal);
    const regions = [...new Set(rows.map((r) => r.region))].sort();
    assert.deepEqual(regions, ["INDORE", "MUMBAI"]);
  });

  test("a single region still filters to that one region", async () => {
    await makeBill({ region: "MUMBAI", ...atSite });
    await makeBill({ region: "INDORE", ...atSite });

    const token = await multiRegionUser();
    const res = await request(app)
      .get("/api/reports/invoices-received-at-site")
      .query({ region: "INDORE", startDate: "2026-01-01", endDate: "2026-12-31" })
      .set("Authorization", `Bearer ${token}`);

    const rows = res.body.report.data.filter((r) => !r.isGrandTotal);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].region, "INDORE");
  });

  test("no region at all means no region filter", async () => {
    await makeBill({ region: "MUMBAI", ...atSite });
    await makeBill({ region: "INDORE", ...atSite });
    await makeBill({ region: "DHULE", ...atSite });

    const token = await multiRegionUser();
    const res = await request(app)
      .get("/api/reports/invoices-received-at-site")
      .query({ startDate: "2026-01-01", endDate: "2026-12-31" })
      .set("Authorization", `Bearer ${token}`);

    const rows = res.body.report.data.filter((r) => !r.isGrandTotal);
    assert.equal(rows.length, 3);
  });

  test("an empty region string is ignored, not treated as a region", async () => {
    await makeBill({ region: "MUMBAI", ...atSite });

    const token = await multiRegionUser();
    const res = await request(app)
      .get("/api/reports/invoices-received-at-site")
      .query({ region: "", startDate: "2026-01-01", endDate: "2026-12-31" })
      .set("Authorization", `Bearer ${token}`);

    const rows = res.body.report.data.filter((r) => !r.isGrandTotal);
    assert.equal(rows.length, 1);
  });
});

/* ================================================================== *
 * Tab sort order
 * ================================================================== */
describe("tab sort order", () => {
  test("PIMO Incoming sorts on col 61, latest first", async () => {
    const oldest = await makeBill({ "pimoMumbai.dateGiven": D("2026-07-01"), currentCount: 3 });
    const newest = await makeBill({ "pimoMumbai.dateGiven": D("2026-07-20"), currentCount: 3 });
    const middle = await makeBill({ "pimoMumbai.dateGiven": D("2026-07-10"), currentCount: 3 });

    const res = await request(app)
      .get("/bill/get-filtered-bills")
      .query({ role: "site_pimo", tab: "incoming" })
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.site_pimo)}`);

    assert.deepEqual(srNos(res), [newest.srNo, middle.srNo, oldest.srNo]);
  });

  test("Accounts Incoming sorts on col 80, latest first", async () => {
    const oldest = await makeBill({ "accountsDept.dateGiven": D("2026-07-01"), currentCount: 5 });
    const newest = await makeBill({ "accountsDept.dateGiven": D("2026-07-20"), currentCount: 5 });

    const res = await request(app)
      .get("/bill/get-filtered-bills")
      .query({ role: "accounts", tab: "incoming" })
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.accounts)}`);

    assert.deepEqual(srNos(res), [newest.srNo, oldest.srNo]);
  });

  test("same-day bills fall through to Sr no, highest first", async () => {
    const a = await makeBill({ "pimoMumbai.dateGiven": D("2026-07-10"), currentCount: 3 });
    const b = await makeBill({ "pimoMumbai.dateGiven": D("2026-07-10"), currentCount: 3 });

    const res = await request(app)
      .get("/bill/get-filtered-bills")
      .query({ role: "site_pimo", tab: "incoming" })
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.site_pimo)}`);

    const [first, second] = srNos(res);
    assert.equal(first, b.srNo > a.srNo ? b.srNo : a.srNo);
    assert.equal(second, b.srNo > a.srNo ? a.srNo : b.srNo);
  });

  test("PIMO Home sorts on col 62, not col 61", async () => {
    // Received last but dispatched first: on col 62 it must come second.
    const dispatchedFirst = await makeBill({
      "pimoMumbai.dateGiven": D("2026-07-01"),
      "pimoMumbai.dateReceived": D("2026-07-05"),
      currentCount: 3,
    });
    const receivedLater = await makeBill({
      "pimoMumbai.dateGiven": D("2026-07-20"),
      "pimoMumbai.dateReceived": D("2026-07-25"),
      currentCount: 3,
    });

    const res = await request(app)
      .get("/bill/get-filtered-bills")
      .query({ role: "site_pimo", tab: "home" })
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.site_pimo)}`);

    assert.deepEqual(srNos(res), [receivedLater.srNo, dispatchedFirst.srNo]);
  });
});

/* ================================================================== *
 * Role names in the route guards
 *
 * Three route guards named roles that are not in the user schema's enum, so
 * they matched nobody. authorize() cannot warn about this: an unknown name is
 * simply a name no user holds.
 * ================================================================== */
describe("route guards name roles that actually exist", () => {
  test("the PIMO user can open their own four reports", async () => {
    // PIMO_ROLES listed only "pimo_mumbai". The login role is "site_pimo", so
    // Invoices at PIMO, Invoices sent to Accts Team, Bill Journey and
    // Invoices at QS Mumbai all answered 403 to the team that owns them.
    const token = tokenFor(fixtures.users.site_pimo);
    for (const path of [
      "/api/reports/invoices-received-at-pimo-mumbai",
      "/api/reports/invoices-given-to-accounts",
      "/api/reports/bill-journey",
      "/api/reports/invoices-received-at-qsmumbai",
    ]) {
      const res = await request(app).get(path).set("Authorization", `Bearer ${token}`);
      assert.notEqual(res.status, 403, `${path} must not refuse the PIMO team`);
    }
  });

  test("a Trustee can edit payment instructions", async () => {
    // The route was guarded on "trustees", which is not a role. Its own
    // comment says "(Accounts / Trustees / Admin)".
    const bill = await makeBill({ "accountsDept.dateReceived": D("2026-07-22") });
    const res = await request(app)
      .patch(`/bill/payment-instructions/${bill._id}`)
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.director)}`)
      .send({ remarksForPayInstructions: "approved" });

    assert.notEqual(res.status, 403);
    assert.equal(res.status, 200);
  });

  test("Accounts can still edit payment instructions", async () => {
    const bill = await makeBill({ "accountsDept.dateReceived": D("2026-07-22") });
    const res = await request(app)
      .patch(`/bill/payment-instructions/${bill._id}`)
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.accounts)}`)
      .send({ f110Identification: "F110-1" });
    assert.equal(res.status, 200);
  });

  test("a team with no business there is still refused", async () => {
    const bill = await makeBill();
    const res = await request(app)
      .patch(`/bill/payment-instructions/${bill._id}`)
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.qs_site)}`)
      .send({ f110Identification: "F110-1" });
    assert.equal(res.status, 403);
  });

  test("vendor stats reach the finance team, not just admin", async () => {
    // Guarded on "finance", which is not a role either.
    const res = await request(app)
      .get("/stats/vendors")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.accounts)}`);
    assert.notEqual(res.status, 403);
  });
});
