import mongoose from "mongoose";

const applicationSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true, index: true },
  type: { type: String, enum: ["supermarket", "rider"], required: true, index: true },
  applicantUserId: { type: String, required: true, index: true },
  status: { type: String, enum: ["pending_review", "under_review", "needs_information", "approved", "rejected", "withdrawn"], default: "pending_review", index: true },
  active: { type: Boolean, default: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  feedback: { type: String, trim: true, maxlength: 1000, default: "" },
  reviewerNotes: { type: String, trim: true, maxlength: 2000, default: "" },
  history: [{ status: { type: String, required: true }, actorUserId: { type: String, required: true }, message: { type: String, trim: true, maxlength: 1000, default: "" }, createdAt: { type: Date, default: Date.now } }],
  provisionedStoreId: { type: mongoose.Schema.Types.ObjectId, ref: "Store", default: null },
  provisionedUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

applicationSchema.index({ applicantUserId: 1, type: 1, createdAt: -1 });
applicationSchema.index({ type: 1, status: 1, createdAt: -1 });
applicationSchema.index({ applicantUserId: 1, type: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });

export const OnboardingApplication = mongoose.model("OnboardingApplication", applicationSchema);
