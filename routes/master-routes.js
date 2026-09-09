import express from 'express';
import masterController from '../controllers/master-controller.js';
import { authenticate, authorize } from '../middleware/middleware.js';

const router = express.Router();

/*
 * These routes carried NO authentication at all.
 *
 * Anyone who could reach the server could read the entire vendor master and
 * the user list (without password hashes, which the schema already withholds),
 * and create, rename or delete any master record - regions,
 * currencies, natures of work, PAN statuses, compliance entries and users. A
 * renamed or deleted region also invalidates every bill that references it.
 *
 * This is the same gap already found and closed on /excel and /sentBills.
 *
 * Reads stay open to any signed-in user, because every team's dropdowns and
 * the checklists depend on them. Writes are admin-only: the only callers are
 * the admin master tables.
 */
router.use(authenticate);

const adminOnly = authorize('admin');

// Vendor Master
router.post('/vendors', adminOnly, masterController.createVendor);
router.get('/vendors', masterController.getVendors);
router.put('/vendors/:id', adminOnly, masterController.updateVendor);
router.delete('/vendors/:id', adminOnly, masterController.deleteVendor);

// Compliance Master
router.post('/compliances', adminOnly, masterController.createCompliance);
router.get('/compliances', masterController.getCompliances);
router.put('/compliances/:id', adminOnly, masterController.updateCompliance);
router.delete('/compliances/:id', adminOnly, masterController.deleteCompliance);

// User Master
router.post('/users', adminOnly, masterController.createUser);
router.get('/users', masterController.getUsers);
router.put('/users/:id', adminOnly, masterController.updateUser);
router.delete('/users/:id', adminOnly, masterController.deleteUser);

// PAN Status Master
router.post('/panstatus', adminOnly, masterController.createPanStatus);
router.get('/panstatus', masterController.getPanStatuses);
router.put('/panstatus/:id', adminOnly, masterController.updatePanStatus);
router.delete('/panstatus/:id', adminOnly, masterController.deletePanStatus);

// Region Master
router.post('/regions', adminOnly, masterController.createRegion);
router.get('/regions', masterController.getRegions);
router.put('/regions/:id', adminOnly, masterController.updateRegion);
router.delete('/regions/:id', adminOnly, masterController.deleteRegion);

// Nature of Work Master
router.post('/nature-of-works', adminOnly, masterController.createNatureOfWork);
router.get('/nature-of-works', masterController.getNatureOfWorks);
router.put('/nature-of-works/:id', adminOnly, masterController.updateNatureOfWork);
router.delete('/nature-of-works/:id', adminOnly, masterController.deleteNatureOfWork);

// Currency Master
router.post('/currencies', adminOnly, masterController.createCurrency);
router.get('/currencies', masterController.getCurrencies);
router.put('/currencies/:id', adminOnly, masterController.updateCurrency);
router.delete('/currencies/:id', adminOnly, masterController.deleteCurrency);

export default router;
