/**
 * BLOCK: checklists
 *
 * Covers the data contract the four printable checklists render from.
 *
 *   Accounts Checklist        - on "Mark as received" in Accounts
 *   Advance / LC / BG         - when Nature of Work is Advance/LC/BG
 *   Bill Journey Checklist    - on saving an ordinary Create Bill
 *   Direct FI entry Checklist - when Nature of Work is Direct FI Entry
 *
 * Field mapping is taken from Checklist.xlsx ("... with column" sheets) and the
 * "Bill Journey Report" sheet of Updated Process Flow & details.xlsx, where every
 * blank on the printed form is annotated with the column number that fills it.
 *
 * The "immediate printout" path renders from the POST /bill response, not from
 * the dashboard list, so that response is what these tests pin down.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { startDb, stopDb, clearDb } from "../helpers/db.js";

let app, seed, billPayload, tokenFor, fixtures;

before(async () => {
  await startDb();
  // Imported only after the in-memory URI is in place.
  ({ buildApp: app } = await import("../helpers/app.js"));
  seed = await import("../helpers/seed.js");
  ({ billPayload, tokenFor } = seed);
  app = app();
});

after(async () => {
  await stopDb();
});

beforeEach(async () => {
  await clearDb();
  fixtures = await seed.seedAll();
});

const createBill = async (overrides = {}, role = "site_officer") => {
  const token = tokenFor(fixtures.users[role]);
  return request(app)
    .post("/bill")
    .set("Authorization", `Bearer ${token}`)
    .send(billPayload(overrides));
};

/* ------------------------------------------------------------------ *
 * 1. The response the immediate printout renders from
 * ------------------------------------------------------------------ */
describe("create-bill response: the payload checklists print from", () => {
  test("a bill can be created and returns 201", async () => {
    const res = await createBill();
    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${res.text?.slice(0, 300)}`);
    assert.equal(res.body.success, true);
    assert.ok(res.body.bill, "response should carry a `bill`");
  });

  test("reference fields are resolved, not bare ObjectIds", async () => {
    const { body } = await createBill();
    const bill = body.bill;
    // currency (col 22) and natureOfWork (col 3) resolve to their names, as they
    // already do on the dashboard list endpoints.
    assert.equal(bill.currency, "INR");
    assert.equal(bill.natureOfWork, "Materials");
    // vendor stays nested as well, so clients reading bill.vendor.* still work.
    assert.equal(typeof bill.vendor, "object", "nested vendor is retained");
    assert.equal(bill.vendor.vendorName, "Acme Constructions Pvt Ltd");
    assert.equal(bill.vendor.vendorNo, 123456);
  });

  test("vendor sub-references (PAN status, 206AB compliance) are populated", async () => {
    const { body } = await createBill();
    const v = body.bill.vendor;
    assert.equal(typeof v.PANStatus, "object", "PANStatus must be populated (col 10)");
    assert.equal(typeof v.complianceStatus, "object", "complianceStatus must be populated (col 9)");
    assert.equal(v.PANStatus.name, "PAN OPERATIVE");
    assert.equal(v.complianceStatus.compliance206AB, "206AB check passed");
  });

  /* ---- C-01 / C-02 -------------------------------------------------
   * The dashboard list endpoints flatten vendor onto the bill
   * (billObj.vendorNo / vendorName / gstNumber / panStatus) and delete the
   * nested object. createBill does not. ChecklistDirectFI2 and
   * ChecklistBillJourney read only the flat fields, so the immediate printout
   * renders blank vendor details, while AdvancedChecklist2 - which falls back
   * to item?.vendor?.vendorNo - renders correctly.
   *
   * These assert the contract the checklists need. They fail until the
   * response is flattened (or the two components gain the same fallback).
   * ------------------------------------------------------------------ */
  describe("C-01 / C-02: vendor details on the immediate printout", () => {
    test("bill.vendorNo is readable at the top level (col 6)", async () => {
      const { body } = await createBill();
      assert.equal(
        body.bill.vendorNo,
        123456,
        "ChecklistDirectFI2 and ChecklistBillJourney read item?.vendorNo"
      );
    });

    test("bill.vendorName is readable at the top level (col 7)", async () => {
      const { body } = await createBill();
      assert.equal(
        body.bill.vendorName,
        "Acme Constructions Pvt Ltd",
        "ChecklistDirectFI2 and ChecklistBillJourney read item?.vendorName"
      );
    });

    test("bill.gstNumber is readable at the top level (col 8)", async () => {
      const { body } = await createBill();
      assert.equal(body.bill.gstNumber, "27AAAPL1234C1ZV");
    });

    test("bill.panStatus and compliance206AB are readable at the top level (cols 9, 10)", async () => {
      const { body } = await createBill();
      assert.equal(body.bill.panStatus, "PAN OPERATIVE");
      assert.equal(body.bill.compliance206AB, "206AB check passed");
    });
  });
});

/* ------------------------------------------------------------------ *
 * 2. Bill Journey checklist - every column the printed form needs
 * ------------------------------------------------------------------ */
describe("Bill Journey checklist: field availability", () => {
  // Header block of the printed form, per the "Bill Journey Report" sheet.
  const HEADER = [
    ["srNo", 1],
    ["natureOfWork", 3],
    ["region", 4],
    ["projectDescription", 5],
    ["taxInvNo", 20],
    ["taxInvDate", 21],
    ["taxInvAmt", 23],
    ["proformaInvNo", 15],
    ["proformaInvDate", 16],
    ["proformaInvAmt", 17],
    ["poNo", 12],
    ["poDate", 13],
    ["poAmt", 14],
  ];

  // Journey rows: each is a date the form prints against a description.
  const JOURNEY = [
    ["taxInvRecdAtSite", 24, "Bill Received at Site"],
    ["taxInvRecdBy", 25, "Bill Received at Site - name"],
    ["qualityEngineer.dateGiven", 33, "Bill send for Quality Certification"],
    ["qsInspection.dateGiven", 35, "Bill send to QS"],
    ["qsCOP.dateGiven", 40, "Bill send to QS (Prov COP)"],
    ["copDetails.date", 42, "Certified by QS"],
    ["copDetails.amount", 43, "COP amount"],
    ["architect.dateGiven", 53, "Certified by Arch/PMC/SVKM"],
    ["siteEngineer.dateGiven", 51, "Bill send to Site Engineer"],
    ["siteIncharge.dateGiven", 55, "Bill send to Site Incharge"],
    ["migoDetails.date", 47, "MIGO date"],
    ["migoDetails.no", 46, "MIGO no"],
    ["migoDetails.amount", 48, "MIGO amount"],
    ["pimoMumbai.dateGiven", 61, "Bill Send to PIMO Mumbai"],
    ["pimoMumbai.dateReceived", 62, "Bill Received at PIMO Mumbai"],
    ["qsMumbai.dateGiven", 64, "Bill Send to QS Certification"],
    ["pimoMumbai.dateReturnedFromQs", 66, "Received from QS With COP"],
    ["itDept.dateGiven", 68, "Given to I.T. Dept."],
    ["pimoMumbai.dateReceivedFromIT", 75, "Received Back from I.T. Dept."],
    ["sesDetails.date", 74, "SES date"],
    ["sesDetails.no", 72, "SES no"],
    ["sesDetails.amount", 73, "SES amount"],
    ["approvalDetails.directorApproval.dateReceived", 78, "Certified by Trustee/Adviser/Director"],
    ["accountsDept.dateGiven", 80, "Submitted to Accounts Department"],
    ["accountsDept.dateReceived", 82, "Received in Accounts Department"],
    ["accountsDept.paymentDate", 89, "Date of Payment"],
    ["accountsDept.paymentAmt", 91, "Payment Amt"],
    ["accountsDept.status", 93, "Payment Status"],
  ];

  const at = (obj, path) =>
    path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

  for (const [path, col] of HEADER) {
    test(`header field \`${path}\` (col ${col}) is present on the bill`, async () => {
      const { body } = await createBill();
      assert.notEqual(
        at(body.bill, path),
        undefined,
        `col ${col} is printed in the Bill Journey header and must exist on the payload`
      );
    });
  }

  for (const [path, col, label] of JOURNEY) {
    test(`journey field \`${path}\` (col ${col}) exists — ${label}`, async () => {
      const { body } = await createBill();
      assert.notEqual(
        at(body.bill, path),
        undefined,
        `col ${col} ("${label}") is a printed row; the key must exist even when empty`
      );
    });
  }
});

/* ------------------------------------------------------------------ *
 * 3. Which checklist opens - Logic sheet rule 2
 * ------------------------------------------------------------------ */
describe("checklist routing: nature of work drives which form prints", () => {
  const cases = [
    ["Advance/LC/BG", "Advance checklist"],
    ["Direct FI Entry", "Direct FI entry checklist"],
    ["Materials", "Bill Journey checklist"],
    ["Service", "Bill Journey checklist"],
  ];

  for (const [nature, expected] of cases) {
    test(`"${nature}" is returned verbatim so the client can route to the ${expected}`, async () => {
      const res = await createBill({ natureOfWork: nature, taxInvNo: `INV-${nature.slice(0, 4)}` });
      assert.equal(res.status, 201, res.text?.slice(0, 200));
      const value =
        typeof res.body.bill.natureOfWork === "object"
          ? res.body.bill.natureOfWork.natureOfWork
          : res.body.bill.natureOfWork;
      assert.equal(
        value,
        nature,
        "FullBill.jsx branches on an exact string match, so any casing or spacing drift breaks routing"
      );
    });
  }

  // C-05: the client reports the checklist not opening for these two.
  test("Advance/LC/BG bills are exempt from the duplicate-bill check", async () => {
    await createBill({ natureOfWork: "Advance/LC/BG", taxInvNo: "DUP-1" });
    const second = await createBill({ natureOfWork: "Advance/LC/BG", taxInvNo: "DUP-1" });
    assert.equal(
      second.status,
      201,
      "Advance/LC/BG is listed as an exemption; a duplicate error here blocks the checklist from opening"
    );
  });

  test("Direct FI Entry bills are exempt from the duplicate-bill check", async () => {
    await createBill({ natureOfWork: "Direct FI Entry", taxInvNo: "DUP-2" });
    const second = await createBill({ natureOfWork: "Direct FI Entry", taxInvNo: "DUP-2" });
    assert.equal(second.status, 201, "Direct FI Entry is listed as an exemption");
  });

  test("an ordinary bill IS rejected as a duplicate", async () => {
    await createBill({ taxInvNo: "DUP-3" });
    const second = await createBill({ taxInvNo: "DUP-3" });
    assert.equal(second.status, 400, "same vendor + tax inv no + date + region must be refused");
  });
});
