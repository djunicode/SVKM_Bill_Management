/**
 * BLOCK: field formats
 *
 * The formats declared in the "Field entry" sheet, enforced at the model so
 * that create, import, mass update and pencil edit all obey them.
 *
 * Every validator is sparse - a blank value passes - because most of these
 * columns are legitimately empty for much of a bill's life, and existing
 * production rows must stay saveable.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { startDb, stopDb, clearDb } from "../helpers/db.js";

let app, seed, billPayload, tokenFor, fixtures, VendorMaster;
let SITE_STATUS, SITE_STATUS_LABELS;

before(async () => {
  await startDb();
  ({ buildApp: app } = await import("../helpers/app.js"));
  seed = await import("../helpers/seed.js");
  ({ billPayload, tokenFor } = seed);
  ({ default: VendorMaster } = await import("../../models/vendor-master-model.js"));
  ({ SITE_STATUS, SITE_STATUS_LABELS } = await import("../../constants/fieldFormats.js"));
  app = app();
});

after(async () => await stopDb());

beforeEach(async () => {
  await clearDb();
  fixtures = await seed.seedAll();
});

const post = (overrides = {}, role = "site_officer") =>
  request(app)
    .post("/bill")
    .set("Authorization", `Bearer ${tokenFor(fixtures.users[role])}`)
    .send(billPayload(overrides));

describe("col 12 - PO no is numeric, 10 digits", () => {
  test("accepts a 10-digit number", async () => {
    const res = await post({ poNo: "4500012345", taxInvNo: "PO-OK" });
    assert.equal(res.status, 201, res.text?.slice(0, 200));
  });
  test("rejects fewer than 10 digits", async () => {
    const res = await post({ poNo: "45000", taxInvNo: "PO-SHORT" });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /PO no must be exactly 10 digits/);
  });
  test("rejects non-numeric", async () => {
    const res = await post({ poNo: "PO45000123", taxInvNo: "PO-ALPHA" });
    assert.equal(res.status, 400);
  });
  test("accepts blank - most bills have no PO", async () => {
    const res = await post({ poNo: "", taxInvNo: "PO-BLANK" });
    assert.equal(res.status, 201, res.text?.slice(0, 200));
  });
});

describe("col 20 - Tax Inv no is at most 16 characters", () => {
  test("accepts exactly 16", async () => {
    const res = await post({ taxInvNo: "1234567890123456" });
    assert.equal(res.status, 201, res.text?.slice(0, 200));
  });
  test("rejects 17", async () => {
    const res = await post({ taxInvNo: "12345678901234567" });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /16 characters or fewer/);
  });
});

describe("col 31 - Advance percentage is a % number", () => {
  test("accepts 0 and 100", async () => {
    assert.equal((await post({ advancePercentage: 0, taxInvNo: "P0" })).status, 201);
    assert.equal((await post({ advancePercentage: 100, taxInvNo: "P100" })).status, 201);
  });
  test("rejects above 100", async () => {
    const res = await post({ advancePercentage: 150, taxInvNo: "P150" });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /between 0 and 100/);
  });
  test("rejects negative", async () => {
    const res = await post({ advancePercentage: -5, taxInvNo: "PNEG" });
    assert.equal(res.status, 400);
  });
});

describe("cols 46 and 72 - MIGO and SES numbers are 10 digits, as per SAP", () => {
  /**
   * Tested against the model rather than POST /bill. createBill iterates
   * Bill.schema.paths and reads req.body[path], so nested values only reach the
   * document when the client sends the DOTTED key ("migoDetails.no"). A nested
   * object body is silently dropped. These columns are written by mass update
   * and pencil edit in practice, both of which go through the model.
   */
  const base = () => ({
    srNo: "2627" + String(Date.now()).slice(-5),
    projectDescription: "Test",
    vendor: fixtures.vendor._id,
    poCreated: "No",
    taxInvRecdAtSite: new Date(),
    siteStatus: "hold",
    billDate: new Date(),
    amount: 1000,
    currency: fixtures.currencies[0]._id,
    region: "MUMBAI",
    natureOfWork: fixtures.natures[0]._id,
  });

  let Bill;
  before(async () => ({ default: Bill } = await import("../../models/bill-model.js")));

  test("accepts a 10-digit MIGO no", async () => {
    const b = await Bill.create({ ...base(), migoDetails: { no: "5000012345" } });
    assert.equal(b.migoDetails.no, "5000012345");
  });

  test("rejects a short MIGO no", async () => {
    await assert.rejects(
      () => Bill.create({ ...base(), migoDetails: { no: "500" } }),
      /MIGO no must be exactly 10 digits/
    );
  });

  test("rejects a short SES no", async () => {
    await assert.rejects(
      () => Bill.create({ ...base(), sesDetails: { no: "12" } }),
      /SES no must be exactly 10 digits/
    );
  });

  test("accepts a blank MIGO no - unset for most of a bill's life", async () => {
    const b = await Bill.create({ ...base(), migoDetails: { no: "" } });
    assert.ok(b._id);
  });
});

describe("col 6 - Vendor no is numeric, 6 digits", () => {
  test("rejects a 5-digit vendor on create", async () => {
    await assert.rejects(
      () =>
        VendorMaster.create({
          vendorNo: 12345,
          vendorName: "Too Short Ltd",
          complianceStatus: fixtures.compliances[0]._id,
          PANStatus: fixtures.panStatuses[0]._id,
          emailIds: ["a@b.example"],
          phoneNumbers: ["9820000000"],
        }),
      /Vendor no must be exactly 6 digits/
    );
  });

  test("accepts a 6-digit vendor", async () => {
    const v = await VendorMaster.create({
      vendorNo: 654321,
      vendorName: "Correct Length Ltd",
      complianceStatus: fixtures.compliances[0]._id,
      PANStatus: fixtures.panStatuses[0]._id,
      emailIds: ["a@b.example"],
      phoneNumbers: ["9820000000"],
    });
    assert.equal(v.vendorNo, 654321);
  });
});

describe("col 60 - Status at Site follows the Logic sheet", () => {
  test("the four Logic-sheet values are the enum", () => {
    assert.deepEqual([...SITE_STATUS].sort(), ["accept", "hold", "proforma", "reject"]);
  });

  test('"Issue" from the Field entry sheet is not a value', () => {
    assert.ok(!SITE_STATUS.includes("issue"), "Field entry lists Issue; the Logic sheet governs");
  });

  test("each value has the label the client expects on screen", () => {
    assert.equal(SITE_STATUS_LABELS.hold, "Hold");
    assert.equal(SITE_STATUS_LABELS.accept, "Accept");
    assert.equal(SITE_STATUS_LABELS.reject, "Reject Invoice");
    assert.equal(SITE_STATUS_LABELS.proforma, "Proforma Invoice");
  });

  test('a new bill is created as "Hold", whatever the client sends', async () => {
    // Logic sheet, rule 6: "When we create new bill, status will be Hold".
    // createBill overrides siteStatus, so a bad value from the client cannot
    // reach the enum - the default is what protects col 60 on this path.
    const res = await post({ siteStatus: "issue", taxInvNo: "ST-BAD" });
    assert.equal(res.status, 201, res.text?.slice(0, 200));
    assert.equal(res.body.bill.siteStatus, "hold");
  });

  test("the enum still refuses an out-of-range status written directly", async () => {
    const { default: Bill } = await import("../../models/bill-model.js");
    const created = await post({ taxInvNo: "ST-ENUM" });
    assert.equal(created.status, 201, created.text?.slice(0, 200));

    const doc = await Bill.findById(created.body.bill._id);
    doc.siteStatus = "issue"; // the Field entry sheet's outlier value
    await assert.rejects(() => doc.save(), /siteStatus/);
  });
});
