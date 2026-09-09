import mongoose from "mongoose";
import { asValidator } from "../constants/fieldFormats.js";

const vendorMasterSchema = new mongoose.Schema(
  {
    // col 6 - "numeric 6 digits". Enforced here so the import path cannot
    // create shorter numbers (observations, Imports #6.iii).
    vendorNo: {
      type: Number,
      unique: true,
      required: true,
      validate: asValidator("vendorNo"),
    },
    vendorName: { type: String, required: true },
    PAN: { type: String },
    GSTNumber: { type: String },
    complianceStatus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ComplianceMaster",
      required: true,
    },
    PANStatus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PanStatusMaster",
      required: true,
    },
    emailIds: { type: [String], required: true },
    phoneNumbers: { type: [String], required: true },
    addl1: { type: String, default: "" },
    addl2: { type: String, default: "" },
  },
  { timestamps: true }
);

const VendorMaster = mongoose.model("VendorMaster", vendorMasterSchema);

export default VendorMaster;