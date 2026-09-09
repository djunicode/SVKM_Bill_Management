/**
 * Fixtures: master data, a vendor, and one user per role.
 *
 * Values follow the formats given in the "Field entry" sheet — vendor no is
 * numeric 6 digits (col 6), PO no numeric 10 digits (col 12), tax inv no up to
 * 16 (col 20) — so tests exercise realistic data rather than placeholders.
 */
import jwt from "jsonwebtoken";
import RegionMaster from "../../models/region-master-model.js";
import CurrencyMaster from "../../models/currency-master-model.js";
import NatureOfWorkMaster from "../../models/nature-of-work-master-model.js";
import PanStatusMaster from "../../models/pan-status-master-model.js";
import ComplianceMaster from "../../models/compliance-master-model.js";
import VendorMaster from "../../models/vendor-master-model.js";
import User from "../../models/user-model.js";

export const REGIONS = ["MUMBAI", "INDORE", "DHULE"];
export const CURRENCIES = ["INR", "USD"];

// Nature-of-work values the createBill uniqueness check special-cases.
export const NATURES = [
  "Materials",
  "Service",
  "Advance/LC/BG",
  "Direct FI Entry",
  "Proforma Invoice",
  "Hold/Ret Release",
  "Petty cash", // note the lower-case c, as in utils/natureOfWorkInsert.js
];

export const seedMasters = async () => {
  const [regions, currencies, natures, panStatuses, compliances] =
    await Promise.all([
      RegionMaster.insertMany(REGIONS.map((name) => ({ name }))),
      CurrencyMaster.insertMany(CURRENCIES.map((currency) => ({ currency }))),
      NatureOfWorkMaster.insertMany(NATURES.map((natureOfWork) => ({ natureOfWork }))),
      PanStatusMaster.insertMany([{ name: "PAN OPERATIVE" }, { name: "PAN INOPERATIVE" }]),
      ComplianceMaster.insertMany([{ compliance206AB: "206AB check passed" }]),
    ]);
  return { regions, currencies, natures, panStatuses, compliances };
};

export const seedVendor = async ({ panStatuses, compliances }, overrides = {}) =>
  VendorMaster.create({
    vendorNo: 123456, // col 6 - numeric 6 digits
    vendorName: "Acme Constructions Pvt Ltd",
    PAN: "AAAPL1234C",
    GSTNumber: "27AAAPL1234C1ZV",
    complianceStatus: compliances[0]._id,
    PANStatus: panStatuses[0]._id,
    emailIds: ["accounts@acme.example"],
    phoneNumbers: ["9820012345"],
    ...overrides,
  });

/** Roles as declared in user-model.js. */
export const ROLES = [
  "admin",
  "site_officer",
  "site_pimo",
  "qs_site",
  "pimo_mumbai",
  "director",
  "accounts",
];

const DEPARTMENT = {
  admin: "Admin",
  site_officer: "Site",
  site_pimo: "PIMO",
  qs_site: "QS",
  pimo_mumbai: "PIMO",
  director: "Management",
  accounts: "Accounts",
};

export const seedUsers = async (region = ["MUMBAI"]) => {
  const users = {};
  for (const role of ROLES) {
    users[role] = await User.create({
      name: `Test ${role}`,
      email: `${role}@test.example`,
      password: "password123",
      role: [role], // NOTE: the schema stores role as an ARRAY
      department: [DEPARTMENT[role]],
      region,
    });
  }
  return users;
};

/**
 * Mint a token the same way user-model.getSignedToken does, i.e. with `role`
 * as an ARRAY. Tests must use this rather than a hand-rolled string role, or
 * they will not reproduce how the real app behaves.
 */
export const tokenFor = (user) =>
  jwt.sign(
    {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      region: user.region,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE }
  );

export const seedAll = async () => {
  const masters = await seedMasters();
  const vendor = await seedVendor(masters);
  const users = await seedUsers();
  return { ...masters, vendor, users };
};

/** A create-bill body with every required field populated. */
export const billPayload = (overrides = {}) => ({
  vendorNo: 123456,
  projectDescription: "Mithibai College - Block A refurbishment",
  region: "MUMBAI",
  currency: "INR",
  natureOfWork: "Materials",
  poCreated: "No",
  taxInvNo: "INV-2026-0001",
  taxInvDate: "2026-08-01",
  taxInvAmt: 250000,
  taxInvRecdAtSite: "2026-08-03", // col 24
  taxInvRecdBy: "Site Clerk",
  billDate: "2026-08-01",
  amount: 250000,
  siteStatus: "hold",
  ...overrides,
});
