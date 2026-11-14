import dotenv from "dotenv";
import argon2 from "argon2";
import { connectDatabase } from "../config/database.js";
import { User } from "../models/User.js";

dotenv.config();
const email = String(process.env.GOSHOPPER_ADMIN_EMAIL || "").trim().normalize("NFKC").toLowerCase();
const password = process.env.GOSHOPPER_ADMIN_PASSWORD || "";
const phone = String(process.env.GOSHOPPER_ADMIN_PHONE || "").trim();
if (!email || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12 || !phone) throw new Error("Set GOSHOPPER_ADMIN_EMAIL, GOSHOPPER_ADMIN_PHONE, and a GOSHOPPER_ADMIN_PASSWORD of at least 12 characters.");
await connectDatabase(process.env.MONGODB_URI);
const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
const existing = await User.findOne({ email });
if (existing && existing.role !== "admin") throw new Error("That email is already assigned to a non-admin account; review it manually before provisioning.");
if (existing) {
  existing.passwordHash = passwordHash; existing.phone = phone; existing.emailVerified = true; existing.phoneVerified = true; existing.approvalStatus = "approved"; await existing.save();
} else {
  await User.create({ email, phone, firstName: "Go-Shopper", lastName: "Administrator", passwordHash, emailVerified: true, phoneVerified: true, role: "admin", approvalStatus: "approved" });
}
console.log("Administrator account provisioned. Password was not printed.");
process.exit(0);
