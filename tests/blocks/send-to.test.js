/**
 * BLOCK: send-to, remove-date and the pencil edit
 *
 * The send-to chain was the largest untested part of the system: one endpoint,
 * POST /workflow/changeState, dispatching on a from-role x to-role pair through
 * some twenty branches, each writing a different pair of columns.
 *
 * What these cover, from the Field entry register:
 *
 *   - a "Name given-X" column records who the bill went TO;
 *   - a "Name ret-X" / "Name recd-X" column records who returned or received
 *     it, i.e. the person doing the thing;
 *   - columns 32, 49, 63, 67, 74A, 78, 81 and 82A are marked "Auto - User
 *     name" and must come from the signed token, not the request body.
 *
 * Remove-date is the mirror image: it must clear exactly the columns the
 * matching send-to wrote, date and name together.
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
let n = 0;

const makeBill = async (extra = {}) =>
  Bill.create({
    srNo: "26290" + String(++n).padStart(4, "0"),
    projectDescription: "Mithibai College - Block A",
    vendor: fixtures.vendor._id,
    poCreated: "No",
    taxInvNo: "INV-" + n,
    taxInvDate: D("2026-07-01"),
    taxInvAmt: 100000,
    taxInvRecdAtSite: D("2026-07-03"),
    billDate: D("2026-07-01"),
    amount: 100000,
    currency: fixtures.currencies[0]._id,
    region: "MUMBAI",
    natureOfWork: fixtures.natures[0]._id,
    siteStatus: "hold",
    currentCount: 1,
    ...extra,
  });

/**
 * Send a bill on. `asUser` is the seeded user whose TOKEN is used; the body
 * still carries fromUser/toUser the way the dashboard sends them, including a
 * deliberately different name, so the tests can tell which one was written.
 */
const sendTo = (bill, { asUser, fromRole, toRole, toName = "Recipient Typed In Box" }) =>
  request(app)
    .post("/workflow/changeState")
    .set("Authorization", `Bearer ${tokenFor(fixtures.users[asUser])}`)
    .send({
      fromUser: { id: String(fixtures.users[asUser]._id), name: "Cookie Name", role: fromRole },
      toUser: { id: "", name: toName, role: toRole },
      billIds: [String(bill._id)],
      action: "forward",
      remarks: "",
    });

const reload = (bill) => Bill.findById(bill._id).lean();

/** The name on the signed token, which the "Auto - User name" columns must use. */
const actor = (role) => fixtures.users[role].name;

/* ================================================================== *
 * Name columns
 * ================================================================== */
describe("send-to writes the right name in the right column", () => {
  test("col 36 Name-QS Measure records who it was GIVEN to", async () => {
    const bill = await makeBill();
    const res = await sendTo(bill, {
      asUser: "site_officer",
      fromRole: "site_team",
      toRole: "qs_measurement",
      toName: "Ravi QS",
    });
    assert.equal(res.status, 200);

    const after = await reload(bill);
    assert.equal(after.qsInspection.name, "Ravi QS");
    assert.ok(after.qsInspection.dateGiven, "col 35 must be stamped");
  });

  test("col 45A Name given-MIGO records the MIGO team, not the sender", async () => {
    // This wrote fromName, so the column named "Name given-MIGO" held the name
    // of the person who sent the bill rather than the team it went to.
    const bill = await makeBill();
    await sendTo(bill, {
      asUser: "site_officer",
      fromRole: "site_team",
      toRole: "migo_entry",
      toName: "MIGO Desk",
    });

    const after = await reload(bill);
    assert.equal(after.migoDetails.name, "MIGO Desk");
  });

  test("col 39 Name ret-QS aft measure records the QS user returning it", async () => {
    // A return column: it must hold whoever sent the bill back, taken from the
    // token. It used to hold toName, i.e. the recipient.
    const bill = await makeBill({ "qsInspection.dateGiven": D("2026-07-05") });
    await sendTo(bill, {
      asUser: "qs_site",
      fromRole: "qs_team",
      toRole: "measure",
      toName: "Somebody Else",
    });

    const after = await reload(bill);
    assert.equal(after.vendorFinalInv.name, actor("qs_site"));
    assert.notEqual(after.vendorFinalInv.name, "Somebody Else");
  });

  test("col 67 Name ret-PIMO by QS Mumbai comes from the token, not the body", async () => {
    // observations D-07: this column showed sometimes a remark, sometimes a
    // login ID - whatever had been typed into the send-to box.
    const bill = await makeBill({ "qsMumbai.dateGiven": D("2026-07-14") });
    await sendTo(bill, {
      asUser: "qs_site",
      fromRole: "qs_team",
      toRole: "pimo_cop",
      toName: "please check the measurement sheet",
    });

    const after = await reload(bill);
    assert.equal(after.pimoMumbai.nameReturnedFromQs, actor("qs_site"));
    assert.ok(after.pimoMumbai.dateReturnedFromQs, "col 66 must be stamped");
  });

  test("col 76A Name ret-PIMO aft SES comes from the token", async () => {
    // observations D-05.
    const bill = await makeBill({ "sesDetails.dateGiven": D("2026-07-15"), currentCount: 3 });
    await sendTo(bill, {
      asUser: "site_pimo",
      fromRole: "pimo_mumbai",
      toRole: "ses_return_team",
      toName: "1234",
    });

    const after = await reload(bill);
    assert.equal(after.pimoMumbai.nameReturnedFromSES, actor("site_pimo"));
    assert.notEqual(after.pimoMumbai.nameReturnedFromSES, "1234");
  });

  test("col 75A Name ret-IT Dept aft SES comes from the token", async () => {
    const bill = await makeBill({ "itDept.dateGiven": D("2026-07-15"), currentCount: 3 });
    await sendTo(bill, {
      asUser: "site_pimo",
      fromRole: "pimo_mumbai",
      toRole: "it_return_team",
    });

    const after = await reload(bill);
    assert.equal(after.pimoMumbai.nameReceivedFromIT, actor("site_pimo"));
  });

  test("col 44B Name ret-QS aft Prov COP comes from the token", async () => {
    const bill = await makeBill({ "qsCOP.dateGiven": D("2026-07-06") });
    await sendTo(bill, {
      asUser: "qs_site",
      fromRole: "qs_team",
      toRole: "site_cop",
    });

    const after = await reload(bill);
    assert.equal(after.copDetails.nameReturned, actor("qs_site"));
    assert.ok(after.copDetails.dateReturned, "col 44A must be stamped");
  });

  test("col 81 Name given-PIMO to Accts is written at all", async () => {
    // Nothing ever wrote this column, so it was blank on every bill that had
    // ever been sent to Accounts.
    const bill = await makeBill({ "pimoMumbai.dateReceived": D("2026-07-12"), currentCount: 3 });
    await sendTo(bill, {
      asUser: "site_pimo",
      fromRole: "pimo_mumbai",
      toRole: "accounts_department",
    });

    const after = await reload(bill);
    assert.equal(after.accountsDept.givenBy, actor("site_pimo"));
    assert.ok(after.accountsDept.dateGiven, "col 80 must be stamped");
  });

  test("col 65 Name-QS Mumbai for COP records who it was given to", async () => {
    const bill = await makeBill({ "pimoMumbai.dateReceived": D("2026-07-12"), currentCount: 3 });
    await sendTo(bill, {
      asUser: "site_pimo",
      fromRole: "pimo_mumbai",
      toRole: "qs_mumbai",
      toName: "QS Mumbai Cell",
    });

    const after = await reload(bill);
    assert.equal(after.qsMumbai.name, "QS Mumbai Cell");
  });

  test("col 71 Name-PIMO for SES records the PIMO user, not the SES team", async () => {
    const bill = await makeBill({ "pimoMumbai.dateReceived": D("2026-07-12"), currentCount: 3 });
    await sendTo(bill, {
      asUser: "site_pimo",
      fromRole: "pimo_mumbai",
      toRole: "ses_team",
      toName: "SES Team",
    });

    const after = await reload(bill);
    assert.equal(after.sesDetails.name, actor("site_pimo"));
  });

  test("col 61A Name given-Site to PIMO records the PIMO recipient", async () => {
    const bill = await makeBill();
    await sendTo(bill, {
      asUser: "site_officer",
      fromRole: "site_team",
      toRole: "pimo_mumbai",
      toName: "PIMO Mumbai Desk",
    });

    const after = await reload(bill);
    assert.equal(after.pimoMumbai.namePIMO, "PIMO Mumbai Desk");
    assert.ok(after.pimoMumbai.dateGiven, "col 61 must be stamped");
    assert.ok(!after.pimoMumbai.dateReceived, "col 62 stays blank until received");
  });

  test("a body that claims someone else's name cannot write an audit column", async () => {
    const bill = await makeBill({ "qsMumbai.dateGiven": D("2026-07-14") });
    const res = await request(app)
      .post("/workflow/changeState")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.qs_site)}`)
      .send({
        // A real id, so the workflow record still saves - the point is the NAME.
        fromUser: {
          id: String(fixtures.users.qs_site._id),
          name: "Managing Trustee",
          role: "qs_team",
        },
        toUser: { id: "", name: "PIMO", role: "pimo_cop" },
        billIds: [String(bill._id)],
        action: "forward",
      });
    assert.equal(res.status, 200);

    const after = await reload(bill);
    assert.equal(after.pimoMumbai.nameReturnedFromQs, actor("qs_site"));
    assert.notEqual(after.pimoMumbai.nameReturnedFromQs, "Managing Trustee");
  });
});

/* ================================================================== *
 * Remove date
 * ================================================================== */
describe("remove date undoes exactly what the send wrote", () => {
  const removeDate = (bill, teamName, sendTo_, role) =>
    request(app)
      .post("/bill/delete-date")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users[role])}`)
      .send({ teamName, sendTo: sendTo_, billId: [String(bill._id)] });

  test("col 44A: return to Site after Prov COP can now be removed", async () => {
    // observations D-02. This cleared col 66 instead, so 44A could never be
    // undone and an unrelated column was wiped.
    const bill = await makeBill({ "qsCOP.dateGiven": D("2026-07-06") });
    await sendTo(bill, { asUser: "qs_site", fromRole: "qs_team", toRole: "site_cop" });

    let after = await reload(bill);
    assert.ok(after.copDetails.dateReturned, "precondition: col 44A stamped");

    const res = await removeDate(bill, "QS Team", "QS for Prov COP", "qs_site");
    assert.equal(res.status, 200);

    after = await reload(bill);
    assert.equal(after.copDetails.dateReturned, null); // col 44A
    assert.equal(after.copDetails.nameReturned, null); // col 44B
  });

  test("col 66: return to PIMO after COP can now be removed", async () => {
    // observations D-03.
    const bill = await makeBill({ "qsMumbai.dateGiven": D("2026-07-14") });
    await sendTo(bill, { asUser: "qs_site", fromRole: "qs_team", toRole: "pimo_cop" });

    let after = await reload(bill);
    assert.ok(after.pimoMumbai.dateReturnedFromQs, "precondition: col 66 stamped");

    const res = await removeDate(bill, "QS Team", "QS Mumbai to PIMO", "qs_site");
    assert.equal(res.status, 200);

    after = await reload(bill);
    assert.equal(after.pimoMumbai.dateReturnedFromQs, null); // col 66
    assert.equal(after.pimoMumbai.nameReturnedFromQs, null); // col 67
  });

  test("removing the return to PIMO leaves col 64 alone", async () => {
    // It used to clear qsMumbai.dateGiven, so undoing the return also undid
    // the send that preceded it.
    const bill = await makeBill({ "qsMumbai.dateGiven": D("2026-07-14") });
    await sendTo(bill, { asUser: "qs_site", fromRole: "qs_team", toRole: "pimo_cop" });
    await removeDate(bill, "QS Team", "QS Mumbai to PIMO", "qs_site");

    const after = await reload(bill);
    assert.ok(after.qsMumbai.dateGiven, "col 64 must survive");
  });

  test("Site: removing the QS Measure send clears col 35 and col 36", async () => {
    // The mapping pointed at qsMeasurementCheck.dateGiven, which the send
    // never writes, so nothing was cleared at all.
    const bill = await makeBill();
    await sendTo(bill, { asUser: "site_officer", fromRole: "site_team", toRole: "qs_measurement" });

    const res = await removeDate(bill, "Site Team", "QS Measure", "site_officer");
    assert.equal(res.status, 200);

    const after = await reload(bill);
    assert.equal(after.qsInspection.dateGiven, null); // col 35
    assert.equal(after.qsInspection.name, null); // col 36
  });

  test("PIMO: removing the send to Accounts clears col 80 and col 81", async () => {
    const bill = await makeBill({ "pimoMumbai.dateReceived": D("2026-07-12"), currentCount: 3 });
    await sendTo(bill, {
      asUser: "site_pimo",
      fromRole: "pimo_mumbai",
      toRole: "accounts_department",
    });

    const res = await removeDate(bill, "PIMO Team", "Accounts Team", "site_pimo");
    assert.equal(res.status, 200);

    const after = await reload(bill);
    assert.equal(after.accountsDept.dateGiven, null); // col 80
    assert.equal(after.accountsDept.givenBy, null); // col 81
  });

  test("Mark as not received sends the bill back to Incoming", async () => {
    const bill = await makeBill({
      "pimoMumbai.dateGiven": D("2026-07-10"),
      "pimoMumbai.dateReceived": D("2026-07-12"),
      "pimoMumbai.receivedBy": "Someone",
      currentCount: 3,
    });

    const res = await removeDate(bill, "PIMO Team", "Mark as not received", "site_pimo");
    assert.equal(res.status, 200);

    const after = await reload(bill);
    assert.equal(after.pimoMumbai.dateReceived, null); // col 62
    assert.equal(after.pimoMumbai.receivedBy, null); // col 63
    assert.equal(after.pimoMumbai.markReceived, false);
  });

  test("an unknown sendTo is rejected rather than silently clearing nothing", async () => {
    const bill = await makeBill();
    const res = await removeDate(bill, "QS Team", "Not A Real Send", "qs_site");
    assert.equal(res.status, 400);
  });
});

/* ================================================================== *
 * Pencil edit
 * ================================================================== */
describe("pencil edit keeps every field it was given", () => {
  const patch = (bill, body, role = "accounts") =>
    request(app)
      .patch(`/bill/${bill._id}`)
      .set("Authorization", `Bearer ${tokenFor(fixtures.users[role])}`)
      .send(body);

  test("saving a payment date keeps the other Accounts fields", async () => {
    // observations P-01. The grid sent each edited cell as
    // "accountsDept.<field>" AND a whole accountsDept object rebuilt from the
    // row as it was fetched; the object was applied second and won, so every
    // other field reverted the moment a payment date was saved with it.
    const bill = await makeBill({
      "accountsDept.dateReceived": D("2026-07-22"),
      "accountsDept.f110Identification": "OLD-F110",
      "accountsDept.hardCopy": "OLD-HC",
      "accountsDept.accountsIdentification": "OLD-ID",
      "accountsDept.remarksForPayInstructions": "old remark",
      "accountsDept.remarksAcctsDept": "old accts remark",
      currentCount: 5,
    });

    const res = await patch(bill, {
      "accountsDept.paymentDate": "2026-08-01",
      "accountsDept.status": "Paid",
      "accountsDept.f110Identification": "NEW-F110",
      "accountsDept.hardCopy": "NEW-HC",
      "accountsDept.accountsIdentification": "NEW-ID",
      "accountsDept.remarksForPayInstructions": "new remark",
      "accountsDept.remarksAcctsDept": "new accts remark",
    });
    assert.equal(res.status, 200);

    const after = await reload(bill);
    assert.equal(after.accountsDept.f110Identification, "NEW-F110");
    assert.equal(after.accountsDept.hardCopy, "NEW-HC");
    assert.equal(after.accountsDept.accountsIdentification, "NEW-ID");
    assert.equal(after.accountsDept.remarksForPayInstructions, "new remark");
    assert.equal(after.accountsDept.remarksAcctsDept, "new accts remark");
    assert.ok(after.accountsDept.paymentDate);
  });

  test("an explicit parent.child key beats the same field inside a nested object", async () => {
    // This is the shape the old client sent. Whichever way round it arrives,
    // the specific instruction must win over the wholesale one.
    const bill = await makeBill({
      "accountsDept.dateReceived": D("2026-07-22"),
      "accountsDept.f110Identification": "OLD-F110",
      currentCount: 5,
    });

    const res = await patch(bill, {
      "accountsDept.f110Identification": "NEW-F110",
      accountsDept: { f110Identification: "OLD-F110", paymentDate: "2026-08-01" },
    });
    assert.equal(res.status, 200);

    const after = await reload(bill);
    assert.equal(after.accountsDept.f110Identification, "NEW-F110");
    assert.ok(after.accountsDept.paymentDate, "the rest of the object still applies");
  });

  test("a nested object on its own still updates only the keys it carries", async () => {
    const bill = await makeBill({
      "accountsDept.dateReceived": D("2026-07-22"),
      "accountsDept.hardCopy": "KEEP-ME",
      currentCount: 5,
    });

    await patch(bill, { accountsDept: { f110Identification: "F110" } });

    const after = await reload(bill);
    assert.equal(after.accountsDept.f110Identification, "F110");
    assert.equal(after.accountsDept.hardCopy, "KEEP-ME", "siblings must survive");
  });
});

/* ================================================================== *
 * Who may send
 *
 * changeBatchWorkflowState picks its branch from fromUser.role, which is
 * supplied by the client. Nothing checked it against the caller's own roles.
 * ================================================================== */
describe("a user can only send as a team they hold", () => {
  test("Site cannot send as the Trustee", async () => {
    const bill = await makeBill({ "pimoMumbai.dateReceived": D("2026-07-12"), currentCount: 3 });
    const res = await sendTo(bill, {
      asUser: "site_officer",
      fromRole: "trustee", // not theirs
      toRole: "pimo_mumbai",
    });

    assert.equal(res.status, 403);
    const after = await reload(bill);
    assert.ok(!after.pimoMumbai.dateReturnedFromDirector, "nothing was written");
  });

  test("Site cannot send as PIMO to move a bill to Accounts", async () => {
    const bill = await makeBill({ "pimoMumbai.dateReceived": D("2026-07-12"), currentCount: 3 });
    const res = await sendTo(bill, {
      asUser: "site_officer",
      fromRole: "pimo_mumbai",
      toRole: "accounts_department",
    });

    assert.equal(res.status, 403);
    const after = await reload(bill);
    assert.ok(!after.accountsDept.dateGiven, "col 80 must not be stamped");
  });

  test("each team can send as itself", async () => {
    const cases = [
      ["site_officer", "site_team", "qs_measurement"],
      ["qs_site", "qs_team", "site_cop"],
      ["site_pimo", "pimo_mumbai", "it_team"],
    ];
    for (const [asUser, fromRole, toRole] of cases) {
      const bill = await makeBill({ "qsCOP.dateGiven": D("2026-07-06"), currentCount: 3 });
      const res = await sendTo(bill, { asUser, fromRole, toRole });
      assert.equal(res.status, 200, `${asUser} sending as ${fromRole}`);
    }
  });

  test("the PIMO login role maps to the pimo_mumbai workflow team", async () => {
    // The login role is site_pimo; the branches dispatch on pimo_mumbai.
    const bill = await makeBill({ "pimoMumbai.dateReceived": D("2026-07-12"), currentCount: 3 });
    const res = await sendTo(bill, {
      asUser: "site_pimo",
      fromRole: "pimo_mumbai",
      toRole: "accounts_department",
    });
    assert.equal(res.status, 200);
  });

  test("an admin may still send as any team", async () => {
    const bill = await makeBill({ "pimoMumbai.dateReceived": D("2026-07-12"), currentCount: 3 });
    const res = await sendTo(bill, {
      asUser: "admin",
      fromRole: "pimo_mumbai",
      toRole: "accounts_department",
    });
    assert.equal(res.status, 200);
  });

  test("a body with no role falls back to the caller's own team", async () => {
    // It used to fall back to the LOGIN role, which no branch matches, so the
    // send silently failed with "No matching workflow transition rule found".
    const bill = await makeBill();
    const res = await request(app)
      .post("/workflow/changeState")
      .set("Authorization", `Bearer ${tokenFor(fixtures.users.site_officer)}`)
      .send({
        fromUser: { id: String(fixtures.users.site_officer._id), name: "X" },
        toUser: { id: "", name: "Ravi QS", role: "qs_measurement" },
        billIds: [String(bill._id)],
        action: "forward",
      });

    assert.equal(res.status, 200);
    const after = await reload(bill);
    assert.ok(after.qsInspection.dateGiven, "col 35 must be stamped");
  });
});
