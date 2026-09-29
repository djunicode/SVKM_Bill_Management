/**
 * Forms repository (29.09, reply Q2).
 *
 * "The forms will be uploaded by Admin and should be available for downloads
 * in all the teams in reporting tab ... no version needed. Latest will be
 * available to download."
 */
import path from "path";
import mongoose from "mongoose";
import Form from "../models/form-model.js";
import { s3Upload, s3Get, s3Delete } from "../utils/s3.js";

const TITLE_COLLATION = { locale: "en", strength: 2 };

// Word and PDF only. The extension and the browser-reported type must agree.
const ALLOWED = {
  ".doc": ["application/msword"],
  ".docx": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ".pdf": ["application/pdf"],
};

// Some browsers on Windows report Word files as a generic binary type. The
// extension still has to be .doc/.docx/.pdf, and only admin can upload.
const GENERIC_TYPES = ["application/octet-stream", ""];

const isAllowedFile = (file) => {
  const ext = path.extname(file?.originalname || "").toLowerCase();
  const type = (file?.mimetype || "").toLowerCase();
  if (!ALLOWED[ext]) return false;
  return ALLOWED[ext].includes(type) || GENERIC_TYPES.includes(type);
};

const toMeta = (form) => ({
  _id: form._id,
  title: form.title,
  fileName: form.fileName,
  mimeType: form.mimeType,
  size: form.size,
  uploadedBy: form.uploadedBy,
  createdAt: form.createdAt,
  updatedAt: form.updatedAt,
});

/** GET /forms - every signed-in user, all teams. Metadata only, no paging. */
export const listForms = async (req, res) => {
  try {
    const forms = await Form.find()
      .collation(TITLE_COLLATION)
      .sort({ title: 1 })
      .lean();
    return res.status(200).json({ success: true, data: forms.map(toMeta) });
  } catch (error) {
    console.error("Error listing forms:", error);
    return res.status(500).json({ success: false, message: "Failed to list forms" });
  }
};

/** GET /forms/download/:id - every signed-in user. */
export const downloadForm = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ success: false, message: "Form not found" });
    }
    const form = await Form.findById(id).lean();
    if (!form) {
      return res.status(404).json({ success: false, message: "Form not found" });
    }
    const bytes = await s3Get(form.fileKey);
    res.attachment(form.fileName); // Content-Disposition: attachment; filename=...
    res.set("Content-Type", form.mimeType);
    res.set("Content-Length", String(bytes.length));
    return res.status(200).send(bytes);
  } catch (error) {
    console.error("Error downloading form:", error);
    return res.status(500).json({ success: false, message: "Failed to download form" });
  }
};

/**
 * POST /forms/upload - admin only. multipart: title + file.
 * An existing title (case-insensitive) is replaced in place: no versions.
 */
export const uploadForm = async (req, res) => {
  try {
    const title = (req.body?.title || "").trim();
    const file = req.file;
    if (!title) {
      return res.status(400).json({ success: false, message: "Title is required" });
    }
    if (!file) {
      return res.status(400).json({ success: false, message: "File is required" });
    }
    if (!isAllowedFile(file)) {
      return res.status(400).json({
        success: false,
        message: "Only Word (.doc, .docx) or PDF files are accepted",
      });
    }

    const uploaded = await s3Upload(file, "forms");
    const existing = await Form.findOne({ title }).collation(TITLE_COLLATION);
    const fields = {
      fileName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      fileKey: uploaded.fileKey,
      uploadedBy: req.user?.id,
    };

    let form;
    if (existing) {
      const oldKey = existing.fileKey;
      Object.assign(existing, fields);
      form = await existing.save();
      // The old file is no longer reachable; clearing it is best effort.
      if (oldKey && oldKey !== uploaded.fileKey) {
        s3Delete(oldKey).catch((e) =>
          console.error("S3 delete of replaced form failed:", e)
        );
      }
    } else {
      form = await Form.create({ title, ...fields });
    }

    return res.status(existing ? 200 : 201).json({
      success: true,
      message: existing ? "Form replaced" : "Form uploaded",
      data: toMeta(form),
    });
  } catch (error) {
    console.error("Error uploading form:", error);
    return res.status(500).json({ success: false, message: "Failed to upload form" });
  }
};

/** DELETE /forms/:id - admin only. */
export const deleteForm = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ success: false, message: "Form not found" });
    }
    const form = await Form.findByIdAndDelete(id);
    if (!form) {
      return res.status(404).json({ success: false, message: "Form not found" });
    }
    let warning;
    try {
      await s3Delete(form.fileKey);
    } catch (e) {
      console.error("S3 delete failed after form removal:", e);
      warning = "Form removed, but its file could not be deleted from storage";
    }
    return res.status(200).json({
      success: true,
      message: "Form deleted",
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    console.error("Error deleting form:", error);
    return res.status(500).json({ success: false, message: "Failed to delete form" });
  }
};
