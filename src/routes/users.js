import { Router } from "express";
import { getAuth } from "@clerk/express";
import { User } from "../models/User.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, roleFromClaims } from "../middleware/auth.js";

export const usersRouter = Router();
usersRouter.use(requireAuth);

usersRouter.get("/", asyncHandler(async (req, res) => {
  const auth = req.auth || getAuth(req);
  const currentUser = await User.findOne({ clerkUserId: auth.userId }).select("role").lean();
  if ((currentUser?.role || "customer") !== "admin") return res.status(403).json({ error: { code: "FORBIDDEN", message: "Admin access is required" } });
  const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10));
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || "50"), 10)));
  const [users, total] = await Promise.all([
    User.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(),
  ]);
  res.json({ users, page, limit, total });
}));

usersRouter.post("/sync", asyncHandler(async (req, res) => {
  const auth = req.auth || getAuth(req);
  const clerkUser = await req.app.locals.clerkClient.users.getUser(auth.userId);
  const primaryEmail = clerkUser.emailAddresses?.find((entry) => entry.id === clerkUser.primaryEmailAddressId)?.emailAddress || "";
  const update = {
    email: primaryEmail,
    phone: clerkUser.phoneNumbers?.find((entry) => entry.id === clerkUser.primaryPhoneNumberId)?.phoneNumber || "",
    firstName: clerkUser.firstName || "",
    lastName: clerkUser.lastName || "",
    role: ["customer", "supermarket", "admin"].includes(clerkUser.publicMetadata?.role) ? clerkUser.publicMetadata.role : roleFromClaims(auth.sessionClaims),
  };
  const user = await User.findOneAndUpdate({ clerkUserId: auth.userId }, { $set: update, $setOnInsert: { clerkUserId: auth.userId } }, {
    new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true,
  });
  res.json({ user });
}));

usersRouter.get("/me", asyncHandler(async (req, res) => {
  const auth = req.auth || getAuth(req);
  const user = await User.findOne({ clerkUserId: auth.userId }).lean();
  res.json({ user: user || null });
}));

usersRouter.patch("/me", asyncHandler(async (req, res) => {
  const auth = req.auth || getAuth(req);
  const allowed = ["firstName", "lastName", "phone"];
  const update = Object.fromEntries(allowed.filter((key) => typeof req.body?.[key] === "string").map((key) => [key, req.body[key].trim()]));
  const user = await User.findOneAndUpdate({ clerkUserId: auth.userId }, { $set: update, $setOnInsert: { clerkUserId: auth.userId } }, {
    new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true,
  });
  res.json({ user });
}));
