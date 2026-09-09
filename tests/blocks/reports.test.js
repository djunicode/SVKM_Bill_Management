/**
 * BLOCK: reports
 *
 * The fifteen reports defined on the "Report logics" sheet. Each is a pair of
 * emptiness tests over the column register plus a status, so the tests below
 * put bills into an exact state and assert what each report does and does not
 * return.
 *
 * Two things this block is specifically written to catch:
 *   - authorize() is handed `req.user.role`, which the JWT carries as an ARRAY.
 *     Every report route is gated by it.
 *   - the default date window, which the newer spec revision moved from
 *     "today" to 01-01-2020 -> today.
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

const get = (path, role, query = {}) =>
  request(app)
    .get(path)
    .query(query)
    .set("Authorization", `Bearer ${tokenFor(fixtures.users[role])}`);

/**
 * Reports answer as { report: { title, generatedAt, filterCriteria, data } }
 * and appendGrandTotalTaxAmount pushes a trailing summary row flagged
 * isGrandTotal. `rowsOf` returns the data rows only; `totalOf` the summary.
 */
const rowsOf = (res) =>
  (res.body?.report?.data ?? []).filter((r) => !r.isGrandTotal && !r.isSubtotal);

const totalOf = (res) =>
  (res.body?.report?.data ?? []).find((r) => r.isGrandTotal);

/** Create a bill directly, so any column can be put in any state. */
const makeBill = async (fields = {}) =>
  Bill.create({
    srNo: "2627" + Math.floor(10000 + Math.random() * 89999),
    projectDescription: "Mithibai College - Block A",
    vendor: fixtures.vendor._id,
    poCreated: "No",
    taxInvNo: "INV-" + Math.floor(Math.random() * 1e6),
    taxInvDate: new Date("2026-07-01"),
    taxInvAmt: 100000,
    taxInvRecdAtSite: new Date("2026-07-03"), // col 24
    billDate: new Date("2026-07-01"),
    amount: 100000,
    currency: fixtures.currencies[0]._id,
    region: "MUMBAI",
    natureOfWork: fixtures.natures[0]._id,
    siteStatus: "hold",
    ...fields,
  });

/* ------------------------------------------------------------------ *
 * 1. Route authorisation - every report, every entitled role
 * ------------------------------------------------------------------ */
describe("report routes accept the roles the route entitles", () => {
  // Transcribed from routes/report-route.js. qs_mumbai is omitted throughout:
  // it appears in the route's QS_ROLES but is NOT a value in the user model's
  // role enum, so no such user can exist.
  const MATRIX = [
    ["/api/reports/invoices-received-at-site", ["site_officer", "site_pimo", "pimo_mumbai", "director", "admin"]],
    ["/api/reports/invoices-received-at-pimo-mumbai", ["pimo_mumbai", "director", "admin"]],
    ["/api/reports/invoices-received-at-qsmeasurement", ["site_officer", "site_pimo", "pimo_mumbai", "director", "admin", "qs_site"]],
    ["/api/reports/invoices-received-at-qscop", ["site_officer", "site_pimo", "pimo_mumbai", "director", "admin", "qs_site"]],
    ["/api/reports/invoices-received-at-qsmumbai", ["qs_site", "admin", "pimo_mumbai"]],
    ["/api/reports/invoices-courier-to-pimo-mumbai", ["site_officer", "site_pimo", "pimo_mumbai", "admin"]],
    ["/api/reports/invoices-returned-by-qsmeasurement", ["qs_site", "admin"]],
    ["/api/reports/invoices-returned-by-qscop", ["qs_site", "admin"]],
    ["/api/reports/invoices-returned-by-qsmumbai", ["qs_site", "admin"]],
    ["/api/reports/invoices-given-to-accounts", ["pimo_mumbai", "director", "admin"]],
    ["/api/reports/invoices-Paid", ["accounts", "director", "admin"]],
    ["/api/reports/outstanding-bills", ["accounts", "director", "admin"]],
    ["/api/reports/outstanding-bills-subtotal", ["accounts", "director", "admin"]],
    ["/api/reports/bill-kidhar", ["pimo_mumbai", "director", "admin"]],
    ["/api/reports/bill-journey", ["pimo_mumbai", "director", "admin", "accounts"]],
  ];

  for (const [path, roles] of MATRIX) {
    for (const role of roles) {
      test(`${role} may open ${path.replace("/api/reports/", "")}`, async () => {
        const res = await get(path, role);
        assert.notEqual(
          res.status,
          403,
          `${role} is entitled to this report but was refused: ${JSON.stringify(res.body)}`
        );
        assert.equal(res.status, 200, res.text?.slice(0, 200));
      });
    }
  }

  test("a role with no entitlement is refused", async () => {
    const res = await get("/api/reports/outstanding-bills", "site_officer");
    assert.equal(res.status, 403);
  });

  test("no token is refused", async () => {
    const res = await request(app).get("/api/reports/invoices-received-at-site");
    assert.equal(res.status, 401);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Inclusion logic - the filled/blank pairs
 * ------------------------------------------------------------------ */
describe("report 1 - Invoices at Site: col 24 filled, col 61 blank, Hold", () => {
  test("includes a bill received at site and not yet dispatched", async () => {
    await makeBill();
    const res = await get("/api/reports/invoices-received-at-site", "site_officer");
    assert.equal(res.status, 200);
    const rows = rowsOf(res);
    assert.ok(rows.length >= 1, `expected at least one row, got ${JSON.stringify(res.body).slice(0, 250)}`);
  });

  test("excludes a bill already dispatched to PIMO (col 61 filled)", async () => {
    await makeBill({ "pimoMumbai.dateGiven": new Date("2026-07-10") });
    const res = await get("/api/reports/invoices-received-at-site", "site_officer");
    const rows = rowsOf(res);
    assert.equal(rows.length, 0, "a dispatched bill must drop out of Invoices at Site");
  });

  test("excludes a bill whose status is not Hold", async () => {
    await makeBill({ siteStatus: "accept" });
    const res = await get("/api/reports/invoices-received-at-site", "site_officer");
    const rows = rowsOf(res);
    assert.equal(rows.length, 0);
  });
});

describe("report 2 - Invoices at PIMO: col 62 filled, col 80 blank, Accept", () => {
  test("includes a bill received at PIMO and not yet sent to Accounts", async () => {
    await makeBill({
      siteStatus: "accept",
      "pimoMumbai.dateReceived": new Date("2026-07-12"),
    });
    const res = await get("/api/reports/invoices-received-at-pimo-mumbai", "pimo_mumbai");
    assert.equal(res.status, 200);
    const rows = rowsOf(res);
    assert.equal(rows.length, 1);
  });

  test("excludes a bill already given to Accounts (col 80 filled)", async () => {
    await makeBill({
      siteStatus: "accept",
      "pimoMumbai.dateReceived": new Date("2026-07-12"),
      "accountsDept.dateGiven": new Date("2026-07-20"),
    });
    const res = await get("/api/reports/invoices-received-at-pimo-mumbai", "pimo_mumbai");
    const rows = rowsOf(res);
    assert.equal(rows.length, 0);
  });

  /* Q-09 / General #7: a bill created at PIMO has no col 62, because that date
   * is stamped when PIMO marks an incoming bill received. The spec says such a
   * bill should still appear in this report, so col 62 needs autofilling at
   * creation. Fails until that is done. */
  test("includes a bill created at PIMO Mumbai (role=3)", async () => {
    // Goes through POST /bill?role=3 rather than makeBill, because the fix is
    // in createBill: col 62 is stamped at creation for a PIMO-raised bill.
    const { billPayload } = seed;
    const created = await request(app)
      .post("/bill")
      .query({ role: "3" })
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.pimo_mumbai)}`)
      .send(billPayload({ taxInvNo: "PIMO-CREATED" }));
    assert.equal(created.status, 201, created.text?.slice(0, 200));
    assert.ok(created.body.bill.pimoMumbai.dateReceived, "col 62 must be stamped at creation");
    assert.equal(created.body.bill.siteStatus, "accept");

    const res = await get("/api/reports/invoices-received-at-pimo-mumbai", "pimo_mumbai");
    assert.equal(rowsOf(res).length, 1, "a PIMO-raised bill must appear in Invoices at PIMO");
  });
});

describe("report 12 - Outstanding Bills: col 82 filled, col 89 blank, Accept", () => {
  test("includes a bill received in Accounts and unpaid", async () => {
    await makeBill({
      siteStatus: "accept",
      "accountsDept.dateReceived": new Date("2026-07-25"),
    });
    const res = await get("/api/reports/outstanding-bills", "accounts");
    assert.equal(res.status, 200);
    const rows = rowsOf(res);
    assert.equal(rows.length, 1);
  });

  test("excludes a bill once paid (col 89 filled)", async () => {
    await makeBill({
      siteStatus: "accept",
      "accountsDept.dateReceived": new Date("2026-07-25"),
      "accountsDept.paymentDate": new Date("2026-08-01"),
    });
    const res = await get("/api/reports/outstanding-bills", "accounts");
    const rows = rowsOf(res);
    assert.equal(rows.length, 0);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Cross-cutting rules the Report logics sheet applies to all reports
 * ------------------------------------------------------------------ */
describe("rules that apply to every report", () => {
  test("region filter narrows the result", async () => {
    await makeBill({ region: "MUMBAI" });
    await makeBill({ region: "INDORE" });

    const all = await get("/api/reports/invoices-received-at-site", "admin");
    const mumbai = await get("/api/reports/invoices-received-at-site", "admin", { region: "MUMBAI" });

    const count = (r) => rowsOf(r).length;
    assert.equal(count(all), 2);
    assert.equal(count(mumbai), 1);
  });

  /* Report logics, General #5: "If field be blank then it should be shown as
   * blank and no N/A". */
  test("blank fields render blank, never N/A", async () => {
    await makeBill({ poNo: undefined });
    const res = await get("/api/reports/invoices-received-at-site", "admin");
    const body = JSON.stringify(res.body);
    assert.ok(!/"N\/A"/.test(body), "a blank column must not be reported as N/A");
  });

  /* Report logics, General #2: "Grand total in each amount column at the end". */
  test("a grand total row is appended", async () => {
    await makeBill({ taxInvAmt: 50000 });
    await makeBill({ taxInvAmt: 70000 });
    const res = await get("/api/reports/invoices-received-at-site", "admin");
    const total = totalOf(res);
    assert.ok(total, "every report must append a grand-total row");
    assert.equal(total.grandTotalLabel, "Grand Total");
    assert.equal(total.grandTotalTaxAmount, 120000, "50000 + 70000");
    assert.equal(total.count, 2, "count at the end of the report");
  });
});

/* ------------------------------------------------------------------ *
 * 4. The date selection window
 * ------------------------------------------------------------------ */
describe("date window - Report logics: default 01-01-2020 to today", () => {
  test("a full range narrows to it", async () => {
    await makeBill({ taxInvRecdAtSite: new Date("2026-07-03") });
    await makeBill({ taxInvRecdAtSite: new Date("2026-02-10") });

    const res = await get("/api/reports/invoices-received-at-site", "admin", {
      startDate: "2026-07-01",
      endDate: "2026-07-31",
    });
    assert.equal(rowsOf(res).length, 1);
  });

  /* A one-sided selection used to be ignored entirely, so the report silently
   * widened to every bill ever raised - one candidate for the client's
   * "change the date range and the report goes blank/wrong". */
  test("a start date on its own is honoured", async () => {
    await makeBill({ taxInvRecdAtSite: new Date("2026-07-03") });
    await makeBill({ taxInvRecdAtSite: new Date("2026-02-10") });

    const res = await get("/api/reports/invoices-received-at-site", "admin", {
      startDate: "2026-06-01",
    });
    assert.equal(rowsOf(res).length, 1, "only the July bill is on or after 01-06-2026");
  });

  test("an end date on its own is honoured", async () => {
    await makeBill({ taxInvRecdAtSite: new Date("2026-07-03") });
    await makeBill({ taxInvRecdAtSite: new Date("2026-02-10") });

    const res = await get("/api/reports/invoices-received-at-site", "admin", {
      endDate: "2026-03-01",
    });
    assert.equal(rowsOf(res).length, 1, "only the February bill is on or before 01-03-2026");
  });

  test("with no dates given, the default window applies", async () => {
    await makeBill({ taxInvRecdAtSite: new Date("2026-07-03") });
    await makeBill({ taxInvRecdAtSite: new Date("2019-05-01") }); // before 01-01-2020

    const res = await get("/api/reports/invoices-received-at-site", "admin");
    assert.equal(rowsOf(res).length, 1, "a pre-2020 bill falls outside the default window");
  });
});

/* ------------------------------------------------------------------ *
 * 5. W7 - the columns and totals the printed report needs
 * ------------------------------------------------------------------ */
describe("W7: report projections", () => {
  /* Report logics, General #3: "For below report Vendor No column required". */
  const NEEDS_VENDOR_NO = [
    ["/api/reports/invoices-courier-to-pimo-mumbai", "site_officer", "dispatchedToPimo"],
    ["/api/reports/invoices-returned-by-qsmeasurement", "qs_site", "returnedAfterMeasure"],
    ["/api/reports/invoices-returned-by-qscop", "qs_site", "returnedAfterProvCop"],
    ["/api/reports/invoices-returned-by-qsmumbai", "qs_site", "returnedByQsMumbai"],
    ["/api/reports/invoices-given-to-accounts", "pimo_mumbai", "givenToAccounts"],
  ];

  const SHAPE = {
    dispatchedToPimo: { "pimoMumbai.dateGiven": new Date("2026-07-10") },
    returnedAfterMeasure: {
      "qsMeasurementCheck.dateGiven": new Date("2026-07-05"),
      "vendorFinalInv.dateGiven": new Date("2026-07-08"),
    },
    returnedAfterProvCop: {
      "qsCOP.dateGiven": new Date("2026-07-05"),
      "copDetails.dateReturned": new Date("2026-07-08"),
    },
    returnedByQsMumbai: {
      siteStatus: "accept",
      "qsMumbai.dateGiven": new Date("2026-07-14"),
      "pimoMumbai.dateReturnedFromQs": new Date("2026-07-18"),
    },
    givenToAccounts: {
      siteStatus: "accept",
      "pimoMumbai.dateReceived": new Date("2026-07-12"),
      "accountsDept.dateGiven": new Date("2026-07-20"),
    },
  };

  for (const [path, role, shape] of NEEDS_VENDOR_NO) {
    const name = path.replace("/api/reports/", "");

    test(`${name} projects vendorNo (col 6)`, async () => {
      await makeBill(SHAPE[shape]);
      const res = await get(path, role);
      assert.equal(res.status, 200, res.text?.slice(0, 200));
      const rows = rowsOf(res);
      assert.ok(rows.length >= 1, `no rows returned for ${name}`);
      assert.equal(
        rows[0].vendorNo,
        123456,
        "the client asked for Vendor No on this report"
      );
    });

    test(`${name} appends a count for the Count column`, async () => {
      await makeBill(SHAPE[shape]);
      await makeBill(SHAPE[shape]);
      const res = await get(path, role);
      const total = totalOf(res);
      assert.ok(total, "a grand-total row must be appended");
      assert.equal(total.count, 2, "Count is a printed column on these five reports");
    });
  }

  test("vendorName is still present alongside vendorNo", async () => {
    await makeBill(SHAPE.dispatchedToPimo);
    const res = await get("/api/reports/invoices-courier-to-pimo-mumbai", "site_officer");
    const row = rowsOf(res)[0];
    assert.equal(row.vendorName, "Acme Constructions Pvt Ltd");
    assert.equal(row.vendorNo, 123456);
  });
});

