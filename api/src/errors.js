export class AppError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR', details) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
export const missingDatabase = () => new AppError(503, 'Configura la base propia de Pulso y ejecuta las migraciones para continuar.', 'DATABASE_UNAVAILABLE');

// Retain only an allowlisted infrastructure code, never driver SQL or credentials.
const transientDatabaseCodes = new Set(['ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST']);
export function databaseError(error) {
  if (error instanceof AppError || !transientDatabaseCodes.has(error?.code)) return error;
  return new AppError(503, 'La base de datos no respondió a tiempo. Se reintentará la evaluación.', 'DATABASE_TRANSIENT', { databaseCode: error.code });
}
