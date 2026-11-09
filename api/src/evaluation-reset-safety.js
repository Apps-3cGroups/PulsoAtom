import { AppError } from './errors.js';
import { gemmaBackfillProfile } from './gemma-backfill.js';
import { evaluationContext } from './evaluation-context.js';
import { catalogAvailability } from './catalog-presentation.js';

const fail = (code, message) => { throw new AppError(409, message, code); };
const guardFlags = new Map([
  ['--expected-policy-version', 'policyVersion'], ['--expected-configuration-hash', 'configurationHash'],
  ['--expected-catalog-hash', 'catalogHash'], ['--expected-prompt-hash', 'promptHash'],
]);

export function parseEvaluationResetArguments(args) {
  const seen = new Set(), values = {};
  let apply = false, restore = null, expectedEvaluations = null;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (seen.has(argument)) fail('INVALID_ARGUMENTS', 'No repitas argumentos del reinicio.');
    seen.add(argument);
    if (argument === '--apply') { apply = true; continue; }
    if (!['--restore', '--expected-evaluations', ...guardFlags.keys()].includes(argument)) fail('INVALID_ARGUMENTS', 'Argumento no admitido por el reinicio respaldado.');
    const value = args[++index];
    if (!value || value.startsWith('--')) fail('INVALID_ARGUMENTS', 'Falta un valor requerido para el reinicio.');
    if (argument === '--restore') { restore = value; continue; }
    if (argument === '--expected-evaluations') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID_ARGUMENTS', 'El conteo esperado debe ser un entero no negativo.');
      expectedEvaluations = Number(value); continue;
    }
    const key = guardFlags.get(argument);
    if (key === 'policyVersion') {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID_ARGUMENTS', 'La versión esperada debe ser un entero positivo.');
      values[key] = Number(value);
    } else {
      if (!/^[a-f0-9]{64}$/.test(value)) fail('INVALID_ARGUMENTS', 'Las huellas esperadas deben tener formato SHA-256.');
      values[key] = value;
    }
  }
  const count = Object.keys(values).length;
  if (count && count !== guardFlags.size) fail('INCOMPLETE_RESET_GUARDS', 'Indica juntas las versiones de política y huellas de modelo, catálogo e instrucciones.');
  if (restore && (count || expectedEvaluations !== null)) fail('INVALID_ARGUMENTS', 'La restauración no admite condiciones de una nueva limpieza.');
  if (apply && !restore && expectedEvaluations === null) fail('EXPECTED_COUNT_REQUIRED', 'Indica --expected-evaluations con el conteo auditado antes de limpiar.');
  return { apply, restore, expectedEvaluations, guards: count ? values : null };
}

// The caller must read these persisted rows while holding app_lock. Never build
// metadata from the local environment: the actual database must identify itself.
export function assertGemmaResetPreconditions(state, registry, expected) {
  if (!expected) return;
  const { profile, policyVersion } = gemmaBackfillProfile(state, registry);
  if (state.settings.dailyEnabled !== false) fail('DAILY_MUST_BE_PAUSED', 'Pausa la programación diaria antes de respaldar y limpiar.');
  if (state.settings.evaluationMaintenance) fail('EVALUATION_MAINTENANCE', 'Ya existe un mantenimiento; no se limpia de nuevo.');
  if ((state.jobs || []).some(job => ['running', 'queued', 'pending'].includes(job.status))) fail('EVALUATION_RUNNING', 'Hay evaluaciones activas o en cola; no se modifica el histórico.');
  const active = state.catalog.filter(variable => variable.active);
  if (!active.length || active.some(variable => !catalogAvailability(variable).canActivate)) fail('UNSUPPORTED_VARIABLE', 'El checklist activo está vacío o contiene variables no implementadas.');
  if (policyVersion !== expected.policyVersion) fail('POLICY_CHANGED', 'La política cambió después de la comprobación aprobada.');
  if (profile.configurationHash !== expected.configurationHash) fail('MODEL_CHANGED', 'La configuración de Gemma cambió después de la comprobación aprobada.');
  const context = evaluationContext({ id: 'reset-contract-only', messages: [] }, state.catalog);
  if (context.catalogHash !== expected.catalogHash) fail('CATALOG_CHANGED', 'El catálogo cambió después de la comprobación aprobada.');
  if (context.promptHash !== expected.promptHash) fail('PROMPT_CHANGED', 'Las instrucciones cambiaron después de la comprobación aprobada.');
}
