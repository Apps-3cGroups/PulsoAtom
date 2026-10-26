export class AppError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR', details) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
export const missingDatabase = () => new AppError(503, 'Configura la base propia de Pulso y ejecuta las migraciones para continuar.', 'DATABASE_UNAVAILABLE');
