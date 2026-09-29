import mongoose from "mongoose";

/**
 * Forms repository (29.09, reply Q2): blank forms - vendor undertakings and
 * the like - uploaded by Admin and downloadable by every team from the
 * Reports tab. One document per title; no versions, a re-upload under the
 * same title replaces the file ("Latest will be available to download").
 *
 * The bytes live on S3, the same bucket bill attachments use (utils/s3.js).
 */
const formSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    fileKey: { type: String, required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Unique regardless of case, so "Vendor Undertaking" and "vendor undertaking"
// are the same form and a re-upload replaces rather than duplicates.
formSchema.index(
  { title: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } }
);

const Form = mongoose.model("Form", formSchema);

export default Form;
