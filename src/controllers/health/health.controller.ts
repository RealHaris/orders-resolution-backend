import type { NextFunction, Request, Response } from "express";

/**
 * Controller for the public health endpoint.
 */
class HealthController {
  /**
   * GET /api/health
   */
  async get(_req: Request, res: Response, next: NextFunction) {
    try {
      return res.json({ success: true, data: { ok: true } });
    } catch (error) {
      next(error);
    }
  }
}

export const healthController = new HealthController();
