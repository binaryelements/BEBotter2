import type { NextFunction, Request, Response } from "express";
import type { Actor } from "./access.js";

export type AdminLocals = { actor: Actor; csrf: string };

/** Set by the router's guard for every screen behind it. */
export const adminOf = (res: Response) => res.locals.admin as AdminLocals;

/** Express 4 does not catch rejected promises; send them to the router's error handler. */
export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    void fn(req, res, next).catch(next);
