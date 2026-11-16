import dotenv from "dotenv";
import mongoose from "mongoose";
import { pathToFileURL } from "node:url";

dotenv.config();

export function legacyStoreStateMigrationPipeline() {
  return [
    {
      $set: {
        isOpen: { $eq: ["$isActive", true] },
        isSuspended: { $eq: ["$isActive", false] },
        suspensionReason: {
          $cond: [
            { $eq: ["$isActive", false] },
            {
              $cond: [
                { $ne: [{ $ifNull: ["$suspensionReason", ""] }, ""] },
                "$suspensionReason",
                "Legacy inactive store migrated as suspended",
              ],
            },
            "",
          ],
        },
        suspendedAt: {
          $cond: [
            { $eq: ["$isActive", false] },
            { $ifNull: ["$suspendedAt", "$$NOW"] },
            null,
          ],
        },
      },
    },
    { $unset: "isActive" },
  ];
}

export function legacyStoreStateMigrationFilter() {
  return { isActive: { $exists: true } };
}

export async function migrateStoreOpenAndSuspension(mongooseClient = mongoose) {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required.");
  await mongooseClient.connect(uri);
  try {
    const result = await mongooseClient.connection.collection("stores").updateMany(
      legacyStoreStateMigrationFilter(),
      legacyStoreStateMigrationPipeline(),
    );
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  } finally {
    await mongooseClient.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateStoreOpenAndSuspension()
    .then(({ matchedCount, modifiedCount }) => console.log(`Store state migration complete. Matched ${matchedCount}; modified ${modifiedCount}.`))
    .catch((error) => { console.error(`Store state migration failed: ${error.message}`); process.exitCode = 1; });
}
