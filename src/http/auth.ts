import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";

export function requireBearerToken(req: Request, res: Response, next: NextFunction): void {
  const authorization = req.header("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";

  if (token !== env.ECHOLINK_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
}
