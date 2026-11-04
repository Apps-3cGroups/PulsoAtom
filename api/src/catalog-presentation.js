import { supportsCodeVariable } from './code-evaluator.js';
import { supportsAiVariable } from './evaluator.js';

// Presentation is derived from the saved definition, never from today's catalog.
export function classificationOf(variable) {
  if (!['Flag', 'Calculado'].includes(variable.type)) return null;
  if (variable.mark === '+' || variable.polarity === 'positivo') return 'positive';
  return ['Crítico', 'P1'].includes(variable.mark) ? 'critical' : 'normal';
}

export function catalogAvailability(variable) {
  const pending = {
    primera_respuesta_humano_mayor_5_min: 'Pendiente de configurar el horario de atención por país.',
    varios_humanos_atendieron: 'Atom aún no entrega la identidad del agente en cada mensaje.',
    botones_no_usados: 'Atom aún no entrega los botones ofrecidos y seleccionados.',
  };
  // This legacy hybrid has a concrete shared rule in validateEvaluation; other
  // hybrids require external sources that are not implemented in this release.
  const implementedAi = supportsAiVariable(variable) && (variable.method === 'IA'
    || (variable.method === 'IA + código' && variable.id === 'asistente_no_respondio_ultimo_mensaje'));
  const canActivate = !variable.retired && variable.phase === 1 && (supportsCodeVariable(variable) || implementedAi);
  const reason = variable.retired ? 'Retirada del catálogo vigente; conservada para el histórico.'
    : variable.phase > 1 ? variable.condition || `Pendiente de implementar la fase ${variable.phase}.`
      : !canActivate ? 'Esta variable requiere una regla o integración que todavía no está implementada.' : pending[variable.id];
  return { status: reason ? 'pending' : 'available', reason: reason || null, canActivate };
}

export const currentCatalog = state => state.catalog.filter(v => !v.retired);
