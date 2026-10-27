import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { uploadFileToS3, getS3TemporaryUrl, downloadS3File } from './services/tdS3Service.js';
import { checkMailHealth, sendMail } from './services/tdMailService.js';

const limitMessage = { error: { code: 'RATE_LIMIT', message: 'Demasiadas solicitudes a TD. Intenta más tarde.' } };
const writeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: limitMessage });

function sendResult(res, result) {
  if (result.success) return res.json(result);
  const status = result.error?.status;
  const localValidation = /^(INVALID_|MISSING_|FILE_TOO_LARGE)/.test(result.error?.code || '');
  const responseStatus = localValidation ? result.error?.code === 'FILE_TOO_LARGE' ? 413 : 422 : result.error?.code === 'TD_NOT_CONFIGURED' ? 503 : status >= 400 && status < 500 ? status : 502;
  return res.status(responseStatus).json(result);
}

export function mountTdRoutes(app, prefix, requireAdmin, { enabled = true, s3 = { uploadFileToS3, getS3TemporaryUrl, downloadS3File }, mail = { checkMailHealth, sendMail } } = {}) {
  const root = `${prefix}/integrations/td`;
  const realMode = (_req, res, next) => enabled ? next() : res.status(409).json({ success: false, message: 'La integración TD no está disponible en modo demostración.', data: null, error: { code: 'DEMO_MODE' } });
  app.post(`${root}/s3/upload`, requireAdmin, realMode, writeLimiter, express.json({ limit: '50mb' }), async (req, res) => sendResult(res, await s3.uploadFileToS3(req.body)));
  app.get(`${root}/s3/url`, requireAdmin, realMode, async (req, res) => sendResult(res, await s3.getS3TemporaryUrl({ s3Key: req.query.s3Key, expiresInSeconds: req.query.expiresInSeconds === undefined ? undefined : Number(req.query.expiresInSeconds) })));
  app.get(`${root}/s3/download`, requireAdmin, realMode, async (req, res) => {
    const result = await s3.downloadS3File({ s3Key: req.query.s3Key });
    if (!result.success) return sendResult(res, result);
    const type = result.data.contentType;
    res.attachment(req.query.s3Key);
    res.type(/^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream');
    return res.send(result.data.bytes);
  });
  app.get(`${root}/mail/health`, requireAdmin, realMode, async (_req, res) => sendResult(res, await mail.checkMailHealth()));
  app.post(`${root}/mail/send`, requireAdmin, realMode, writeLimiter, express.json({ limit: '50mb' }), async (req, res) => sendResult(res, await mail.sendMail(req.body)));
}
