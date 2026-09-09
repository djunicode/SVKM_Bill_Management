import express from "express";
import { getBillsAboveLevel } from "../controllers/sentBills-controller.js";
import { authenticate } from "../middleware/middleware.js";

const router = express.Router();

// This endpoint reads bills across every team, so it needs a token and the
// caller's region, exactly as the other bill queries do. It was mounted open.
router.use(authenticate);

// GET /sentBills/:role - the Forwarded tab for that team
router.get("/:role", getBillsAboveLevel);

export default router;
