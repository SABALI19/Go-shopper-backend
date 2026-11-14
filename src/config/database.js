import mongoose from "mongoose";
import { ParentOrder } from "../models/ParentOrder.js";
import { SubOrder } from "../models/SubOrder.js";
import { Product } from "../models/Product.js";

export async function connectDatabase(uri, {
  mongooseClient = mongoose,
  models = [ParentOrder, SubOrder, Product],
} = {}) {
  mongooseClient.set("strictQuery", true);
  await mongooseClient.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  await Promise.all(models.map((model) => model.init()));
  console.log("MongoDB connected");
}
