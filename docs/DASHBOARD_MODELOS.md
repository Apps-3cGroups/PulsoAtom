# Dashboard ejecutivo de Clef y Gemma

Ruta web: `/pulsoAtom/modelos`. Consulta: `GET /pulsoAtom/api/model-dashboard`. Ambas requieren administrador. La consulta no ejecuta IA, no modifica resultados y no requiere una migración. Si un agregado permite identificar la respuesta de una sola conversación, se registra la exposición para que una validación posterior de ese usuario sea asistida. Los cambios se integran en los servidores web y API existentes.

## Base de comparación

La selección inicial prioriza los perfiles `clef-local` (Clef) y `gemma-local` (Gemma), con sus identificadores y configuraciones guardadas. Las etiquetas se obtienen de los perfiles; los resultados históricos de GPT o Gemini conservan su identidad.

- Usa la última ejecución **operativa comparable** por conversación dentro del período y país elegidos. La pantalla ofrece filtros por período y país.
- Incluye el complemento histórico Gemma/Clef únicamente si conserva el enlace explícito y la procedencia validada de la evaluación operativa original. Una muestra de laboratorio genérica no se convierte en ejecución operativa.
- Ambos perfiles deben tener tareas con la misma huella de contenido, catálogo, instrucciones y reglas. Las configuraciones históricas permanecen separadas en los selectores.
- Los filtros de fecha son inclusivos y se aplican a la creación de la ejecución, en la zona horaria del portal.
- Abre los últimos siete días. En demostración, el período se ancla a la última carga sintética. Restablecer el período conserva la pareja de modelos seleccionada.
- El denominador se reconstruye con las versiones activas del checklist guardado: únicamente flags de IA o IA + código. El catálogo v5 incluye 47 flags activos de IA, pero el dashboard no fija ese número ni aplica el catálogo actual al histórico.
- Una tarea fallida o pendiente conserva sus flags solicitados en el denominador. Una respuesta de respaldo no se atribuye al modelo solicitado. Las reglas de código compartidas no cuentan como respuestas de IA; en un resultado híbrido se utiliza la respuesta original de IA cuando está guardada.
- Se excluyen pares con contexto incompatible o versiones del catálogo faltantes. El dashboard muestra las conversaciones sin par y los pares sin tiempos. Las muestras del laboratorio se consultan en su pantalla existente y no se mezclan con la operación.

## Indicadores

| Indicador | Cálculo |
| --- | --- |
| Cobertura de evaluación | Flags con respuesta válida 0 o 1 / flags de IA solicitados. Incluye promedio de flags con conclusión por conversación y total acumulado. No mide exactitud ni certeza. |
| Tiempo promedio | Media del tiempo acumulado registrado de cada evaluación. |
| Respuesta más rápida / lenta | Mínimo / máximo del tiempo registrado por modelo. |
| Evaluaciones completas | Tareas completadas con resultado compatible / conversaciones comparables. Completar la tarea no significa que todos los flags tengan conclusión. |
| Evaluaciones incompletas | Conversaciones comparables menos evaluaciones completadas. Incluye fallos, parciales y pendientes de terminar. |

Los tres KPIs de tiempo usan exactamente las mismas conversaciones: ambos modelos deben tener tiempos finitos registrados y evaluaciones completadas o parciales. `durationMs` acumula llamadas y reintentos, no espera en cola ni tiempo del asesor al cliente. Una medición ausente se muestra como **Sin datos**, nunca como cero. El cero registrado se conserva.

## Presentación y verificación

Estado de esta entrega: pruebas automatizadas y revisión visual con datos sintéticos aprobadas. La validación completa del dashboard contra las evaluaciones reales de Clef y Gemma sigue pendiente; la captura no contiene métricas reales.

La integración con main tras el PR #28 se documenta en [QA_PR27_INTEGRACION.md](QA_PR27_INTEGRACION.md).

Los seis KPIs reutilizan el mismo componente de barras, orden y colores, en dos filas de tres tarjetas. Cada pareja comparte escala desde cero; porcentajes siempre de 0 a 100 %. La dirección favorable se indica en texto. La pantalla se limita al rendimiento global de los modelos: no incluye desglose por flag, tablas técnicas, enlaces a conversaciones ni acceso al laboratorio. Solo los filtros se abren en un panel lateral. El diseño se adapta a pantallas pequeñas.

Verificación automatizada: pruebas de fórmulas, fallos/parciales, datos ausentes, deduplicación, filtros de fecha local, aislamiento de laboratorio y código, dictámenes humanos, permisos, exposición de agregados individualizables y ausencia de cambios en resultados o llamadas a IA. También se comprueba la recarga de la nueva ruta bajo `/pulsoAtom`.

La vista previa visual utiliza datos sintéticos aislados y lo indica expresamente; sus duraciones no son un benchmark real de Clef o Gemma.
