export const canReviewVariable = (conversation, variable) => conversation.evaluated && variable.enabledInEvaluation
  && (variable.result.status === 'evaluado' || variable.review)
  && ['Flag', 'Calculado'].includes(variable.type)
  && (['negativo', 'positivo', 'contexto'].includes(variable.polarity) || variable.type === 'Flag');

export const nextReviewAction = variable => variable.review ? 'deshacer'
  : variable.result.value === 1 && variable.automaticFlagVisible !== false ? 'refutar' : 'levantar';
