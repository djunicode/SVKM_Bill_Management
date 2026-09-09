import express from "express";
import billController from "../controllers/bill-controller.js";
import {
  authenticate,
  authorize,
  validateWorkflowTransition,
  validateStateAccess,
  authMiddleware,
} from "../middleware/middleware.js";
import { multerUpload } from "../utils/multer.js";

const router = express.Router();
router.use(authenticate);

router.post(
  "/",
  multerUpload.array("files", 15),
  // authorize('admin', 'site_officer'),
  billController.createBill
);
router.get("/", authMiddleware, billController.getBills);
router.get("/get-filtered-bills", billController.getFilteredBills);
router.get("/:id", billController.getBill);
router.get("/srno/:srNo", billController.getBillBySrNo); // Get bill by srNo (7 digits)
router.put(
  "/:id",
  authorize("admin", "site_officer"),
  billController.updateBill
);
router.delete("/:id", authorize("admin"), billController.deleteBill);

// Bill filtering routes
router.post("/filter", billController.filterBills);
router.get("/stats/overview", billController.getBillsStats);

// Serial number regeneration route - admin only
// router.post('/regenerate-serial-numbers', authorize('admin'), billController.regenerateAllSerialNumbers);

// // Workflow routes with appropriate middleware
// router.post('/workflow/:id/advance', validateWorkflowTransition, billController.advanceWorkflow);
// router.post('/workflow/:id/revert', validateWorkflowTransition, billController.revertWorkflow);
// router.post('/workflow/:id/reject', validateWorkflowTransition, billController.rejectBill);
// router.post('/workflow/:id/recover', validateWorkflowTransition, billController.recoverRejectedBill);
// router.get('/workflow/:id/history', billController.getWorkflowHistory);
// router.get('/workflow/state/:state', validateStateAccess, billController.getBillsByWorkflowState);

// // Workflow state update 2
// router.patch('/:id/workflow2', authenticate, billController.changeWorkflowState);

// PATCH route for editing bill by id or srNo (id is optional)
router.patch(
  "/:id?",
  multerUpload.array("files", 15),
  billController.patchBill
);
//receiveBillByPimoAccounts
router.post("/receiveBill", billController.receiveBillByPimoAccounts);

// Endpoint to edit payment instructions (Accounts / Trustees / Admin)
router.patch(
  "/payment-instructions/:id",
  authorize("admin", "accounts", "director"),
  billController.editPaymentInstructions
);

// Delete attachment for a particular bill
router.post("/attachment/delete", billController.deleteAttachment);
router.delete("/attachment", billController.deleteAttachment);
router.post("/attachment", billController.deleteAttachment);

// todo: milan bhai abhi add kiya
router.post("/not-received-pimo", billController.notReceivedPimo);
router.post("/not-received-account", billController.notReceivedAccounts);
router.post("/reject-payment", billController.accountsPaymentReject);

// Delete specific date fields based on team workflow
router.post("/delete-date", billController.deleteDate);

export default router;
