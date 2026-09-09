/**
 * BLOCK: masters, imports and the duplicate-bill rule
 *
 * The Round 2 backlog. Three groups:
 *
 *   - the duplicate-bill rule, restated from the observations workbook
 *     (General R14) and now shared by createBill and patchBill;
 *   - master data: sort order, region rename cascade, and the fact that
 *     /master/* had no authentication at all;
 *   - vendor import validation (Imports R49-R51, Masters R55-R58).
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { startDb, stopDb, clearDb } from "../helpers/db.js";

let app, seed, tokenFor, billPayload, fixtures, Bill, User, RegionMaster;

before(async () => {
  await startDb();
  ({ buildApp: app } = await import("../helpers/app.js"));
  seed = await import("../helpers/seed.js");
  ({ tokenFor, billPayload } = seed);
  ({ default: Bill } = await import("../../models/bill-model.js"));
  ({ default: User } = await import("../../models/user-model.js"));
  ({ default: RegionMaster } = await import("../../models/region-master-model.js"));
  app = app();
});

after(async () => await stopDb());

beforeEach(async () => {
  await clearDb();
  fixtures = await seed.seedAll();
});

const createBill = (overrides = {}, role = "site_officer") =>
  request(app)
    .post("/bill")
    .set("Authorization", `Bearer ${tokenFor(fixtures.users[role])}`)
    .send(billPayload(overrides));

/* ================================================================== *
 * The duplicate-bill rule
 *
 * "A bill details with combination of 'Vendor+Bill no+Bill date+Bill Amt'
 *  should give error. However this applies when only bill no column for same
 *  vendor is blank. Then this not allows to edit any detail.
 *  Exception - Advance/LC/BG, Hold/Ret Release, Petty Cash, Direct FI Entry,
 *  Proforma Invoice"
 * ================================================================== */
describe("duplicate bill: vendor + bill no + bill date + bill amount", () => {
  const BILL = {
    taxInvNo: "INV-DUP-1",
    taxInvDate: "2026-08-01",
    taxInvAmt: 250000,
  };

  test("the same four values twice is refused", async () => {
    const first = await createBill(BILL);
    assert.equal(first.status, 201);

    const second = await createBill(BILL);
    assert.equal(second.status, 400);
    assert.match(second.body.message, /already exists/i);
  });

  test("a different AMOUNT is not a duplicate", async () => {
    // The old key was vendor + bill no + date + REGION, so a second bill for
    // the same invoice number at a different amount was wrongly refused - and
    // the amount, which the rule does name, was never compared at all.
    await createBill(BILL);
    const other = await createBill({ ...BILL, taxInvAmt: 999 });
    assert.equal(other.status, 201);
  });

  test("a different REGION is still a duplicate", async () => {
    // Region is not part of the client's key. Two identical bills in two
    // regions used to be allowed.
    const u = await User.create({
      name: "Indore site",
      email: "indore@test.example",
      password: "password123",
      role: ["site_officer"],
      department: ["Site"],
      region: ["INDORE"],
    });
    await createBill(BILL);

    const other = await request(app)
      .post("/bill")
      .set("Authorization", `Bearer ${tokenFor(u)}`)
      .send(billPayload({ ...BILL, region: "INDORE" }));

    assert.equal(other.status, 400);
  });

  test("a blank bill no is never a duplicate, however many there are", async () => {
    // The rule's own carve-out. Two bills for one vendor with no bill number
    // yet matched each other on null === null.
    const a = await createBill({ ...BILL, taxInvNo: "" });
    const b = await createBill({ ...BILL, taxInvNo: "" });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
  });

  for (const nature of [
    "Advance/LC/BG",
    "Hold/Ret Release",
    "Petty cash",
    "Direct FI Entry",
    "Proforma Invoice",
  ]) {
    test(`${nature} is exempt`, async () => {
      const a = await createBill({ ...BILL, natureOfWork: nature });
      const b = await createBill({ ...BILL, natureOfWork: nature });
      assert.equal(a.status, 201, `first ${nature} bill`);
      assert.equal(b.status, 201, `second ${nature} bill must be allowed`);
    });
  }

  test("a nature that is NOT exempt is still checked", async () => {
    await createBill({ ...BILL, natureOfWork: "Materials" });
    const b = await createBill({ ...BILL, natureOfWork: "Materials" });
    assert.equal(b.status, 400);
  });
});

/* ================================================================== *
 * The pencil edit the rule used to block
 * ================================================================== */
describe("pencil edit is not blocked by the duplicate check", () => {
  const patch = (id, body, role = "site_officer") =>
    request(app)
      .patch(`/bill/${id}`)
      .set("Authorization", `Bearer ${tokenFor(fixtures.users[role])}`)
      .send(body);

  test("an Advance row with no bill no can be edited", async () => {
    // observations T-03 and T-06. Two Advance bills for one vendor both had a
    // blank bill number, so each looked like the other's duplicate and the
    // pencil edit refused to save anything at all.
    const a = await createBill({ natureOfWork: "Advance/LC/BG", taxInvNo: "" });
    await createBill({ natureOfWork: "Advance/LC/BG", taxInvNo: "" });
    assert.equal(a.status, 201);

    const res = await patch(a.body._id ?? a.body.bill?._id, { poNo: "1234567890" });
    assert.equal(res.status, 200, res.body.message);
  });

  test("a Direct FI row with no bill no can be edited", async () => {
    const a = await createBill({ natureOfWork: "Direct FI Entry", taxInvNo: "" });
    await createBill({ natureOfWork: "Direct FI Entry", taxInvNo: "" });

    const res = await patch(a.body._id ?? a.body.bill?._id, { poNo: "1234567890" });
    assert.equal(res.status, 200, res.body.message);
  });

  test("a Hold/Ret Release row with no bill no can be edited", async () => {
    const a = await createBill({ natureOfWork: "Hold/Ret Release", taxInvNo: "" });
    await createBill({ natureOfWork: "Hold/Ret Release", taxInvNo: "" });

    const res = await patch(a.body._id ?? a.body.bill?._id, { poNo: "1234567890" });
    assert.equal(res.status, 200, res.body.message);
  });

  test("editing a bill into a genuine duplicate is still refused", async () => {
    const a = await createBill({ taxInvNo: "INV-A", taxInvAmt: 100 });
    const b = await createBill({ taxInvNo: "INV-B", taxInvAmt: 100 });

    const res = await patch(b.body._id ?? b.body.bill?._id, { taxInvNo: "INV-A" });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /already exists/i);
  });

  test("a bill is never its own duplicate", async () => {
    const a = await createBill({ taxInvNo: "INV-SELF", taxInvAmt: 100 });
    const res = await patch(a.body._id ?? a.body.bill?._id, { taxInvNo: "INV-SELF" });
    assert.equal(res.status, 200, res.body.message);
  });
});

/* ================================================================== *
 * Master data
 * ================================================================== */
describe("master data", () => {
  const asAdmin = (m, p) =>
    request(app)[m](p).set("Authorization", `Bearer ${tokenFor(fixtures.users.admin)}`);

  test("/master/* refuses an anonymous caller", async () => {
    // These routes were mounted with no authentication whatsoever.
    for (const [m, p] of [
      ["get", "/master/vendors"],
      ["get", "/master/users"],
      ["get", "/master/regions"],
      ["post", "/master/regions"],
    ]) {
      const res = await request(app)[m](p).send({ name: "ATTACKER" });
      assert.equal(res.status, 401, `${m.toUpperCase()} ${p}`);
    }
  });

  test("a signed-in non-admin can still read the dropdowns", async () => {
    const token = tokenFor(fixtures.users.site_officer);
    for (const p of ["/master/currencies", "/master/nature-of-works", "/master/regions"]) {
      const res = await request(app).get(p).set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 200, p);
    }
  });

  test("a non-admin cannot write to a master", async () => {
    const res = await request(app)
      .post("/master/regions")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.site_officer)}`)
      .send({ name: "NAGPUR" });
    assert.equal(res.status, 403);
  });

  test("currencies come back alphabetically", async () => {
    const res = await asAdmin("get", "/master/currencies");
    const names = res.body.map((c) => c.currency);
    assert.deepEqual(names, [...names].sort());
  });

  test("natures of work come back alphabetically", async () => {
    const res = await asAdmin("get", "/master/nature-of-works");
    const names = res.body.map((n) => n.natureOfWork);
    assert.deepEqual(names, [...names].sort());
  });

  test("vendors come back in vendor-no order", async () => {
    await seed.seedVendor(fixtures, { vendorNo: 111111, vendorName: "Aardvark Ltd", PAN: "AAAPL1111C" });
    await seed.seedVendor(fixtures, { vendorNo: 999999, vendorName: "Zebra Ltd", PAN: "AAAPL9999C" });

    const res = await asAdmin("get", "/master/vendors");
    const nos = res.body.map((v) => Number(v.vendorNo));
    assert.deepEqual(nos, [...nos].sort((a, b) => a - b));
  });
});

/* ================================================================== *
 * Renaming a region
 * ================================================================== */
describe("renaming a region carries the new name to the data", () => {
  const renameTo = async (name) => {
    const region = await RegionMaster.findOne({ name: "MUMBAI" });
    return request(app)
      .put(`/master/regions/${region._id}`)
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.admin)}`)
      .send({ name });
  };

  test("bills follow the rename", async () => {
    // Bill.region holds the NAME, and validates it against RegionMaster. A
    // rename left every bill pointing at a region that no longer existed
    // (observations, Masters R56).
    const bill = await createBill();
    assert.equal(bill.status, 201);

    const res = await renameTo("BOMBAY");
    assert.equal(res.status, 200);
    assert.equal(res.body.billsUpdated, 1);

    const after = await Bill.findOne({}).lean();
    assert.equal(after.region, "BOMBAY");
  });

  test("users follow the rename", async () => {
    const res = await renameTo("BOMBAY");
    assert.equal(res.status, 200);

    const user = await User.findById(fixtures.users.site_officer._id).lean();
    assert.ok(user.region.includes("BOMBAY"));
    assert.ok(!user.region.includes("MUMBAI"));
  });

  test("a bill in the renamed region can still be saved afterwards", async () => {
    // The real damage: the model validates region against the master, so a
    // renamed region made its own bills unsaveable.
    const bill = await createBill();
    await renameTo("BOMBAY");

    const doc = await Bill.findById(bill.body._id ?? bill.body.bill?._id);
    doc.taxInvAmt = 123456;
    await assert.doesNotReject(() => doc.save());
  });

  test("a region still in use cannot be deleted", async () => {
    await createBill();
    const region = await RegionMaster.findOne({ name: "MUMBAI" });

    const res = await request(app)
      .delete(`/master/regions/${region._id}`)
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.admin)}`);

    assert.equal(res.status, 409);
    assert.match(res.body.error, /still used by/i);
  });

  test("an unused region can be deleted", async () => {
    const region = await RegionMaster.findOne({ name: "DHULE" });
    const res = await request(app)
      .delete(`/master/regions/${region._id}`)
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.admin)}`);
    assert.equal(res.status, 200);
  });
});

/* ================================================================== *
 * Vendor import validation
 * ================================================================== */
describe("vendor import validation", () => {
  let EMAIL_PATTERN;
  before(async () => {
    ({ EMAIL_PATTERN } = await import("../../utils/vendor-csv-utils.js"));
  });

  test("a real email address is accepted", () => {
    // The check tested /^\d+$/ - the digits-only pattern copied from the phone
    // rule - while reporting "must contain @ and . in emailID". It was exactly
    // inverted (observations, Masters R57).
    for (const ok of ["a@b.com", "accounts@acme.example", "x.y@z.co.in"]) {
      assert.ok(EMAIL_PATTERN.test(ok), ok);
    }
  });

  test("a string of digits is not an email", () => {
    for (const bad of ["12345", "a@b", "no-at-sign.com", "a b@c.com", ""]) {
      assert.ok(!EMAIL_PATTERN.test(bad), bad);
    }
  });

  test("vendor no must be exactly 6 digits", async () => {
    // observations, Imports R51.
    await assert.rejects(
      () => seed.seedVendor(fixtures, { vendorNo: 12345, PAN: "AAAPL5555C" }),
      /6 digits/i
    );
  });
});
