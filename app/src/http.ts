import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, ZodError, type ZodTypeAny } from 'zod';
import { WahaError } from './waha.js';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra?: Record<string, unknown>) {
    super(message ?? code);
  }
}

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  return schema.parse(data);
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'invalid_request', message: 'Pedido inválido', issues: err.issues });
    return;
  }
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    return;
  }
  if (err instanceof WahaError) {
    const status = err.status === 401 ? 502 : err.status >= 500 ? 502 : err.status;
    res.status(status).json({ error: 'waha_error', message: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: 'Erro interno' });
}
