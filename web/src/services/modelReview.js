// Only saved comparable AI flags belong in the side-by-side review. Metrics
// and shared calculations remain in their own conversation sections.
export function modelReviewVariables(variables = []) {
  const rank = variable => ({ 'agree-positive': 0, disagree: 1, incomplete: 2, 'agree-negative': 3 }[variable.result?.comparison?.agreement] ?? 4);
  return variables.filter(variable => ['Flag', 'Calculado'].includes(variable.type)
    && variable.enabledInEvaluation && variable.result?.comparison?.cells?.length
    && !variable.result.comparison.codeOnly && !['Código', 'Cálculo'].includes(variable.method))
    .sort((a, b) => rank(a) - rank(b) || (a.order ?? 0) - (b.order ?? 0));
}

export const modelReviewStatusLabel = status => ({
  completed: 'Revisión terminada', partial: 'Revisión terminada · con incidencias',
  failed: 'Revisión fallida', pending: 'Sin revisión guardada', running: 'Revisión en curso',
}[status] || 'Sin revisión guardada');

export const modelResultStatus = cell => {
  if (cell.error || cell.result?.error) return 'Error de evaluación';
  if (!cell.result) return cell.status === 'running' ? 'Revisión en curso' : 'Sin resultado guardado';
  if (cell.result.status !== 'evaluado') return 'Sin contexto suficiente';
  return cell.result.value === 1 ? 'Detecta el evento' : cell.result.value === 0 ? 'No detecta el evento' : 'Sin conclusión';
};
