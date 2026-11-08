import mongoose from "mongoose";
import { ParentOrder } from "../models/ParentOrder.js";
import { SubOrder } from "../models/SubOrder.js";

export async function connectDatabase(uri) {
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  await Promise.all([ParentOrder.init(), SubOrder.init()]);
  console.log("MongoDB connected");
}
