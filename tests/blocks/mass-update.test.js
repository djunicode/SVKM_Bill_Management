/**
 * BLOCK: mass update
 *
 * The 21-column template from Format for update bill file.xlsx, uploaded to
 * POST /excel/patch-bills?team=<role>.
 *
 * Written around the client's own reports:
 *   - every row showed "Success" while the header showed "Failed"
 *   - "Dt ret-PIMO aft approval" and "Payment Instructions" never updated
 *   - dates appeared as numbers in the result display
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import ExcelJS from "exceljs";

import { startDb, stopDb, clearDb } from "../helpers/db.js";

let app, seed, fixtures, Bill;

before(async () => {
  await startDb();
  ({ buildApp: app } = await import("../helpers/app.js"));
  seed = await import("../helpers/seed.js");
  ({ default: Bill } = await import("../../models/bill-model.js"));
  app = app();
});

after(async () => await stopDb());

beforeEach(async () => {
  await clearDb();
  fixtures = await seed.seedAll();
});

/** The template's own column order, per the Bills Report sheet. */
const TEMPLATE = [
  "Sr no", "COP Dt", "COP Amt", "MIGO no", "MIGO Dt", "MIGO Amt", "MIGO done by",
  "SES no", "SES Amt", "SES Dt", "SES done by", "Dt ret-PIMO aft approval",
  "Payment Instructions", "F110", "Dt of Payment", "Hard Copy",
  "Accts Identification", "Payment Amt", "MIRO no", "MIRO Dt", "MIRO Amt",
];

/** Build an .xlsx buffer with the given headers and rows. */
const workbook = async (headers, rows) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Bills Report");
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(headers.map((h) => (h in r ? r[h] : null))));
  return Buffer.from(await wb.xlsx.writeBuffer());
};

/** The excel routes now require a token, as every other route does. */
const upload = async (team, headers, rows) =>
  request(app)
    .post("/excel/patch-bills")
    .query({ team })
    .set("Authorization", `Bearer ${seed.tokenFor(fixtures.users[team])}`)
    .attach("file", await workbook(headers, rows), "update.xlsx");

/**
 * Mass update only touches bills sitting on the uploading team's HOME tab -
 * getPatchValidationFilter() adds that filter to the Sr no lookup, which is the
 * client's "bills on Home tab, in respective log-in only" rule, already built.
 * These put a bill where each team can see it.
 *
 * Note pimo_mumbai has no case in that switch and so has no restriction, while
 * site_pimo does. Worth confirming which of the two PIMO roles was intended.
 */
const HOME_TAB = {
  site_officer: { "pimoMumbai.dateReceived": null, siteStatus: "hold", currentCount: 1 },
  qs_site: { "qsInspection.dateGiven": new Date("2026-07-05"), "pimoMumbai.dateReturnedFromQs": null },
  accounts: {
    "accountsDept.dateGiven": new Date("2026-07-20"),
    "accountsDept.paymentDate": null,
    currentCount: 5,
  },
  pimo_mumbai: {},
};

const billFor = (team, fields = {}) => makeBill({ ...HOME_TAB[team], ...fields });

const makeBill = async (fields = {}) =>
  Bill.create({
    srNo: fields.srNo || "2627" + Math.floor(10000 + Math.random() * 89999),
    projectDescription: "Mithibai College - Block A",
    vendor: fixtures.vendor._id,
    poCreated: "No",
    taxInvNo: "INV-" + Math.floor(Math.random() * 1e6),
    taxInvDate: new Date("2026-07-01"),
    taxInvAmt: 100000,
    taxInvRecdAtSite: new Date("2026-07-03"),
    billDate: new Date("2026-07-01"),
    amount: 100000,
    currency: fixtures.currencies[0]._id,
    region: "MUMBAI",
    natureOfWork: fixtures.natures[0]._id,
    siteStatus: "hold",
    ...fields,
  });

/* ------------------------------------------------------------------ *
 * 1. The results contract - one truthful line per uploaded row
 * ------------------------------------------------------------------ */
describe("results contract: every row reports its real outcome", () => {
  test("a good row updates and is not reported as an error", async () => {
    const bill = await billFor("qs_site");
    const res = await upload("qs_site", ["Sr no", "COP Dt", "COP Amt"], [
      { "Sr no": bill.srNo, "COP Dt": new Date("2026-08-01"), "COP Amt": 95000 },
    ]);
    assert.equal(res.status, 200, res.text?.slice(0, 250));
    assert.equal(res.body.data.updated, 1);
    assert.deepEqual(res.body.data.errors, []);

    const after = await Bill.findById(bill._id);
    assert.equal(after.copDetails.amount, 95000);
  });

  /* The renderer keys failures by row number and reads `error`. The server used
   * to send only `skippedDetails` with a machine code in `reason`, so no row was
   * ever marked failed while the header counted the skips - the client's
   * "Success on every line, Failed at the top". */
  test("a bad row comes back as { row, error } with a readable message", async () => {
    await billFor("qs_site");
    const res = await upload("qs_site", ["Sr no", "COP Dt"], [
      { "Sr no": "9999999", "COP Dt": new Date("2026-08-01") },
    ]);
    assert.equal(res.status, 400, "a partial failure is a 400");
    const errors = res.body.data.errors;
    assert.equal(errors.length, 1);
    assert.equal(errors[0].row, 2, "Excel row 2 is the first data row");
    assert.match(errors[0].error, /No bill exists with this Sr no/);
  });

  test("the error count and the row errors agree", async () => {
    const ok = await billFor("qs_site");
    const res = await upload("qs_site", ["Sr no", "COP Amt"], [
      { "Sr no": ok.srNo, "COP Amt": 1000 },
      { "Sr no": "9999998", "COP Amt": 2000 },
      { "Sr no": "9999997", "COP Amt": 3000 },
    ]);
    const { updated, skipped, errors } = res.body.data;
    assert.equal(updated, 1);
    assert.equal(skipped, 2);
    assert.equal(
      errors.length,
      skipped,
      "the header count and the per-row list must never disagree"
    );
  });

  test("a blank Sr no is named as the problem", async () => {
    const res = await upload("qs_site", ["Sr no", "COP Amt"], [{ "COP Amt": 500 }]);
    assert.match(res.body.data.errors[0].error, /Sr no is blank/);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Headers - nothing is discarded in silence
 * ------------------------------------------------------------------ */
describe("column headings", () => {
  test("every column in the client template is recognised", async () => {
    const bill = await billFor("accounts");
    const res = await upload("accounts", TEMPLATE, [{ "Sr no": bill.srNo, F110: "F-001" }]);
    assert.deepEqual(
      res.body.data.unknownHeaders,
      [],
      "no column of the supplied template may be unrecognised"
    );
  });

  test("an unrecognised heading is reported, not dropped", async () => {
    const bill = await billFor("accounts");
    const res = await upload("accounts", ["Sr no", "Some Invented Column"], [
      { "Sr no": bill.srNo, "Some Invented Column": "x" },
    ]);
    assert.deepEqual(res.body.data.unknownHeaders, ["Some Invented Column"]);
  });

  test("headings match despite case and spacing drift", async () => {
    const bill = await billFor("accounts");
    const res = await upload("accounts", ["  sr no  ", "payment  instructions"], [
      { "  sr no  ": bill.srNo, "payment  instructions": "Pay by RTGS" },
    ]);
    assert.equal(res.status, 200, res.text?.slice(0, 250));
    const after = await Bill.findById(bill._id);
    assert.equal(after.accountsDept.paymentInstructions, "Pay by RTGS");
  });
});

/* ------------------------------------------------------------------ *
 * 3. The two columns the client reported as never updating
 * ------------------------------------------------------------------ */
describe("previously unmapped template columns", () => {
  test('"Dt ret-PIMO aft approval" updates from the PIMO team (col 78)', async () => {
    const bill = await billFor("pimo_mumbai");
    const res = await upload("pimo_mumbai", ["Sr no", "Dt ret-PIMO aft approval"], [
      { "Sr no": bill.srNo, "Dt ret-PIMO aft approval": new Date("2026-08-05") },
    ]);
    assert.equal(res.status, 200, res.text?.slice(0, 250));

    const after = await Bill.findById(bill._id);
    assert.ok(
      after.pimoMumbai.dateReturnedFromDirector,
      "col 78 was silently discarded because the template wording was unmapped"
    );
  });

  test('"Payment Instructions" updates from Accounts (col 86)', async () => {
    const bill = await billFor("accounts");
    const res = await upload("accounts", ["Sr no", "Payment Instructions"], [
      { "Sr no": bill.srNo, "Payment Instructions": "Hold until COP received" },
    ]);
    assert.equal(res.status, 200, res.text?.slice(0, 250));

    const after = await Bill.findById(bill._id);
    assert.equal(after.accountsDept.paymentInstructions, "Hold until COP received");
  });

  test("F110 updates from Accounts (col 88)", async () => {
    const bill = await billFor("accounts");
    const res = await upload("accounts", ["Sr no", "F110"], [
      { "Sr no": bill.srNo, F110: "F110-2026-0042" },
    ]);
    assert.equal(res.status, 200, res.text?.slice(0, 250));
    const after = await Bill.findById(bill._id);
    assert.equal(after.accountsDept.f110Identification, "F110-2026-0042");
  });

  test('"MIGO done by" updates from the Site team (col 49)', async () => {
    const bill = await billFor("site_officer");
    const res = await upload("site_officer", ["Sr no", "MIGO done by"], [
      { "Sr no": bill.srNo, "MIGO done by": "R. Bhatt" },
    ]);
    assert.equal(res.status, 200, res.text?.slice(0, 250));
    const after = await Bill.findById(bill._id);
    assert.equal(after.migoDetails.doneBy, "R. Bhatt");
  });
});

/* ------------------------------------------------------------------ *
 * 4. Team field restrictions - constants/teamFieldAccess.js
 * ------------------------------------------------------------------ */
describe("a team may only update its own columns", () => {
  test("QS may write COP but not payment", async () => {
    const bill = await billFor("qs_site");
    await upload("qs_site", ["Sr no", "COP Amt", "Payment Amt"], [
      { "Sr no": bill.srNo, "COP Amt": 88000, "Payment Amt": 77000 },
    ]);
    const after = await Bill.findById(bill._id);
    assert.equal(after.copDetails.amount, 88000, "COP belongs to QS");
    assert.notEqual(after.accountsDept.paymentAmt, 77000, "payment does not");
  });

  test("Accounts may write payment but not COP", async () => {
    const bill = await billFor("accounts");
    await upload("accounts", ["Sr no", "COP Amt", "Payment Amt"], [
      { "Sr no": bill.srNo, "COP Amt": 88000, "Payment Amt": 77000 },
    ]);
    const after = await Bill.findById(bill._id);
    assert.equal(after.accountsDept.paymentAmt, 77000);
    assert.notEqual(after.copDetails.amount, 88000);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Dates
 * ------------------------------------------------------------------ */
describe("dates survive the round trip", () => {
  test("a date cell is stored as a date, not a serial number", async () => {
    const bill = await billFor("qs_site");
    await upload("qs_site", ["Sr no", "COP Dt"], [
      { "Sr no": bill.srNo, "COP Dt": new Date("2026-08-14") },
    ]);
    const after = await Bill.findById(bill._id);
    assert.ok(after.copDetails.date instanceof Date);
    assert.equal(after.copDetails.date.toISOString().slice(0, 10), "2026-08-14");
  });
});

/* ------------------------------------------------------------------ *
 * 6. These endpoints mass-update live data and must be authenticated
 * ------------------------------------------------------------------ */
describe("upload endpoints require a token", () => {
  const ENDPOINTS = [
    "/excel/patch-bills",
    "/excel/import-report",
    "/excel/import-vendors",
    "/excel/update-vendor",
  ];

  for (const path of ENDPOINTS) {
    test(`${path} refuses an unauthenticated caller`, async () => {
      const res = await request(app)
        .post(path)
        .attach("file", await workbook(["Sr no"], [{ "Sr no": "1" }]), "u.xlsx");
      assert.equal(res.status, 401, "an upload that rewrites bills cannot be open");
    });
  }

  test("an invalid token is refused", async () => {
    const res = await request(app)
      .post("/excel/patch-bills")
      .set("Authorization", "Bearer not-a-real-token")
      .attach("file", await workbook(["Sr no"], [{ "Sr no": "1" }]), "u.xlsx");
    assert.equal(res.status, 401);
  });
});
