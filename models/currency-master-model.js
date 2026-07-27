import mongoose from "mongoose";

const currencyMasterSchema = new mongoose.Schema(
  {
    currency: { type: String, required: true, unique: true, uppercase: true, },
  },
  { timestamps: true }
);

const CurrencyMaster = mongoose.model("CurrencyMaster", currencyMasterSchema);

export default CurrencyMaster;
