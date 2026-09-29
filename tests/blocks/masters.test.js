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

/* ================================================================== *
 * Payment Status shows "-" until the bill is paid (29.09, item 15)
 *
 * This reverses N-28. The client replaced "default to Unpaid" with "blank
 * until a payment date exists", and removed Unpaid as a value the system
 * writes at all.
 * ================================================================== */
describe("payment status follows the payment date", () => {
  test("a newly created bill has no payment status", async () => {
    const res = await createBill();
    assert.equal(res.status, 201);

    const bill = await Bill.findById(res.body.bill._id).lean();
    assert.ok(!bill.accountsDept?.status, "blank, rendered as '-'");
  });

  test("entering a payment date makes it Paid", async () => {
    const res = await createBill({ taxInvNo: "INV-PAID" });
    const doc = await Bill.findById(res.body.bill._id);
    doc.accountsDept.paymentDate = new Date("2026-09-01");
    await doc.save();

    const after = await Bill.findById(doc._id).lean();
    assert.equal(after.accountsDept.status, "Paid");
  });

  test("clearing the payment date clears the status again", async () => {
    const res = await createBill({ taxInvNo: "INV-CLEAR" });
    const doc = await Bill.findById(res.body.bill._id);
    doc.accountsDept.paymentDate = new Date("2026-09-01");
    await doc.save();

    doc.accountsDept.paymentDate = null;
    await doc.save();

    const after = await Bill.findById(doc._id).lean();
    assert.ok(!after.accountsDept.status, "back to blank, not Unpaid");
  });

  test("the system never writes Unpaid", async () => {
    const res = await createBill({ taxInvNo: "INV-NEVER" });
    const doc = await Bill.findById(res.body.bill._id);
    doc.accountsDept.status = "Unpaid"; // as an older row would have held
    await doc.save();

    const after = await Bill.findById(doc._id).lean();
    assert.notEqual(after.accountsDept.status, "Unpaid", "the hook clears it");
  });

  test("the backfill corrects rows written under the old rule", async () => {
    const { backfillPaymentStatus } = await import("../../utils/backfill-payment-status.js");

    const stale = await createBill({ taxInvNo: "INV-BF-1" });
    const paidNoStatus = await createBill({ taxInvNo: "INV-BF-2" });

    // Written directly, bypassing the hook, exactly as legacy rows are.
    await Bill.updateOne({ _id: stale.body.bill._id },
      { $set: { "accountsDept.status": "Unpaid" } });
    await Bill.updateOne({ _id: paidNoStatus.body.bill._id },
      { $set: { "accountsDept.paymentDate": new Date("2026-09-01"), "accountsDept.status": null } });

    const dry = await backfillPaymentStatus(Bill, { apply: false });
    assert.equal(dry.blank, 2, "both rows disagree with their date");
    assert.equal(dry.written, 0, "a dry run must not write");

    const applied = await backfillPaymentStatus(Bill, { apply: true });
    assert.equal(applied.written, 2);

    assert.ok(!(await Bill.findById(stale.body.bill._id).lean()).accountsDept.status);
    assert.equal((await Bill.findById(paidNoStatus.body.bill._id).lean()).accountsDept.status, "Paid");
    assert.equal((await backfillPaymentStatus(Bill)).blank, 0);
  });
});

/* ================================================================== *
 * Changing your own password (observation N-12)
 *
 * The endpoint existed; nothing in the interface reached it. These pin the
 * behaviour the new profile form depends on.
 * ================================================================== */
describe("a user can change their own password", () => {
  const change = (user, body) =>
    request(app)
      .put("/auth/update-password")
      .set("Authorization", `Bearer ${tokenFor(user)}`)
      .send(body);

  test("the current password must be correct", async () => {
    const res = await change(fixtures.users.site_officer, {
      currentPassword: "not-the-password",
      newPassword: "brand-new-password",
    });
    assert.equal(res.status, 401);
    assert.match(res.body.message, /current password is incorrect/i);
  });

  test("both fields are required", async () => {
    const res = await change(fixtures.users.site_officer, { newPassword: "only-one" });
    assert.equal(res.status, 400);
  });

  test("an anonymous caller is refused", async () => {
    const res = await request(app)
      .put("/auth/update-password")
      .send({ currentPassword: "password123", newPassword: "something-else" });
    assert.equal(res.status, 401);
  });

  test("a correct change works, and the old password stops working", async () => {
    const res = await change(fixtures.users.site_officer, {
      currentPassword: "password123",
      newPassword: "a-much-better-password",
    });
    assert.equal(res.status, 200, res.body.message);
    assert.ok(res.body.token, "a fresh token must come back so the session survives");

    const reloaded = await User.findById(fixtures.users.site_officer._id).select("+password");
    assert.ok(await reloaded.matchPassword("a-much-better-password"));
    assert.ok(!(await reloaded.matchPassword("password123")));
  });

  test("the stored password is hashed, never the plain text", async () => {
    await change(fixtures.users.site_officer, {
      currentPassword: "password123",
      newPassword: "another-good-password",
    });
    const reloaded = await User.findById(fixtures.users.site_officer._id).select("+password");
    assert.notEqual(reloaded.password, "another-good-password");
    assert.match(reloaded.password, /^\$2[aby]\$/, "bcrypt hash");
  });
});

/* ================================================================== *
 * Consolidating the two PIMO roles (reply to question 3, 29.09)
 * ================================================================== */
describe("consolidating pimo_mumbai into site_pimo", () => {
  let consolidatePimoRoles;
  before(async () => {
    ({ consolidatePimoRoles } = await import("../../utils/consolidate-pimo-roles.js"));
  });

  const makeUser = (name, role) =>
    User.create({
      name,
      email: `${name}@test.example`,
      password: "password123",
      role,
      department: ["PIMO"],
      region: ["MUMBAI"],
    });

  test("a dry run reports the plan and writes nothing", async () => {
    await makeUser("both", ["site_pimo", "pimo_mumbai"]);
    await makeUser("droponly", ["pimo_mumbai"]);

    const plan = await consolidatePimoRoles(User, { apply: false });
    // The seed already holds one user of each role.
    assert.equal(plan.both, 1);
    assert.equal(plan.dropOnly, 2);
    assert.equal(plan.written, 0);
    assert.equal(await User.countDocuments({ role: "pimo_mumbai" }), 3, "nothing written");
  });

  test("apply removes pimo_mumbai and grants nothing by default", async () => {
    await makeUser("both", ["site_pimo", "pimo_mumbai"]);
    // Production's pimo_mumbai-only users are Site Officers: they must not
    // silently gain the PIMO login.
    await makeUser("siteofficer", ["site_officer", "pimo_mumbai"]);

    await consolidatePimoRoles(User, { apply: true });

    assert.equal(await User.countDocuments({ role: "pimo_mumbai" }), 0);
    assert.deepEqual((await User.findOne({ name: "both" }).lean()).role, ["site_pimo"]);
    assert.deepEqual((await User.findOne({ name: "siteofficer" }).lean()).role, ["site_officer"]);
  });

  test("with grant, a former holder without site_pimo is given it", async () => {
    await makeUser("mixed", ["pimo_mumbai", "accounts"]);
    await consolidatePimoRoles(User, { apply: true, grant: true });
    assert.deepEqual((await User.findOne({ name: "mixed" }).lean()).role, ["accounts", "site_pimo"]);
    assert.deepEqual(
      (await User.findById(fixtures.users.site_officer._id).lean()).role,
      ["site_officer"],
      "users without pimo_mumbai are untouched"
    );
  });

  test("apply is idempotent", async () => {
    await makeUser("both", ["site_pimo", "pimo_mumbai"]);
    await consolidatePimoRoles(User, { apply: true });
    const again = await consolidatePimoRoles(User, { apply: true });
    assert.equal(again.affected.length, 0);
    assert.equal(again.written, 0);
  });

  test("importing the script opens no database connection of its own", async () => {
    // The in-memory server is the only connection; the module must not have
    // run its command-line entry point on import.
    const mongoose = (await import("mongoose")).default;
    assert.equal(mongoose.connections.filter((c) => c.readyState === 1).length, 1);
  });
});

/* ================================================================== *
 * 8-digit serial numbers (29.09, reply Q1)
 * ================================================================== */
describe("serial numbers are 8 digits: financial year + six-digit sequence", () => {
  let financialYearPrefix;
  before(async () => {
    ({ financialYearPrefix } = await import("../../utils/serial-number.js"));
  });

  const srNoOf = (res) => res.body.bill?.srNo;

  test("a new bill gets an 8-digit serial under its financial year", async () => {
    const res = await createBill({ billDate: "2026-08-01" });
    assert.equal(res.status, 201, res.text?.slice(0, 200));
    assert.equal(srNoOf(res), "26000001");
  });

  test("consecutive bills number consecutively", async () => {
    const a = srNoOf(await createBill({ billDate: "2026-08-01", taxInvNo: "INV000000000001A" }));
    const b = srNoOf(await createBill({ billDate: "2026-08-01", taxInvNo: "INV000000000002A" }));
    assert.equal(a, "26000001");
    assert.equal(b, "26000002");
  });

  test("numbering carries on from a legacy 7-digit serial of the same year", async () => {
    const first = await createBill({ billDate: "2026-08-01", taxInvNo: "INV000000000001A" });
    await Bill.updateOne({ _id: first.body.bill._id }, { $set: { srNo: "2600027" } });
    const next = await createBill({ billDate: "2026-08-01", taxInvNo: "INV000000000002A" });
    assert.equal(srNoOf(next), "26000028");
  });

  test("a sequence past 999 still increments (the old substring(4) bug)", async () => {
    const first = await createBill({ billDate: "2026-08-01", taxInvNo: "INV000000000001A" });
    await Bill.updateOne({ _id: first.body.bill._id }, { $set: { srNo: "26001234" } });
    const next = await createBill({ billDate: "2026-08-01", taxInvNo: "INV000000000002A" });
    assert.equal(srNoOf(next), "26001235");
  });

  test("the financial year runs April to March", () => {
    assert.equal(financialYearPrefix(new Date(2027, 2, 31)), "26");
    assert.equal(financialYearPrefix(new Date(2027, 3, 1)), "27");
    assert.equal(financialYearPrefix(new Date(2000, 0, 15)), "99");
  });

  test("the import generator issues 8-digit serials in sequence", async () => {
    const { serialGenerator, financialYearPrefix: fy } = await import("../../utils/serial-number.js");
    const first = await createBill({ billDate: new Date().toISOString().slice(0, 10) });
    await Bill.updateOne({ _id: first.body.bill._id }, { $set: { srNo: `${fy(new Date())}000041` } });
    const next = await serialGenerator(Bill, new Date());
    assert.equal(next(), `${fy(new Date())}000042`);
    assert.equal(next(), `${fy(new Date())}000043`);
  });

  test("lookup by serial accepts 8 digits", async () => {
    const res = await createBill({ billDate: "2026-08-01" });
    const found = await request(app)
      .get(`/bill/srno/${srNoOf(res)}`)
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.admin)}`);
    assert.equal(found.status, 200, found.text?.slice(0, 200));
  });
});
