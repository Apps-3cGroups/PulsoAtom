import { z } from 'zod';
import { AppError } from './errors.js';

const fontScale = z.number().min(1).max(2).multipleOf(0.1);
export const appearanceUpdateSchema = z.object({
  fontScale,
  expectedVersion: z.number().int().positive().safe(),
}).strict();

export function appearanceSettings(settings) {
  const saved = settings?.appearance;
  return {
    fontScale: fontScale.safeParse(saved?.fontScale).success ? saved.fontScale : 1,
    version: Number.isSafeInteger(saved?.version) && saved.version > 0 ? saved.version : 1,
    ...(saved?.updatedBy ? { updatedBy: saved.updatedBy } : {}),
    ...(saved?.updatedAt ? { updatedAt: saved.updatedAt } : {}),
  };
}

export function updateAppearance(settings, input, userId, timestamp = new Date().toISOString()) {
  const previous = appearanceSettings(settings);
  if (previous.version !== input.expectedVersion) {
    throw new AppError(409, 'Otra persona modificó el tamaño de letra. Recarga la configuración antes de guardar.', 'VERSION_CONFLICT');
  }
  settings.appearance = { fontScale: input.fontScale, version: previous.version + 1, updatedBy: userId, updatedAt: timestamp };
  return settings.appearance;
}
