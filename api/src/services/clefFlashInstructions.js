export const CLEF_FLASH_DECISION_INSTRUCTIONS_VERSION = 'clef-flash-decisions-1';

// Clarify the existing binary contract before generation. Never infer a value
// from the model's reason or rewrite an abstention after receiving its answer.
export const clefFlashDecisionInstructions = `Decisión de flags binarios: «evaluado» significa que pudiste decidir, no que encontraste el evento.
- Evento presente: status="evaluado", value=1, motivo breve y evidencia real.
- Evento ausente: si los mensajes relevantes están disponibles y la conducta definida no aparece, status="evaluado", value=0, motivo breve y evidence_message_ids=[]. La mera ausencia de evidencia positiva no es contexto insuficiente. En ese caso, motivos como «No hay evidencia de enojo» o «No hay evidencia de falta de respeto» corresponden a value=0.
- Contexto insuficiente: status="no_evaluado", value=null y evidence_message_ids=[] solo cuando un impedimento concreto evita decidir. En el motivo identifica qué contenido o dato necesario falta, por ejemplo un audio no transcrito que contiene la intervención relevante, o un dato indispensable para la condición de la variable. No inventes ausencia si falta ese material.
Ejemplos sintéticos para distinguir estados (no son resultados de la conversación recibida):
1. Flag de insultos: el texto relevante está completo y solo contiene un intercambio cordial. Resultado: evaluado, 0; motivo: «En los mensajes disponibles no aparecen insultos».
2. Flag de insultos: el texto relevante contiene un insulto explícito. Resultado: evaluado, 1; cita el ID real del mensaje que lo contiene.
3. Flag de insultos: la intervención relevante está en un audio sin transcripción. Resultado: no_evaluado, null; motivo: «Falta la transcripción del audio necesario para decidir».
Decide cada variable de forma independiente según su definición, actor y condición. No copies las decisiones de los ejemplos. Esta aclaración se aplica solo a flags binarios; los descriptores conservan sus tipos y categorías. Mantén las reglas anteriores para conversaciones abiertas y contenido no visible.`;
