import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  clerkUserId: { type: String, required: true, unique: true, index: true },
  email: { type: String, trim: true, lowercase: true, default: "" },
  phone: { type: String, trim: true, default: "" },
  firstName: { type: String, trim: true, default: "" },
  lastName: { type: String, trim: true, default: "" },
  role: { type: String, enum: ["customer", "supermarket", "admin"], default: "customer", index: true },
}, { timestamps: true, versionKey: false });

export const User = mongoose.model("User", userSchema);
