# Modelos, comparación y validación de Pulso

## Flujo de uso

1. Resumen, Histórico, Búsqueda y Conversación muestran **un único resultado oficial** con los dictámenes humanos compatibles. No tienen selector global de modelo. Cada flag con doble revisión permite abrir las columnas de sus dos modelos; el laboratorio de muestras permanece en administración. Los enlaces antiguos con `modelProfileId` vuelven a la vista oficial.
2. **Evaluaciones** es solo para administradores. Abre en **Evaluar conversaciones**, con lotes y programación diaria. En **Herramientas internas**, el administrador elige entre principal con respaldo o doble revisión con un segundo modelo distinto. Solo las ejecuciones nuevas toman esa política. Cada cambio conserva versión y autor.
3. El botón **Ver comparaciones guardadas** abre el laboratorio interno. Para comparar, configura al menos dos perfiles y crea una muestra de 1–20 conversaciones, con 2–3 modelos, país y período. También puedes elegir IDs concretos buscando en el selector. La selección aleatoria incluye casos históricos con y sin flags cuando ambos existen y el tamaño lo permite; no pretende estimar prevalencia de todo Atom.
4. La muestra fija miembros, contenido mediante SHA-256, checklist versionado, instrucciones y perfiles. Ningún modelo ve las respuestas de los demás. Los cálculos comunes se muestran aparte.
5. Entra a **Validar** antes de **Ver comparación**. Lee la transcripción y guarda todas las variables con evento presente, ausente o contexto insuficiente. Cada respuesta requiere motivo; un evento presente requiere un mensaje de evidencia.
6. Después de guardar puedes revelar solo ese caso y continuar con el siguiente sin exponer los restantes. Consultar predicciones equivalentes o revisar un dictamen previamente enviado identifica la revisión como **asistida**.
7. **Ver comparación** abre los resultados guardados. Filtra acuerdos, discrepancias, pendientes, prioridad o variable. Pulsa una fila para ver razones, citas y dictamen común.
8. En el historial de Evaluaciones, **Detalle** muestra intentos. **Reanudar pendientes y fallidos** conserva éxitos y verifica el origen. Un trabajo sin latido durante 10 minutos se identifica como interrumpido al consultar su estado.

Las refutaciones se realizan desde la vista de conversación, a la que se accede directamente al pulsar una conversación en el dashboard. Los flags nuevos requieren leer la conversación completa o guardar un checklist completo en validación. El laboratorio y los endpoints de perfiles, comparaciones e intentos requieren administrador. Los supervisores conservan la revisión operativa y pueden guardar un dictamen a ciegas mediante el enlace de validación de una conversación, sin acceso al laboratorio administrativo. En el detalle operativo sí pueden consultar las dos respuestas del flag.

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

Los adaptadores implementan `configured` y `evaluate(conversation, variables)`, devolviendo resultados normalizados, modelo efectivo, uso disponible e ID del proveedor. `GatewayEvaluator` implementa ese contrato para modelos locales, sin usar directamente sus direcciones privadas. Su conexión real requiere las credenciales, herramienta y modelo exactos del Gateway.

## Clef y Gemma mediante GatewayAgents

Todo el consumo sale del backend: `GET /v1/tools` descubre las herramientas y `POST /v1/tools/{toolKey}/invoke` invoca las rutas documentadas de modelos y Chat Completions. El token compartido solo se envía como `X-Gateway-Token`; no se expone a React, logs ni respuestas de Pulso. `portal_key` debe ser el identificador real asignado al portal. Pulso no sigue redirecciones ni utiliza la URL privada devuelta por el catálogo como destino de red.

La identidad de este portal es `portal-pulso`, también usada por defecto cuando `GATEWAY_PORTAL_KEY` no existe. Para consultar el Gateway desde el servidor sin copiar sus credenciales ni ejecutar evaluaciones, situarse en `api/` y usar:

```sh
node scripts/discover-local-models.js
node scripts/discover-local-models.js --tool CLAVE_EXACTA_DEL_CATALOGO
```

El primer comando imprime únicamente claves y estados de herramientas. El segundo consulta los IDs exactos de modelos de una herramienta activa y su `request_uuid`. Lee el `.env` del servidor, no imprime el token ni URLs internas y no accede a la base de datos. Usar los nombres descubiertos para completar los perfiles siguientes antes de preparar o aplicar el piloto.

Configurar en `api/.env`:

```dotenv
AI_MODEL_PROFILES=[{"id":"clef-local","label":"Clef","provider":"gateway","envPrefix":"CLEF"},{"id":"gemma-local","label":"Gemma","provider":"gateway","envPrefix":"GEMMA"}]
GATEWAY_BASE_URL=
AGENT_SHARED_TOKEN=
GATEWAY_PORTAL_KEY=portal-pulso
CLEF_TOOL_KEY=
CLEF_MODEL=
CLEF_EVALUATION_ENABLED=true
GEMMA_TOOL_KEY=gemma
GEMMA_MODEL=gemma-4-26b-a4b-it-mlx
GEMMA_EVALUATION_ENABLED=true
OPENAI_EVALUATION_ENABLED=false
GEMINI_EVALUATION_ENABLED=false
```

Confirmar los IDs exactos con DevOps y `/v1/models` del Gateway. Ambos modelos usan el mismo Gateway y la identidad de auditoría `portal-pulso`. La guía recibida documenta Gemma; no se presupone la herramienta ni el modelo Clef. Los demás ajustes están en `api/.env.example`: timeout máximo de 180 segundos por intento, temperatura, límite de salida y formato `json_schema` o `json_object`. El formato se elige explícitamente según lo que soporte el servicio, sin degradarlo automáticamente. La respuesta debe informar el mismo modelo solicitado. Una identidad distinta, una negativa de seguridad o un error de configuración no se convierten en un resultado válido.

Estos perfiles reemplazan el registro de proveedores públicos; incluso si quedan claves antiguas en el entorno, las tareas del piloto solo pueden seleccionar los dos perfiles locales. La configuración guardada en MySQL se cambia a doble revisión al aplicar el piloto. El resultado conserva el `request_uuid` del Gateway como ID de respuesta para auditoría y el uso numérico disponible. La coincidencia requiere dos modelos efectivos distintos y resultados equivalentes; fallos, abstenciones y código no aportan votos adicionales.

### Piloto controlado y limpieza respaldada

El despliegue no borra ni evalúa datos por sí solo. Esta secuencia se ejecuta únicamente cuando se haya solicitado la limpieza. Desde `api/`, con el entorno real y la nueva versión disponibles:

1. `node scripts/evaluate-local-pilot.js --plan`: comprueba el catálogo del Gateway, los modelos y dos respuestas sintéticas; después fija las cinco conversaciones más recientes por **última actividad**, incluidas las abiertas. Guarda un manifiesto local con permisos `0600`, IDs, huellas y versiones, sin transcripciones. No modifica MySQL ni evalúa conversaciones reales.
2. `node scripts/reset-evaluations.js`: consultar los totales antes de limpiar. No continuar si hay una ejecución activa o falló el preflight.
3. `node scripts/reset-evaluations.js --apply --expected-evaluations TOTAL_VERIFICADO`: crea y comprueba un respaldo con SHA-256; después limpia las tablas de evaluaciones, revisiones y comparaciones bajo transacción. Conserva Atom, catálogo, usuarios y sesiones. Pausa el diario y devuelve `maintenanceId`. Guardar el respaldo en almacenamiento protegido y duradero antes de retirar la copia de trabajo.
4. `node scripts/evaluate-local-pilot.js --apply --manifest RUTA_MANIFIESTO --maintenance-id ID_MANTENIMIENTO`: repite el preflight sintético, valida que la muestra y el catálogo no hayan cambiado, guarda la política dual Clef/Gemma sin respaldo público y ejecuta exactamente cinco conversaciones (diez tareas), con concurrencia uno.
5. Si hay resultados parciales, usar `--resume` con los mismos argumentos. Conserva resultados válidos, reintenta solo pendientes y solo reanuda el mantenimiento que pertenece al trabajo. Si Atom cambió **antes de iniciar** y las tablas siguen vacías, `--plan --maintenance-id ID_MANTENIMIENTO` permite fijar una muestra nueva sin repetir la limpieza.

Solo diez tareas completas con identidades y huellas válidas liberan el mantenimiento. La programación diaria permanece **pausada**, incluso tras el éxito, para revisar el piloto antes de ampliar el universo. No ejecutar `evaluate-all.js` para esta prueba: procesaría todo el histórico. La restauración existente requiere tablas de evaluación vacías; no debe sobrescribir resultados del piloto. También restaura la configuración anterior, por lo que un rollback debe conservar la pausa diaria y evitar reactivar proveedores antiguos inadvertidamente.

Después de revisar el piloto, desplegar/reiniciar la API con la misma configuración local antes de habilitar nuevas ejecuciones o definir la continuación automática. Ninguna prueba sintética demuestra conectividad ni resultados reales por sí sola.

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


## Doble revisión operativa (noviembre de 2026)

En Evaluaciones → Herramientas internas → Revisión y contingencia, seleccionar **Doble revisión** y dos perfiles distintos, configurados y habilitados. Para la operación local serán Clef y Gemma. La política queda versionada y solo afecta ejecuciones nuevas; cambiarla no dispara IA ni reemplaza evaluaciones anteriores.

- Se crean dos tareas independientes por conversación con la misma huella de contenido, checklist e instrucciones. Las respuestas no se comparten entre proveedores.
- La vista operativa publica un flag automático únicamente cuando ambos modelos detectan la misma variable sobre contenido y versiones equivalentes. Las detecciones individuales quedan disponibles para revisión, sin contar como flags operativos. No se guardan respuestas agregadas fingiendo que las produjo un modelo.
- Dos detecciones independientes: **Coinciden 2 modelos**. Una detección frente a un cero: **Discrepancia · requiere revisión**. Fallo o abstención: **comparación incompleta**. No se calcula un porcentaje de certeza.
- Un cero y una abstención/fallo no equivalen a ausencia confirmada: el resultado agregado queda sin conclusión. Los cálculos se ejecutan una vez por conversación y no votan. Las reglas híbridas muestran la respuesta de IA y el ajuste de código, sin convertir la coincidencia impuesta en consenso.
- La vista de conversación permite consultar las dos identidades reales, resultado, justificación, citas y versión del criterio. Se puede refutar el flag compartido; levantar uno omitido requiere la conversación completa. Autor, motivo, fecha y evidencia originales se conservan.
- Si un modelo falla técnicamente tras su reintento, se conserva la revisión del otro, identificando la comparación incompleta. No se convierte en coincidencia de dos modelos ni se ejecuta de nuevo al modelo completado como respaldo adicional. Un fallo de configuración, entrada o seguridad requiere intervención. El piloto local nunca recurre a GPT o Gemini.
- **Detalle → Reanudar pendientes y fallidos** reanuda solo las tareas no completadas. Cambios de contenido, checklist, instrucciones, modelo o una ejecución operativa posterior impiden reutilizar un caso incompatible.
- El historial distingue conversaciones de revisiones: 20 conversaciones en modo dual producen hasta 40 revisiones, además de los reintentos técnicos registrados por separado.
- Se conserva el procesamiento existente de conversaciones abiertas y modificadas. No se dividen chats en atenciones.

### Preparación antes de publicar

1. Conservar respaldo y verificar que no haya lotes activos. Aplicar `npm run db:migrate` desde `api/` sobre la base propia. La migración 002 crea tablas adicionales y referencias operativas sin borrar resultados o revisiones; ante empate de fecha elige la evaluación más reciente por secuencia. No modifica Atom. El flujo de despliegue actual no ejecuta esta migración por sí solo: completarla antes de fusionar/desplegar esta rama.
2. Configurar una credencial de **Gemini API** y un modelo compatible en el backend. La clave OpenAI no autentica Gemini. La facturación/configuración del proveedor es independiente. Confirmar límites del proyecto antes de habilitarlo.
3. Reiniciar la API con la configuración, guardar la política y ejecutar una muestra piloto explícita. No reevaluar automáticamente todo el histórico.
4. Verificar persistencia en MySQL y respuestas reales de ambos proveedores. Las pruebas locales usan adaptadores sintéticos, sin consumo externo. La prueba real de Gemini y la migración sobre el servidor están pendientes de su configuración/publicación.

Contrato Gemini consultado: [GenerateContent y GenerationConfig](https://aistudio.google.com/api-reference/generate-content). El adaptador utiliza `responseMimeType` y `responseJsonSchema`, y valida además todas las variables y referencias de evidencia en Pulso.
