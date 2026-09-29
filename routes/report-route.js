import express from "express";
const router = express.Router();
import { authenticate, authorize } from "../middleware/middleware.js";
import {
  getOutstandingBillsReport,
  getOutstandingBillsSubtotalReport,
  getInvoicesReceivedAtSite,
  getInvoicesCourierToPIMOMumbai,
  getInvoicesReceivedAtPIMOMumbai,
  getInvoicesGivenToAcctsDept,
  getInvoicesGivenToQsSite,
  getInvoicesPaid,
  getPendingBillsReport,
  getBillJourney,
  getBillKidharReport,
  getInvoicesAtQSforProvCOP,
  getInvoicesAtQSMumbai,
  getInvoicesReturnedByQsSite,
  getInvoicesReturnedByQsCOP,
  getInvoicesReturnedByQSMumbai,
  getVendorDetailsReport,
} from "../controllers/report-controller.js";

router.use(authenticate);

// Role names as the user schema spells them. Both PIMO spellings are listed:
// the login role is site_pimo, pimo_mumbai is the workflow team name and is
// also a valid enum value. PIMO_ROLES carried only pimo_mumbai, so the real
// PIMO user got 403 from four of their own reports - Invoices at PIMO,
// Invoices sent to Accts Team, Bill Journey and Invoices at QS Mumbai. Only
// SITE_ROLES happened to list both, which is why the site reports worked.
const DIRECTOR_ROLES = ["director", "admin"];
const ACCOUNTS_ROLES = ["accounts", ...DIRECTOR_ROLES];
const PIMO_ROLES = ["site_pimo", "pimo_mumbai", ...DIRECTOR_ROLES];
const SITE_ROLES = ["site_officer", ...PIMO_ROLES];
const QS_ROLES = ["qs_site", "qs_mumbai", "admin"];

// 12. Outstanding Bills Report
router.get(
  "/outstanding-bills",
  authorize(ACCOUNTS_ROLES),
  getOutstandingBillsReport
);

// 13. Outstanding Bills Report Subtotal
router.get(
  "/outstanding-bills-subtotal",
  authorize(ACCOUNTS_ROLES),
  getOutstandingBillsSubtotalReport
);

// 1. Invoices at Site
router.get(
  "/invoices-received-at-site",
  authorize(["site_officer", "site_pimo", "pimo_mumbai", "director", "admin"]),
  getInvoicesReceivedAtSite
);

// 2. Invoices at PIMO
router.get(
  "/invoices-received-at-pimo-mumbai",
  authorize(PIMO_ROLES),
  getInvoicesReceivedAtPIMOMumbai
);

// 3. Invoices with QS Site for Measurement
router.get(
  "/invoices-received-at-qsmeasurement",
  authorize([...SITE_ROLES, ...QS_ROLES]),
  getInvoicesGivenToQsSite
);

// 4. Invoices with QS Site for Prov COP
router.get(
  "/invoices-received-at-qscop",
  authorize([...SITE_ROLES, ...QS_ROLES]),
  getInvoicesAtQSforProvCOP
);

// 5. Invoices with QS Mumbai for COP
router.get(
  "/invoices-received-at-qsmumbai",
  authorize([...QS_ROLES, "site_pimo", "pimo_mumbai"]),
  getInvoicesAtQSMumbai
);

// 6. Invoices Sent to PIMO Mumbai
router.get(
  "/invoices-courier-to-pimo-mumbai",
  authorize(["site_officer", "site_pimo", "pimo_mumbai", "admin"]),
  getInvoicesCourierToPIMOMumbai
);

// 7. Invoices Returned by QS Site after Measurement
router.get(
  "/invoices-returned-by-qsmeasurement",
  authorize(QS_ROLES),
  getInvoicesReturnedByQsSite
);

// 8. Invoices Returned by QS Site after Prov COP
router.get(
  "/invoices-returned-by-qscop",
  authorize(QS_ROLES),
  getInvoicesReturnedByQsCOP
);

// 9. Invoices Returned by QS Mumbai after COP
router.get(
  "/invoices-returned-by-qsmumbai",
  authorize(QS_ROLES),
  getInvoicesReturnedByQSMumbai
);

// 10. Invoices Sent to Accts Team
router.get(
  "/invoices-given-to-accounts",
  authorize(PIMO_ROLES),
  getInvoicesGivenToAcctsDept
);

// 11. Invoices Paid
router.get(
  "/invoices-Paid",
  authorize(ACCOUNTS_ROLES),
  getInvoicesPaid
);

// 14. Bill Kidhar Report
// Gated on pimo_mumbai alone, so only users who happened to hold that second
// PIMO role could open it (24.09, item 7) - and Accounts, who have the button,
// never could. Same entitlement as Bill Journey now.
router.get(
  "/bill-kidhar",
  authorize([...PIMO_ROLES, "accounts"]),
  getBillKidharReport
);

// 15. Bill Journey Report
router.get(
  "/bill-journey",
  authorize([...PIMO_ROLES, "accounts"]),
  getBillJourney
);

// Legacy pending bills endpoint
router.get(
  "/pending-bills",
  authorize(["admin", "site_officer", "site_pimo", "qs_site", "pimo_mumbai"]),
  getPendingBillsReport
);

// Vendor Details - every team, per observation N-08. authenticate() at the top
// of this file still applies; there is no role list because the report is
// explicitly for all teams.
router.get("/vendor-details", getVendorDetailsReport);

export default router;
