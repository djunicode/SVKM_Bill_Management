/**
 * In-memory MongoDB for tests.
 *
 * SAFETY: the project's only real connection string points at PRODUCTION.
 * This module must be imported before anything that reads MONGODB_URI, and it
 * refuses to proceed if the resolved connection is not local. Never relax that
 * guard — a test suite that creates, forwards and pays bills against the live
 * database would write real rows into SVKM's ledger.
 */
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

let server = null;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"]);

/** Throw unless `uri` points at a loopback address. */
export const assertLocal = (uri) => {
  if (!uri) throw new Error("No MONGODB_URI resolved for tests");
  let host;
  try {
    // mongodb://127.0.0.1:port/db -> URL needs a parseable protocol
    host = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, "http://")).hostname;
  } catch {
    throw new Error(`Unparseable MONGODB_URI for tests: ${uri.slice(0, 24)}…`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `REFUSING TO RUN: tests resolved a non-local database (host "${host}"). ` +
        `Tests must never touch the production cluster.`
    );
  }
  return uri;
};

/**
 * Boot the in-memory server and point the process at it.
 * Sets NODE_ENV=test so middleware/middleware.js does NOT fall back to its
 * development auth bypass — tests then exercise real token handling.
 */
export const startDb = async () => {
  process.env.NODE_ENV = "test";
  server = await MongoMemoryServer.create();
  const uri = assertLocal(server.getUri());

  // dotenv does not overwrite variables that already exist, so setting these
  // first keeps the real .env from reaching mongoose.
  process.env.MONGODB_URI = uri;
  process.env.JWT_SECRET = process.env.JWT_SECRET_TEST || "test-jwt-secret";
  process.env.JWT_EXPIRE = "1h";
  process.env.RESET_PASSWORD_JWT_SECRET = "test-reset-secret";

  await mongoose.connect(uri);
  assertLocal(mongoose.connection.client.s.url ?? uri);
  return uri;
};

export const stopDb = async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (server) await server.stop();
  server = null;
};

/** Remove every document without tearing the server down. */
export const clearDb = async () => {
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((c) => c.deleteMany({}))
  );
};
