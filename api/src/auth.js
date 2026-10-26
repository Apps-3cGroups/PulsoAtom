import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { AppError } from './errors.js';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, encoded) {
  const [scheme, salt, hex] = (encoded || '').split(':');
  if (scheme !== 'scrypt' || !salt || !/^[a-f0-9]{128}$/.test(hex || '')) {
    scryptSync(password, 'pulso-missing-user', 64);
    return false;
  }
  return timingSafeEqual(Buffer.from(hex, 'hex'), scryptSync(password, salt, 64));
}
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const publicUser = ({ id, name, email, role }) => ({ id, name, email, role });
export function requireUser(req, _res, next) {
  if (!req.user) return next(new AppError(401, 'Inicia sesión para continuar.', 'UNAUTHENTICATED'));
  next();
}
export function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin') return next(new AppError(403, 'Solo un administrador puede realizar esta acción.', 'FORBIDDEN'));
  next();
}
