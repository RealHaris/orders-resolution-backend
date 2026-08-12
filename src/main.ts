import "dotenv/config";

import { Constants } from "@/config/constants";
import { logger } from "@/config/logger.config";
import { connectToDB } from "@/utils/db/db-conn";

import { createApp } from "./app";

connectToDB();

const app = createApp();
const PORT = process.env.PORT || Constants.DEFAULT_PORT;
app.set("port", PORT);

/** Logs when the HTTP server is listening. */
const onServerListen = () => {
  logger.info(
    {
      environment: process.env.NODE_ENV,
      port: app.get("port"),
    },
    "Express server started"
  );
};

app.listen(PORT, onServerListen);
