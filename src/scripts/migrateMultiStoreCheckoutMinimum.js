import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

function renameThreshold(collection) {
  return collection.updateMany(
    { minimumStoreSubtotalKobo: { $exists: true }, multiStoreCheckoutMinimumKobo: { $exists: false } },
    { $rename: { minimumStoreSubtotalKobo: "multiStoreCheckoutMinimumKobo" } },
  );
}

function removeLegacyThreshold(collection) {
  return collection.updateMany(
    { minimumStoreSubtotalKobo: { $exists: true } },
    { $unset: { minimumStoreSubtotalKobo: "" } },
  );
}

try {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required to run the settings migration.");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const settings = mongoose.connection.collection("platformsettings");
  const parentOrders = mongoose.connection.collection("parentorders");

  for (const collection of [settings, parentOrders]) {
    await renameThreshold(collection);
    await removeLegacyThreshold(collection);
  }

  console.log("Multi-store checkout threshold migration complete. Existing values were preserved; rerunning is safe.");
} finally {
  await mongoose.disconnect();
}
