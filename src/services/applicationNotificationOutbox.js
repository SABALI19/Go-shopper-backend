import { NotificationOutbox } from "../models/NotificationOutbox.js";
import { sendAuthEmail } from "./authNotifications.js";

export async function enqueueApplicationEmail({ key, kind, to, subject, text, html }, Model = NotificationOutbox) {
  if (!to || !subject) return null;
  return Model.updateOne({ idempotencyKey: key }, { $setOnInsert: { idempotencyKey: key, kind, to, subject, text, html, status: "pending", attempts: 0, nextAttemptAt: new Date() } }, { upsert: true });
}

export function startApplicationNotificationWorker({ intervalMs = 10_000, batchSize = 10, Model = NotificationOutbox, deliver = sendAuthEmail } = {}) {
  let stopped = false;
  let running = false;
  const drain = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (let i = 0; i < batchSize && !stopped; i += 1) {
        const now = new Date();
        const job = await Model.findOneAndUpdate({ $or: [{ status: { $in: ["pending", "failed"] }, nextAttemptAt: { $lte: now }, attempts: { $lt: 8 } }, { status: "sending", updatedAt: { $lt: new Date(now.getTime() - 5 * 60_000) } }] }, { $set: { status: "sending" }, $inc: { attempts: 1 } }, { sort: { createdAt: 1 }, new: true }).select("+to +subject +text +html");
        if (!job) break;
        try {
          const accepted = await deliver({ to: job.to, subject: job.subject, text: job.text, html: job.html });
          if (!accepted) throw new Error("Email provider is not configured.");
          job.status = "sent"; job.acceptedAt = new Date(); job.lastError = undefined; await job.save();
        } catch (error) {
          job.lastError = String(error?.message || "Delivery failed").slice(0, 300);
          job.status = job.attempts >= 8 ? "failed" : "pending";
          job.nextAttemptAt = new Date(Date.now() + Math.min(6 * 60 * 60_000, 30_000 * (2 ** Math.min(job.attempts, 10))));
          await job.save();
        }
      }
    } finally { running = false; }
  };
  const timer = setInterval(() => { void drain().catch(() => {}); }, intervalMs);
  void drain().catch(() => {});
  return () => { stopped = true; clearInterval(timer); };
}
