# Modelos, comparación y validación de Pulso

## Flujo de uso

1. Resumen, Histórico, Búsqueda y Conversación muestran **un único resultado oficial** con los dictámenes humanos compatibles. No tienen selector de modelo ni accesos al comparativo. Los enlaces antiguos con `modelProfileId` vuelven a la vista oficial.
2. **Evaluaciones** es solo para administradores. Abre en **Evaluar conversaciones**, con lotes y programación diaria. En **Herramientas internas**, el administrador guarda el modelo principal y un respaldo distinto. Solo las ejecuciones nuevas toman esa política. Cada cambio conserva versión y autor.
3. El botón **Ver comparaciones guardadas** abre el laboratorio interno. Para comparar, configura al menos dos perfiles y crea una muestra de 1–20 conversaciones, con 2–3 modelos, país y período. También puedes elegir IDs concretos buscando en el selector. La selección aleatoria incluye casos históricos con y sin flags cuando ambos existen y el tamaño lo permite; no pretende estimar prevalencia de todo Atom.
4. La muestra fija miembros, contenido mediante SHA-256, checklist versionado, instrucciones y perfiles. Ningún modelo ve las respuestas de los demás. Los cálculos comunes se muestran aparte.
5. Entra a **Validar** antes de **Ver comparación**. Lee la transcripción y guarda todas las variables con evento presente, ausente o contexto insuficiente. Cada respuesta requiere motivo; un evento presente requiere un mensaje de evidencia.
6. Después de guardar puedes revelar solo ese caso y continuar con el siguiente sin exponer los restantes. Consultar predicciones equivalentes o revisar un dictamen previamente enviado identifica la revisión como **asistida**.
7. **Ver comparación** abre los resultados guardados. Filtra acuerdos, discrepancias, pendientes, prioridad o variable. Pulsa una fila para ver razones, citas y dictamen común.
8. En el historial de Evaluaciones, **Detalle** muestra intentos. **Reanudar pendientes y fallidos** conserva éxitos y verifica el origen. Un trabajo sin latido durante 10 minutos se identifica como interrumpido al consultar su estado.

Las refutaciones siguen disponibles en la vista rápida operativa. Los flags nuevos requieren leer la conversación completa o guardar un checklist completo en validación. El laboratorio y los endpoints de perfiles, comparaciones e intentos requieren administrador. Los supervisores conservan la revisión operativa y pueden guardar un dictamen a ciegas mediante el enlace de validación de una conversación, sin acceso a las predicciones comparativas.

## Configuración del backend

Mantener credenciales en `api/.env`, excluido de Git. No usar `VITE_*` para claves. La base propia (`APP_DB_*`) sigue separada del origen Atom (`ATOM_DB_*`).

Se conserva `OPENAI_MODEL` y la configuración existente. Gemini queda pendiente hasta completar:

```dotenv
GEMINI_API_KEY=
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_MODEL=
GEMINI_TIMEOUT_MS=120000
GEMINI_EVALUATION_ENABLED=false
```

Usar un ID de modelo que soporte el contrato de salida estructurada y habilitarlo únicamente al autorizar su uso. Reiniciar la API después de cambiar el entorno. No basta con elegir el perfil en la interfaz para configurarlo.

Sin `AI_MODEL_PROFILES` se registran `openai-default` y `gemini-default`. Se pueden definir hasta 12 perfiles mediante JSON; cada `envPrefix` apunta a variables `*_API_KEY`, `*_BASE_URL`, `*_TIMEOUT_MS` y `*_EVALUATION_ENABLED`. Mantener IDs estables y modelos exactos. Cada perfil conserva su revisión de configuración mediante una huella. Los valores de configuración y las claves no salen del backend.

```json
[
  {"id":"openai-default","label":"GPT","provider":"openai","model":"ID_EXACTO_OPENAI","envPrefix":"OPENAI"},
  {"id":"gemini-default","label":"Gemini","provider":"gemini","model":"ID_EXACTO_GEMINI","envPrefix":"GEMINI"}
]
```

Los adaptadores implementan `configured` y `evaluate(conversation, variables)`, devolviendo resultados normalizados, modelo efectivo, uso disponible e ID del proveedor. La integración local se incorporará con ese contrato cuando se defina infraestructura; no hay un endpoint local real habilitado.

## Acuerdo y métricas

- La unidad de acuerdo es conversación + variable sobre la muestra fijada. Cada modelo efectivo aporta como máximo un voto.
- Fallos, pendientes y abstenciones no son ceros. Si no hay votos comparables se indica expresamente.
- Las métricas de código no votan. Una regla híbrida que impone el resultado final tampoco aporta un voto independiente; se conservan la respuesta original de IA y la regla aplicada.
- Un dictamen común coincide por ID de conversación, huella de contenido y versión de variable. No modifica ni elimina predicciones.
- Precisión = verdaderos positivos / flags detectados. Detección de eventos = verdaderos positivos / eventos presentes según el humano. Se muestra el denominador y el tamaño de muestra.
- La calidad usa únicamente una cohorte compartida: todos los modelos con respuesta concluyente, origen sin cambios y último dictamen concluyente a ciegas. Las revisiones asistidas y el contexto insuficiente se excluyen. Denominadores vacíos se muestran sin porcentaje.
- El acuerdo no es una probabilidad de certeza y no determina un ganador. Los resultados de una muestra pequeña o estratificada no son una estimación global de calidad.

## Contingencia y límites

Operación: modelo principal → un reintento técnico → respaldo → un reintento técnico. Máximo cuatro intentos por tarea y ronda explícita. HTTP 408/429/5xx, falta de respuesta/timeout y JSON inválido son fallos reintentables. Errores de configuración, entrada no compatible, respuestas incompletas por límites y rechazos de seguridad requieren intervención; una abstención válida se guarda como resultado.

Comparación: solo el modelo solicitado y un reintento. No se sustituye una columna por otro modelo. Cada tarea guarda su resultado una sola vez y la clave de idempotencia evita repetir una solicitud enviada de nuevo. Una reanudación explícita crea otra ronda auditada sin reevaluar tareas completadas.

Manual: 20 conversaciones como máximo. Diario: 100, según el horario guardado. Los resultados comparativos jamás actualizan `operational_refs`. La programación diaria y OpenAI existentes no se modifican al migrar.

## API bajo la ruta base configurada

Los endpoints siguientes son relativos a `${BASE_PATH}/api`: `/pulso/api` para la prueba local y `/pulsoAtom/api` para el despliegue actual. Configurar `BASE_PATH` en la API y `VITE_BASE_PATH` / `VITE_API_BASE_URL` en web, y recompilar al cambiar el prefijo.

| Método y ruta | Uso |
| --- | --- |
| `GET /models` | Perfiles, disponibilidad y política vigente sin secretos. |
| `PATCH /models/policy` | Guardar principal/respaldo con `expectedVersion`; solo admin. |
| `GET /comparison-candidates` | País/período/búsqueda para selección manual; no devuelve predicciones. |
| `GET /comparisons` | Muestras guardadas. |
| `POST /comparisons` | Crear y ejecutar muestra; admin, `idempotencyKey` UUID. |
| `GET /comparisons/:id` | Metadatos sin predicciones. `reveal=true` registra exposición y devuelve resultados; `conversationId` limita el caso. |
| `GET /comparisons/:id/validation/:conversationId` | Transcripción y checklist con lista blanca de campos, sin respuestas de IA. |
| `POST /comparisons/:id/validation/:conversationId` | Dictamen completo y control de concurrencia por variable. |
| `GET /evaluations/:id/attempts` | Tareas e intentos persistidos. |
| `POST /evaluations/:id/resume` | Reanudación explícita, solo admin. |

`/summary`, `/conversations`, `/search` y `/conversations/:id` conservan la consulta técnica por `modelProfileId` solo para administradores. Las pantallas operativas siempre consultan sin ese parámetro y muestran el resultado oficial. Consultar predicciones registra exposición, nunca llama a IA. El endpoint operativo `POST /evaluations` acepta también `idempotencyKey`.

## Despliegue y pruebas

1. Instalar dependencias de `api/` y `web/` por separado.
2. Desde `api/`: `npm run db:migrate` antes de iniciar esta versión. En una instalación existente no repetir el seed. La migración 002 añade ocho tablas y fija referencias operativas sin reescribir resultados anteriores.
3. Ejecutar `npm test` en ambas carpetas y `npm run build` en `web/`.
4. Reiniciar API y servidor web. Recargar las rutas internas funciona bajo el prefijo configurado.

El workflow de producción existente omite los scripts de base de datos por diseño. Aplicar `npm run db:migrate` usando la conexión del servidor antes de desplegar esta versión; si comparte `dbPulsosAtom` con el ambiente validado, la migración 002 ya está registrada y el comando es idempotente. No se modificó esa política de despliegue.

Para una demo aislada, usar `DEMO_MODE=true` y opcionalmente `DEMO_FILE=/ruta/aislada.json`. Los perfiles GPT, Gemini y Local de demo generan resultados sintéticos identificados; no contactan a ningún proveedor. Nunca copiar ese archivo a la base real.

No se ejecutó una nueva comparación con datos reales en esta entrega. Falta configurar Gemini y escoger una muestra explícita para probar ambas conexiones reales. El adaptador Gemini y la contingencia se validaron con contratos y fallos simulados. Véase [QA de esta entrega](QA_MULTI_MODEL.md).

La arquitectura existente carga el histórico completo de Atom y documentos JSON de Pulso. Las evaluaciones/validaciones fuerzan lectura fresca para detectar cambios, lo que requiere dimensionar consultas e índices antes de cargas grandes. No se garantiza disponibilidad del origen o de proveedores externos; sus fallos quedan visibles.
