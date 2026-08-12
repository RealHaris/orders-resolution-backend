import mongoose from "mongoose";

import { Constants } from "@/config/constants";
import { logger } from "@/config/logger.config";
import { maskConnectionStringCredentials } from "@/utils/logging/mask-sensitive-value.utils";

/**
 * Connection pool options for the primary MongoDB connection.
 */
const getConnectionOptions = (): mongoose.ConnectOptions => ({
  maxPoolSize:
    Number(process.env.MONGO_MAX_POOL_SIZE) || Constants.MONGO_MAX_POOL_SIZE,
  minPoolSize:
    Number(process.env.MONGO_MIN_POOL_SIZE) || Constants.MONGO_MIN_POOL_SIZE,
  maxIdleTimeMS: Constants.MONGO_MAX_IDLE_TIME_MS,
});

/**
 * Opens the primary MongoDB connection.
 */
export const connectToDB = () => {
  const mongoDB_URI = process.env.MONGODB_URI;
  if (!mongoDB_URI) {
    throw new Error("MONGODB_URI is not set");
  }
  const maskedMongoDbUri = maskConnectionStringCredentials(mongoDB_URI);
  logger.info({ mongoDbUri: maskedMongoDbUri }, "MongoDB connection string");
  mongoose.connect(mongoDB_URI, getConnectionOptions());
};

const db = mongoose.connection;

/** Logs MongoDB driver connection errors. */
const onDbConnectionError = (error: Error) => {
  logger.error({ err: error }, "MongoDB connection error");
};

/** Logs when the primary MongoDB connection is ready. */
const onDbConnectionOpen = () => {
  logger.info("Mongo DB connected");
};

db.on("error", onDbConnectionError);
db.once("open", onDbConnectionOpen);
