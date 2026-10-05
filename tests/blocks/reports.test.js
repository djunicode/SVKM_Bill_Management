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
    // site_pimo and accounts both have the button (24.09, item 7).
    ["/api/reports/bill-kidhar", ["site_pimo", "pimo_mumbai", "director", "admin", "accounts"]],
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

/* 23.09, item 13: Remarks for Payment Instructions is editable in the
 * Outstanding report. Each row carries its bill id, and the edit goes through
 * the existing payment-instructions route. */
describe("report 12 - editable Remarks for Payment Instructions", () => {
  test("each row carries the bill id", async () => {
    const bill = await makeBill({
      siteStatus: "accept",
      "accountsDept.dateReceived": new Date("2026-07-25"),
    });
    const res = await get("/api/reports/outstanding-bills", "accounts");
    assert.equal(String(rowsOf(res)[0]._id), String(bill._id));
  });

  test("a saved remark shows in the report and touches nothing else", async () => {
    const bill = await makeBill({
      siteStatus: "accept",
      "accountsDept.dateReceived": new Date("2026-07-25"),
      "accountsDept.paymentInstructions": "Pay by RTGS",
    });

    const saved = await request(app)
      .patch(`/bill/payment-instructions/${bill._id}`)
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.accounts)}`)
      .send({ remarksForPayInstructions: "Hold till GST filed" });
    assert.equal(saved.status, 200);

    const row = rowsOf(await get("/api/reports/outstanding-bills", "accounts"))[0];
    assert.equal(row.remarksForPaymentInstructions, "Hold till GST filed");
    assert.equal(row.paymentInstructions, "Pay by RTGS");

    const after = await Bill.findById(bill._id).lean();
    assert.equal(after.accountsDept.paymentDate ?? null, null, "still unpaid");
    assert.equal(after.accountsDept.status ?? null, null, "status not invented");
  });

  test("a status sent in the body cannot mark an unpaid bill Paid", async () => {
    const bill = await makeBill({
      siteStatus: "accept",
      "accountsDept.dateReceived": new Date("2026-07-25"),
    });
    await request(app)
      .patch(`/bill/payment-instructions/${bill._id}`)
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.accounts)}`)
      .send({ remarksForPayInstructions: "x", status: "Paid" });

    const after = await Bill.findById(bill._id).lean();
    assert.equal(after.accountsDept.status ?? null, null);
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

/* ================================================================== *
 * Region scoping, sorting and the measurement report
 * (mail of 23 September, items 1.i, 1.v and 1.vii)
 * ================================================================== */
describe("reports are scoped to the caller's own regions", () => {
  let indoreUser;

  beforeEach(async () => {
    indoreUser = await User.create({
      name: "Indore site",
      email: "indore.reports@test.example",
      password: "password123",
      role: ["accounts"],
      department: ["Accounts"],
      region: ["INDORE"],
    });
  });

  const outstanding = (user, query = {}) =>
    request(app)
      .get("/api/reports/outstanding-bills")
      .query(query)
      .set("Authorization", `Bearer ${tokenFor(user)}`);

  test("a request with no region returns only the user's regions", async () => {
    // It used to return every region in the system - a Site or QS user could
    // read the whole organisation's bills (observation N-01).
    await makeBill({ siteStatus: "accept", "accountsDept.dateReceived": new Date("2026-08-05"), region: "MUMBAI", taxInvNo: "INV-MUM" });
    await makeBill({ siteStatus: "accept", "accountsDept.dateReceived": new Date("2026-08-05"), region: "INDORE", taxInvNo: "INV-IND" });

    const res = await outstanding(indoreUser);
    const regions = [...new Set(rowsOf(res).map((r) => r.region))];
    assert.deepEqual(regions, ["INDORE"]);
  });

  test("asking for a region you do not hold returns nothing", async () => {
    await makeBill({ siteStatus: "accept", "accountsDept.dateReceived": new Date("2026-08-05"), region: "MUMBAI", taxInvNo: "INV-MUM2" });
    await makeBill({ siteStatus: "accept", "accountsDept.dateReceived": new Date("2026-08-05"), region: "INDORE", taxInvNo: "INV-IND2" });

    const res = await outstanding(indoreUser, { region: "MUMBAI" });
    assert.equal(rowsOf(res).length, 0);
  });

  test("a multi-region user gets the intersection, not the union", async () => {
    const both = await User.create({
      name: "Two regions",
      email: "two.regions@test.example",
      password: "password123",
      role: ["accounts"],
      department: ["Accounts"],
      region: ["MUMBAI", "INDORE"],
    });
    await makeBill({ siteStatus: "accept", "accountsDept.dateReceived": new Date("2026-08-05"), region: "MUMBAI", taxInvNo: "INV-A" });
    await makeBill({ siteStatus: "accept", "accountsDept.dateReceived": new Date("2026-08-05"), region: "INDORE", taxInvNo: "INV-B" });
    await makeBill({ siteStatus: "accept", "accountsDept.dateReceived": new Date("2026-08-05"), region: "DHULE", taxInvNo: "INV-C" });

    const res = await outstanding(both, { region: ["INDORE", "DHULE"] });
    const regions = [...new Set(rowsOf(res).map((r) => r.region))];
    assert.deepEqual(regions, ["INDORE"], "DHULE is requested but not held");
  });

  test("an admin is not restricted", async () => {
    await makeBill({ siteStatus: "accept", "accountsDept.dateReceived": new Date("2026-08-05"), region: "MUMBAI", taxInvNo: "INV-ADM1" });
    await makeBill({ siteStatus: "accept", "accountsDept.dateReceived": new Date("2026-08-05"), region: "INDORE", taxInvNo: "INV-ADM2" });

    const res = await outstanding(fixtures.users.admin);
    const regions = [...new Set(rowsOf(res).map((r) => r.region))].sort();
    assert.deepEqual(regions, ["INDORE", "MUMBAI"]);
  });
});

describe("report sorting and the measurement report", () => {
  test("bills sharing a date fall back to Sr no descending", async () => {
    // observation N-05.
    const day = new Date("2026-08-10");
    await makeBill({ srNo: "2627001", taxInvRecdAtSite: day, taxInvNo: "S1" });
    await makeBill({ srNo: "2627003", taxInvRecdAtSite: day, taxInvNo: "S3" });
    await makeBill({ srNo: "2627002", taxInvRecdAtSite: day, taxInvNo: "S2" });

    const res = await get("/api/reports/invoices-received-at-site", "site_officer");
    const order = rowsOf(res).map((r) => r.srNo);
    assert.deepEqual(order, ["2627003", "2627002", "2627001"]);
  });

  test("the QS measurement report keys on column 35, not the check date", async () => {
    // observation N-07: it used to key on "Dt Checked by QS with Measure",
    // a later event, so bills merely given to QS were absent.
    const given = await makeBill({
      taxInvNo: "QS-35",
      siteStatus: "hold",
      "qsInspection.dateGiven": new Date("2026-08-01"), // col 35
    });
    await makeBill({
      taxInvNo: "QS-CHECKED",
      siteStatus: "hold",
      "qsMeasurementCheck.dateGiven": new Date("2026-08-02"),
    });

    const res = await get("/api/reports/invoices-received-at-qsmeasurement", "qs_site");
    const srNos = rowsOf(res).map((r) => r.srNo);
    assert.deepEqual(srNos, [given.srNo]);
    assert.ok(rowsOf(res)[0].dateGivenToQSMeasurement, "col 35 must be projected");
  });
});

/* ================================================================== *
 * Bill Journey - the column mapping she supplied
 *
 * "Bill Journey report.xlsx", attached 23 September, names the Field-entry
 * column behind every cell of the sheet. These assert that mapping.
 * ================================================================== */
describe("Bill Journey fetches the columns her layout names", () => {
  /** A bill carrying a value in every column the layout refers to. */
  const journeyBill = () =>
    makeBill({
      srNo: "2627900",
      region: "MUMBAI",
      taxInvNo: "INV-JOURNEY",
      taxInvRecdAtSite: new Date("2026-07-03"),   // 24
      taxInvRecdBy: "Site Clerk",                 // 25
      poNo: "1234567890",                         // 12
      poDate: new Date("2026-06-20"),             // 13
      poAmt: 500000,                              // 14
      proformaInvNo: "PRO-1",                     // 15
      proformaInvDate: new Date("2026-06-15"),    // 16
      proformaInvAmt: 100000,                     // 17
      "qualityEngineer.dateGiven": new Date("2026-07-04"), // 33
      "qualityEngineer.name": "Quality Eng",      // 34
      "qsInspection.dateGiven": new Date("2026-07-05"),    // 35
      "qsInspection.name": "QS Measure",          // 36
      "copDetails.date": new Date("2026-07-08"),  // 42
      "copDetails.amount": 444000,                // 43
      "migoDetails.no": "1000056752",             // 46
      "migoDetails.date": new Date("2026-07-09"), // 47
      "migoDetails.amount": 430000,               // 48
      "migoDetails.doneBy": "Vaishali",           // 49
      "siteEngineer.dateGiven": new Date("2026-07-06"),    // 51
      "siteEngineer.name": "Site Eng",            // 52
      "architect.dateGiven": new Date("2026-07-07"),       // 53
      "architect.name": "Archie",                 // 54
      "pimoMumbai.dateGiven": new Date("2026-07-10"),      // 61
      "pimoMumbai.dateReceived": new Date("2026-07-12"),   // 62
      "pimoMumbai.receivedBy": "PIMO Clerk",      // 63
      "qsMumbai.dateGiven": new Date("2026-07-14"),        // 64
      "qsMumbai.name": "QS Mumbai",               // 65
      "pimoMumbai.dateReturnedFromQs": new Date("2026-07-15"),  // 66
      "pimoMumbai.nameReturnedFromQs": "PIMO Desk",             // 67
      "itDept.dateGiven": new Date("2026-07-16"), // 68
      "itDept.name": "IT Desk",                   // 69
      "sesDetails.no": "2000011111",              // 72
      "sesDetails.amount": 420000,                // 73
      "sesDetails.date": new Date("2026-07-17"),  // 74
      "sesDetails.doneBy": "SES Guy",             // 74A
      "pimoMumbai.dateReceivedFromIT": new Date("2026-07-18"),  // 75
      "pimoMumbai.nameReceivedFromIT": "PIMO IT",               // 75A
      "pimoMumbai.dateReturnedFromDirector": new Date("2026-07-19"), // 78
      "accountsDept.dateGiven": new Date("2026-07-20"),    // 80
      "accountsDept.dateReceived": new Date("2026-07-22"), // 82
      "accountsDept.receivedBy": "Accts Clerk",   // 82A
      "accountsDept.paymentDate": new Date("2026-07-25"),  // 89
      "accountsDept.paymentAmt": 410000,          // 91
      "accountsDept.status": "Paid",              // 93
    });

  const journey = async () => {
    await journeyBill();
    const res = await get("/api/reports/bill-journey", "admin");
    assert.equal(res.status, 200);
    const row = rowsOf(res)[0];
    assert.ok(row, "the bill must appear in the report");
    return row;
  };

  test("the header block carries status, COP and payment", async () => {
    const row = await journey();
    assert.equal(row.status, "Paid");        // 93
    assert.equal(row.copAmt, 444000);        // 43
    assert.equal(row.paymentAmt, 410000);    // 91
    assert.ok(row.paymentDate, "col 89 must be projected");
  });

  test("every journey step carries its name column", async () => {
    const row = await journey();
    assert.equal(row.billReceivedAtSiteName, "Site Clerk");              // 25
    assert.equal(row.billSendForQualityCertificationName, "Quality Eng"); // 34
    assert.equal(row.billSendToQSName, "QS Measure");                    // 36
    assert.equal(row.certifiedByArchName, "Archie");                     // 54
    assert.equal(row.billSendToSiteEngineerName, "Site Eng");            // 52
    assert.equal(row.billReceivedAtPIMOMumbaiName, "PIMO Clerk");        // 63
    assert.equal(row.billSendToQSCertificationName, "QS Mumbai");        // 65
    assert.equal(row.receivedFromQSWithCOPName, "PIMO Desk");            // 67
    assert.equal(row.givenToITDeptName, "IT Desk");                      // 69
    assert.equal(row.receivedBackFromITDeptName, "PIMO IT");             // 75A
    assert.equal(row.receivedInAccountsDepartmentName, "Accts Clerk");   // 82A
  });

  test("the steps that were wired to the wrong column now read the right one", async () => {
    const row = await journey();

    // "Bill send to QS" read the measurement-CHECK date, not col 35.
    assert.match(row.billSendToQS, /2026/);

    // "Certified by QS" read the date the bill was GIVEN to QS (col 40),
    // where the layout names the COP date (col 42).
    assert.match(row.certifiedByQS, /2026/);
    assert.equal(row.certifiedByQSAmount, 444000); // 43

    // "Received Back from I.T.Dept." read itDept.dateReceived, which the
    // workflow never writes - col 75 lives on pimoMumbai.
    assert.match(row.receivedBackFromITDept, /2026/);

    // "Certified by Trustee" read the date the bill was sent FOR approval,
    // not col 78, the date it came back.
    assert.match(row.certifiedByProjectDirector, /2026/);
  });

  test("MIGO and SES carry their number, amount and done-by", async () => {
    const row = await journey();
    assert.match(row.migoDateNo, /1000056752/);  // 47 / 46
    assert.equal(row.migoDoneBy, "Vaishali");    // 49
    assert.equal(row.migoAmount, 430000);        // 48
    assert.match(row.sesDateNo, /2000011111/);   // 74 / 72
    assert.equal(row.sesDoneBy, "SES Guy");      // 74A
    assert.equal(row.sesAmount, 420000);         // 73
  });

  test("Received in Accounts is a row of its own", async () => {
    // Column 82 had no row at all; only col 80, the submission, was shown.
    const row = await journey();
    assert.ok(row.receivedInAccountsDepartment, "col 82 must be projected");
    assert.ok(row.submittedToAccountsDepartment, "col 80 stays");
    assert.notEqual(row.receivedInAccountsDepartment, row.submittedToAccountsDepartment);
  });

  test("QS falls back to Prov COP when there is no measurement date", async () => {
    // Her layout reads "Column 35 /Column 40".
    await makeBill({
      srNo: "2627901",
      taxInvNo: "INV-PROVCOP",
      "qsCOP.dateGiven": new Date("2026-07-06"),
      "qsCOP.name": "QS Prov COP",
    });
    const res = await get("/api/reports/bill-journey", "admin");
    const row = rowsOf(res).find((r) => r.srNo === "2627901");
    assert.ok(row);
    assert.equal(row.billSendToQSName, "QS Prov COP"); // col 41
  });
});

/* ================================================================== *
 * Vendor Details report (observation N-08)
 * ================================================================== */
describe("Vendor Details report", () => {
  const vendorReport = (role, query = {}) =>
    request(app)
      .get("/api/reports/vendor-details")
      .query(query)
      .set("Authorization", `Bearer ${tokenFor(fixtures.users[role])}`);

  test("every team can reach it", async () => {
    // "This report should be available in all teams".
    for (const role of ["site_officer", "qs_site", "site_pimo", "accounts", "director", "admin"]) {
      const res = await vendorReport(role);
      assert.equal(res.status, 200, role);
    }
  });

  test("an anonymous caller cannot", async () => {
    const res = await request(app).get("/api/reports/vendor-details");
    assert.equal(res.status, 401);
  });

  test("it lists the vendor master with its details", async () => {
    const res = await vendorReport("admin");
    const rows = rowsOf(res);
    assert.ok(rows.length >= 1);

    const acme = rows.find((r) => String(r.vendorNo) === "123456");
    assert.ok(acme, "the seeded vendor must appear");
    assert.equal(acme.vendorName, "Acme Constructions Pvt Ltd");
    assert.equal(acme.PAN, "AAAPL1234C");
    assert.equal(acme.GSTNumber, "27AAAPL1234C1ZV");
    assert.ok(acme.PANStatus, "PAN status must be resolved to its name");
    assert.ok(acme.complianceStatus, "compliance must be resolved to its name");
  });

  test("email and phone are joined, not rendered as arrays", async () => {
    // The same bracket problem the master download had.
    const res = await vendorReport("admin");
    const acme = rowsOf(res).find((r) => String(r.vendorNo) === "123456");
    assert.equal(typeof acme.emailIds, "string");
    assert.doesNotMatch(acme.emailIds, /[\[\]]/);
  });

  test("rows are numbered and sorted by vendor no", async () => {
    await seed.seedVendor(fixtures, { vendorNo: 111111, vendorName: "Aardvark Ltd", PAN: "AAAPL1111C" });
    await seed.seedVendor(fixtures, { vendorNo: 999999, vendorName: "Zebra Ltd", PAN: "AAAPL9999C" });

    const rows = rowsOf(await vendorReport("admin"));
    const nos = rows.map((r) => Number(r.vendorNo));
    assert.deepEqual(nos, [...nos].sort((a, b) => a - b));
    assert.deepEqual(rows.map((r) => r.count), rows.map((_, i) => i + 1));
  });

  test("it can be filtered by vendor name or number", async () => {
    await seed.seedVendor(fixtures, { vendorNo: 222222, vendorName: "Borealis Works", PAN: "AAAPL2222C" });

    const byName = rowsOf(await vendorReport("admin", { vendorName: "borealis" }));
    assert.equal(byName.length, 1);
    assert.equal(byName[0].vendorName, "Borealis Works");

    const byNo = rowsOf(await vendorReport("admin", { vendorName: "222222" }));
    assert.equal(byNo.length, 1);
    assert.equal(String(byNo[0].vendorNo), "222222");
  });
});

/* ================================================================== *
 * 29 September corrections
 * ================================================================== */
describe("Outstanding reports key on the date Accounts received the bill", () => {
  // observation S-25: the window was applied to Tax Inv Date.
  const outstanding = (query) =>
    get("/api/reports/outstanding-bills", "accounts", query);

  const outstandingBill = (fields) =>
    makeBill({
      siteStatus: "accept",
      "accountsDept.dateReceived": new Date("2026-08-15"), // col 82
      ...fields,
    });

  test("a bill received inside the window is included", async () => {
    const b = await outstandingBill({ taxInvNo: "OS-IN", taxInvDate: new Date("2020-01-01") });
    const res = await outstanding({ startDate: "2026-08-01", endDate: "2026-08-31" });
    assert.ok(rowsOf(res).some((r) => r.srNo === b.srNo),
      "an old invoice date must not exclude it");
  });

  test("a bill received outside the window is excluded", async () => {
    const b = await outstandingBill({
      taxInvNo: "OS-OUT",
      taxInvDate: new Date("2026-08-15"),
      "accountsDept.dateReceived": new Date("2026-05-01"),
    });
    const res = await outstanding({ startDate: "2026-08-01", endDate: "2026-08-31" });
    assert.ok(!rowsOf(res).some((r) => r.srNo === b.srNo),
      "a matching invoice date must not include it");
  });
});

describe("Invoices with QS Mumbai for COP returns rows at all", () => {
  test("an accepted bill with QS Mumbai appears", async () => {
    // observation S-31: the report required Status at Site "hold", which a
    // bill at QS Mumbai can never have.
    const b = await makeBill({
      taxInvNo: "QSM-1",
      siteStatus: "accept",
      "qsMumbai.dateGiven": new Date("2026-08-01"),   // col 64
    });
    const res = await get("/api/reports/invoices-received-at-qsmumbai", "qs_site");
    assert.equal(res.status, 200);
    assert.deepEqual(rowsOf(res).map((r) => r.srNo), [b.srNo]);
  });

  test("one already returned to PIMO does not", async () => {
    await makeBill({
      taxInvNo: "QSM-2",
      siteStatus: "accept",
      "qsMumbai.dateGiven": new Date("2026-08-01"),
      "pimoMumbai.dateReturnedFromQs": new Date("2026-08-05"), // col 66
    });
    const res = await get("/api/reports/invoices-received-at-qsmumbai", "qs_site");
    assert.deepEqual(rowsOf(res), []);
  });
});

describe("Bill Journey: the submission row takes column 81", () => {
  test("Submitted to Accounts shows col 81, Received shows col 82A", async () => {
    // R-04, confirmed by the client on 26 September.
    await makeBill({
      srNo: "2627950",
      taxInvNo: "BJ-81",
      "accountsDept.dateGiven": new Date("2026-08-20"),
      "accountsDept.givenBy": "PIMO Desk",      // col 81
      "accountsDept.dateReceived": new Date("2026-08-22"),
      "accountsDept.receivedBy": "Accts Clerk", // col 82A
    });
    const res = await get("/api/reports/bill-journey", "admin");
    const row = rowsOf(res).find((r) => r.srNo === "2627950");
    assert.ok(row);
    assert.equal(row.submittedToAccountsDepartmentName, "PIMO Desk");
    assert.equal(row.receivedInAccountsDepartmentName, "Accts Clerk");
  });
});

/* ================================================================== *
 * Mail of 1 October
 * ================================================================== */
describe("Bill Kidhar and Bill Journey key on column 24 (1.10, item O-02)", () => {
  const PATHS = [
    ["/api/reports/bill-kidhar", "admin"],
    ["/api/reports/bill-journey", "admin"],
  ];

  for (const [path, role] of PATHS) {
    const name = path.replace("/api/reports/", "");

    test(`${name}: the date range applies to Dt recd at Site, not Tax Inv Date`, async () => {
      // Invoice dated inside the window but received at site after it.
      await makeBill({
        srNo: "2627801",
        taxInvDate: new Date("2026-07-05"),
        taxInvRecdAtSite: new Date("2026-08-20"),
      });
      // Invoice dated before the window but received at site inside it.
      await makeBill({
        srNo: "2627802",
        taxInvDate: new Date("2026-05-01"),
        taxInvRecdAtSite: new Date("2026-07-10"),
      });
      const res = await get(path, role, { startDate: "2026-07-01", endDate: "2026-07-31" });
      assert.equal(res.status, 200, res.text?.slice(0, 200));
      assert.deepEqual(rowsOf(res).map((r) => r.srNo), ["2627802"]);
    });

    test(`${name}: with no dates the window is 01-04-2020 to today`, async () => {
      await makeBill({ srNo: "2627811", taxInvDate: new Date("2020-03-01"), taxInvRecdAtSite: new Date("2020-04-02") });
      await makeBill({ srNo: "2627812", taxInvDate: new Date("2020-03-01"), taxInvRecdAtSite: new Date("2020-03-20") });
      const res = await get(path, role);
      const srNos = rowsOf(res).map((r) => r.srNo);
      assert.ok(srNos.includes("2627811"), "received on 02-04-2020 is inside the default window");
      assert.ok(!srNos.includes("2627812"), "received before 01-04-2020 is outside it");
    });

    test(`${name}: sorted by Dt recd at Site descending, then Sr no descending`, async () => {
      const shared = new Date("2026-08-01");
      await makeBill({ srNo: "2627821", taxInvRecdAtSite: shared, taxInvAmt: 900000 });
      await makeBill({ srNo: "2627823", taxInvRecdAtSite: shared, taxInvAmt: 100 });
      await makeBill({ srNo: "2627822", taxInvRecdAtSite: new Date("2026-08-15"), taxInvAmt: 50 });
      await makeBill({
        srNo: "2627824",
        taxInvRecdAtSite: new Date("2026-07-15"),
        "accountsDept.paymentDate": new Date("2026-08-30"),
      });
      const res = await get(path, role);
      assert.deepEqual(
        rowsOf(res).map((r) => r.srNo),
        ["2627822", "2627823", "2627821", "2627824"]
      );
    });
  }
});

describe("reports carry Nature of Work for the global filter (1.10, item O-19)", () => {
  const CASES = [
    ["/api/reports/invoices-received-at-site", "site_officer", {}],
    ["/api/reports/invoices-courier-to-pimo-mumbai", "site_officer", { "pimoMumbai.dateGiven": new Date("2026-07-10") }],
    ["/api/reports/outstanding-bills", "accounts", { siteStatus: "accept", "accountsDept.dateReceived": new Date("2026-07-25") }],
    ["/api/reports/invoices-paid", "accounts", {
      siteStatus: "accept",
      "accountsDept.dateReceived": new Date("2026-07-25"),
      "accountsDept.paymentDate": new Date("2026-08-01"),
    }],
    ["/api/reports/bill-kidhar", "admin", {}],
    ["/api/reports/bill-journey", "admin", {}],
  ];

  for (const [path, role, fields] of CASES) {
    test(`${path.replace("/api/reports/", "")} projects natureOfWork by name`, async () => {
      await makeBill(fields);
      const res = await get(path, role);
      assert.equal(res.status, 200, res.text?.slice(0, 200));
      const rows = rowsOf(res);
      assert.ok(rows.length >= 1, "no rows returned");
      assert.equal(rows[0].natureOfWork, fixtures.natures[0].natureOfWork);
    });
  }
});
