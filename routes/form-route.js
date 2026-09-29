import express from "express";
import { authenticate, authorize } from "../middleware/middleware.js";
import { multerUpload } from "../utils/multer.js";
import {
  listForms,
  downloadForm,
  uploadForm,
  deleteForm,
} from "../controllers/form-controller.js";

const router = express.Router();

// Forms repository (29.09, reply Q2): every team reads, only Admin writes.
router.use(authenticate);

router.get("/", listForms);
router.get("/download/:id", downloadForm);
// multerUpload caps the file at 5 MB; a larger one is a MulterError -> 400.
router.post("/upload", authorize("admin"), multerUpload.single("file"), uploadForm);
router.delete("/:id", authorize("admin"), deleteForm);

export default router;
