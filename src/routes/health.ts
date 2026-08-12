import { Router } from "express";

import { healthController } from "@/controllers/health/health.controller";

const router = Router();

router.get("/", healthController.get.bind(healthController));

export default router;
