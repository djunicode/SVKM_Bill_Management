import express from 'express';
import statController from '../controllers/stat-controller.js';
import { authenticate } from '../middleware/middleware.js';
import { authorize } from '../middleware/middleware.js';

const router = express.Router();

// Apply authentication middleware to all stat routes
router.use(authenticate);

// Basic system statistics - available to all authenticated users
router.get('/system', statController.getSystemStats);

// Vendor statistics - available to authenticated users with finance role or admin
router.get('/vendors', authorize(['admin', 'accounts', 'director']), statController.getVendorStats);

// Bill statistics over time - available to authenticated users with finance role or admin
router.get('/bills/time', authorize(['admin', 'accounts', 'director']), statController.getBillTimeStats);

export default router; 