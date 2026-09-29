/**
 * BLOCK: forms repository (29.09, reply Q2)
 *
 * "The forms will be uploaded by Admin and should be available for downloads
 * in all the teams in reporting tab ... no version needed. Latest will be
 * available to download."
 *
 * Files go to S3, as bill attachments do. The S3 client is stubbed here with
 * an in-memory bucket so no test ever reaches AWS.
 */
import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { S3 } from "@aws-sdk/client-s3";

import { startDb, stopDb, clearDb } from "../helpers/db.js";

let app, seed, tokenFor, fixtures, Form;
const bucket = new Map();

before(async () => {
  await startDb();
  ({ buildApp: app } = await import("../helpers/app.js"));
  seed = await import("../helpers/seed.js");
  ({ tokenFor } = seed);
  ({ default: Form } = await import("../../models/form-model.js"));
  app = app();

  mock.method(S3.prototype, "putObject", async ({ Key, Body }) => {
    bucket.set(Key, Buffer.from(Body));
    return {};
  });
  mock.method(S3.prototype, "getObject", async ({ Key }) => {
    if (!bucket.has(Key)) throw new Error("NoSuchKey");
    const bytes = bucket.get(Key);
    return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
  });
  mock.method(S3.prototype, "deleteObject", async ({ Key }) => {
    bucket.delete(Key);
    return {};
  });
});

after(async () => {
  mock.restoreAll();
  await stopDb();
});

beforeEach(async () => {
  await clearDb();
  await Form.syncIndexes();
  bucket.clear();
  fixtures = await seed.seedAll();
});

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const auth = (req, role) =>
  req.set("Authorization", `Bearer ${tokenFor(fixtures.users[role])}`);

const upload = (role, title, { name = "undertaking.docx", type = DOCX, body } = {}) =>
  auth(request(app).post("/forms/upload"), role)
    .field("title", title)
    .attach("file", body ?? Buffer.from(`contents of ${name}`), {
      filename: name,
      contentType: type,
    });

const list = (role) => auth(request(app).get("/forms"), role);

/** supertest leaves unknown content types unparsed; collect the raw bytes. */
const download = (role, id) =>
  auth(request(app).get(`/forms/download/${id}`), role)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });

describe("forms: upload (admin only)", () => {
  test("admin uploads a Word form", async () => {
    const res = await upload("admin", "Vendor Undertaking");
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.title, "Vendor Undertaking");
    assert.equal(res.body.data.fileName, "undertaking.docx");
    assert.equal(res.body.data.mimeType, DOCX);
    assert.ok(res.body.data.size > 0);
    assert.equal(bucket.size, 1);
    const [key] = bucket.keys();
    assert.ok(key.startsWith("forms/"), key);
  });

  test("a PDF and a legacy .doc are accepted too", async () => {
    const pdf = await upload("admin", "PDF Form", { name: "f.pdf", type: "application/pdf" });
    const doc = await upload("admin", "Old Form", { name: "f.doc", type: "application/msword" });
    assert.equal(pdf.status, 201);
    assert.equal(doc.status, 201);
  });

  for (const role of ["site_officer", "site_pimo", "qs_site", "pimo_mumbai", "director", "accounts"]) {
    test(`${role} cannot upload (403)`, async () => {
      const res = await upload(role, "Sneaky");
      assert.equal(res.status, 403);
      assert.equal(await Form.countDocuments(), 0);
      assert.equal(bucket.size, 0);
    });
  }

  test("unauthenticated upload is refused (401)", async () => {
    const res = await request(app)
      .post("/forms/upload")
      .field("title", "X")
      .attach("file", Buffer.from("x"), { filename: "x.docx", contentType: DOCX });
    assert.equal(res.status, 401);
  });

  test("same title replaces the file - no versions", async () => {
    const first = await upload("admin", "Vendor Undertaking", { body: Buffer.from("v1") });
    const second = await upload("admin", "vendor undertaking", {
      name: "undertaking-2026.docx",
      body: Buffer.from("version two"),
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.data._id, first.body.data._id);
    assert.equal(await Form.countDocuments(), 1);

    const dl = await download("site_officer", first.body.data._id);
    assert.equal(dl.body.toString(), "version two");
    assert.match(dl.headers["content-disposition"], /undertaking-2026\.docx/);
    // The replaced file is cleared from the bucket.
    await new Promise((r) => setImmediate(r));
    assert.equal(bucket.size, 1);
  });

  test("a .docx reported as a generic binary type is accepted", async () => {
    const res = await upload("admin", "Generic Type", { type: "application/octet-stream" });
    assert.equal(res.status, 201, res.text?.slice(0, 200));
  });

  test("wrong file types are refused", async () => {
    const cases = [
      { name: "notes.txt", type: "text/plain" },
      { name: "sheet.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { name: "evil.exe", type: "application/msword" }, // type ok, extension not
      { name: "renamed.docx", type: "text/html" }, // extension ok, type not
    ];
    for (const c of cases) {
      const res = await upload("admin", `Bad ${c.name}`, c);
      assert.equal(res.status, 400, c.name);
    }
    assert.equal(await Form.countDocuments(), 0);
    assert.equal(bucket.size, 0);
  });

  test("title and file are both required", async () => {
    const noTitle = await upload("admin", "  ");
    assert.equal(noTitle.status, 400);
    const noFile = await auth(request(app).post("/forms/upload"), "admin").field("title", "T");
    assert.equal(noFile.status, 400);
  });

  test("files over 5 MB are refused", async () => {
    const res = await upload("admin", "Huge", { body: Buffer.alloc(5 * 1024 * 1024 + 1) });
    assert.equal(res.status, 400);
    assert.equal(await Form.countDocuments(), 0);
  });
});

describe("forms: list and download (every team)", () => {
  test("every role sees the list, sorted by title, without file bytes", async () => {
    await upload("admin", "Zeta Declaration");
    await upload("admin", "alpha undertaking");
    await upload("admin", "Mid Form");
    for (const role of seed.ROLES) {
      const res = await list(role);
      assert.equal(res.status, 200, role);
      assert.deepEqual(
        res.body.data.map((f) => f.title),
        ["alpha undertaking", "Mid Form", "Zeta Declaration"],
        role
      );
      assert.equal(res.body.data[0].fileKey, undefined);
    }
  });

  test("unauthenticated list and download are refused (401)", async () => {
    const up = await upload("admin", "Vendor Undertaking");
    assert.equal((await request(app).get("/forms")).status, 401);
    assert.equal(
      (await request(app).get(`/forms/download/${up.body.data._id}`)).status,
      401
    );
  });

  test("download returns the bytes with the original filename", async () => {
    const body = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 250]);
    const up = await upload("admin", "Vendor Undertaking", { name: "Vendor Undertaking.docx", body });
    for (const role of seed.ROLES) {
      const res = await download(role, up.body.data._id);
      assert.equal(res.status, 200, role);
      assert.ok(Buffer.compare(res.body, body) === 0, role);
      assert.match(res.headers["content-disposition"], /^attachment;/);
      assert.match(res.headers["content-disposition"], /Vendor Undertaking\.docx/);
      assert.equal(res.headers["content-type"].split(";")[0], DOCX);
    }
  });

  test("unknown or malformed id is 404", async () => {
    assert.equal((await download("admin", "000000000000000000000000")).status, 404);
    assert.equal((await download("admin", "not-an-id")).status, 404);
  });
});

describe("forms: delete (admin only)", () => {
  test("admin deletes a form and its file", async () => {
    const up = await upload("admin", "Vendor Undertaking");
    const res = await auth(request(app).delete(`/forms/${up.body.data._id}`), "admin");
    assert.equal(res.status, 200);
    assert.equal(await Form.countDocuments(), 0);
    assert.equal(bucket.size, 0);
    assert.equal((await list("accounts")).body.data.length, 0);
  });

  for (const role of ["site_officer", "site_pimo", "qs_site", "pimo_mumbai", "director", "accounts"]) {
    test(`${role} cannot delete (403)`, async () => {
      const up = await upload("admin", "Vendor Undertaking");
      const res = await auth(request(app).delete(`/forms/${up.body.data._id}`), role);
      assert.equal(res.status, 403);
      assert.equal(await Form.countDocuments(), 1);
    });
  }

  test("unauthenticated delete is refused (401)", async () => {
    const up = await upload("admin", "Vendor Undertaking");
    const res = await request(app).delete(`/forms/${up.body.data._id}`);
    assert.equal(res.status, 401);
    assert.equal(await Form.countDocuments(), 1);
  });

  test("deleting a missing form is 404", async () => {
    const res = await auth(request(app).delete("/forms/000000000000000000000000"), "admin");
    assert.equal(res.status, 404);
  });
});
