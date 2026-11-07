# Pulso

Portal de revisión de calidad de conversaciones de Atom. El histórico se consulta en Atom; el catálogo, las evaluaciones y la auditoría viven en `dbPulsosAtom`. Los modelos configurados evalúan las variables activas del checklist. Esta instalación utiliza Clef y Gemma mediante GatewayAgents. Los proveedores públicos quedan fuera de nuevas ejecuciones; sus resultados históricos conservan su identidad.

## Abrir y ejecutar

Requiere Node.js 20.19 o superior. Hay dos aplicaciones independientes; ejecuta cada bloque en una terminal desde la raíz del proyecto.

```sh
cd api
npm ci
# Solo si todavía no existe .env:
cp -n .env.example .env
npm run dev
```

```sh
cd web
npm ci
cp -n .env.example .env
npm run dev
```

Abre **http://127.0.0.1:3000/pulsoAtom/**. Las dependencias ya están instaladas en esta entrega y ambos `.env` locales están preparados. Los puertos predeterminados son 3000 para web y 4001 para API.

Para servir la compilación con Express, detén primero el servidor de desarrollo web:

```sh
cd web
npm run build
npm start
```

La API debe seguir encendida. Todas las rutas y recursos viven bajo `/pulsoAtom`; `/` devuelve 404 deliberadamente. `web/server.js` sirve el frontend y reenvía `/pulsoAtom/api` a la API.

### Configuración de subruta y PM2

La subruta solicitada es **`/pulsoAtom`**, respetando mayúsculas. Se configura con `BASE_PATH=/pulsoAtom` en `api/.env` y `VITE_BASE_PATH=/pulsoAtom`, `VITE_API_BASE_URL=/pulsoAtom/api` en `web/.env`. Los tres valores deben coincidir y, si cambian, hay que recompilar la web. Las rutas internas, los recursos, el proxy y las cookies conservan ese prefijo.

Ambas aplicaciones aceptan `PORT`: `4001` para API y `3000` para web. El proxy interno se configura con `API_PROXY_TARGET=http://127.0.0.1:4001` en `web/.env`. Se mantienen `API_PORT`, `WEB_PORT` y `API_TARGET` como alternativas para configuraciones anteriores.

El archivo raíz `ecosystem.config.js` define `DEPLOY_ROOT=/var/www/nodeapps` y `PROJECT_FOLDER=PulsoAtom`, con procesos separados `pulso-atom-api` y `pulso-atom-web`. Solo establece `PORT` en sus bloques `env`; cada servidor carga su propio `.env`. Antes de iniciar una instalación real hay que preparar esos archivos y confirmar bases, permisos y la configuración de modo real descrita más abajo.

Después de instalar dependencias y compilar `web`, el arranque previsto desde la raíz del proyecto es:

```sh
pm2 start ecosystem.config.js
```

Apache debe conservar `/pulsoAtom` al reenviar hacia el servidor web interno. Esta configuración no despliega el proyecto ni ejecuta migraciones.

## Repositorio

El proyecto está vinculado a [PulsoAtom](https://github.com/Apps-3cGroups/PulsoAtom) en la rama `main`. `.gitignore` excluye las credenciales (`.env`), datos locales de demostración, dependencias y la compilación. No pegues contraseñas ni tokens en el chat ni en la URL del remoto.

## Lo que incluye

- **Resumen:** indicadores y mapa por país, asistente y fecha. Cada conversación abre una vista rápida con alertas, evidencia y revisiones humanas; permite refutar los flags vigentes que muestra. Para leer los mensajes completos y realizar otras revisiones, se abre la conversación completa.
- **Histórico y Búsqueda:** filtros de fechas, país, asistente, prioridad, estado y variable; búsqueda de mensajes con apertura de evidencia en contexto.
- **Conversación:** transcripción, checklist utilizado, evidencia, refutación, flags humanos y reversión con auditoría. Un ítem no evaluado no se presenta como un cero.
- **Catálogo:** 130 variables, 17 familias y 12 variables P1/P2 de fase 1 activas inicialmente. Permite agregar, editar, activar e inactivar individualmente o por lotes. No hay borrado destructivo.
- **Evaluaciones:** lotes a demanda de hasta 20 conversaciones desde el portal, con progreso y fallos visibles. Programación diaria de hasta 100 conversaciones nuevas o con contenido nuevo, según la política de la instalación.
- Tema claro en todas las pantallas. Tipografías locales; no se envía contenido a servicios de fuentes.

Los códigos, familias, definiciones, métodos, fases y condiciones provienen del Excel. El HTML aporta polaridades, nombres cortos y el lenguaje visual. `catalog-labels.json` completa nombres legibles sin cambiar los códigos. Las tres variables `guion_[punto]_*` se conservan como plantillas no activables; requieren definir un punto concreto antes de usarlas.

## Demostración y permisos

Con `DEMO_MODE=true`, la pantalla de acceso permite entrar como administrador o supervisor. Contiene 216 conversaciones sintéticas y resultados identificados como demostración; **no son análisis realizados por IA**. Las modificaciones sí se escriben en `api/.data/demo-store.json`, de forma local y separada de MySQL. El archivo se crea una sola vez y se reutiliza al reiniciar.

| Acción | Administrador | Supervisor |
| --- | --- | --- |
| Consultar todos los países, conversaciones y catálogo | Sí | Sí |
| Refutar, levantar y deshacer flags con comentario | Sí | Sí |
| Crear y modificar variables / activar lotes | Sí | No |
| Iniciar evaluaciones a demanda, cuando estén habilitadas | Sí | No |
| Guardar horario diario | Sí | No |

Cada edición del catálogo conserva una versión. Las evaluaciones hacen referencia a las versiones utilizadas. Las revisiones humanas se agregan al historial sin sobrescribir la evidencia del resultado original. Los cambios concurrentes detectados devuelven un conflicto en lugar de reemplazar silenciosamente una versión reciente.

Los datos demostrativos no se importarán automáticamente a la base real. Las pruebas visuales dejaron un ejemplo de edición/restauración del nombre de la primera variable, activación/inactivación de las dos primeras variables y una refutación/deshacer en `DEMO-MX-0001`; sus valores actuales están restaurados y las acciones permanecen en el historial.

## Configuración posterior

Completa **`api/.env`**, que está excluido del control de versiones. No uses variables `VITE_*` para secretos. La web solo necesita su propio `web/.env` con puerto y URL interna de la API.

| Grupo | Uso |
| --- | --- |
| `APP_DB_*` | Base MySQL propia `dbPulsosAtom`: cuentas, catálogo, versiones, evaluaciones y auditoría. |
| `ATOM_DB_*`, `ATOM_*_TABLE` | Conexión independiente de lectura a conversaciones, eventos y países. El catálogo de países proviene de `dbSomos3c_2.tblCatalogoPaises`. |
| `GATEWAY_BASE_URL`, `AGENT_SHARED_TOKEN`, `GATEWAY_PORTAL_KEY` | Conexión privada a GatewayAgents. Clave solo en backend; identidad `portal-pulso`. |
| `CLEF_*`, `GEMMA_*` | Ajustes iniciales y límites de generación. Herramientas, IDs y activación se pueden guardar en Evaluaciones → Herramientas internas → Modelos locales. |
| `PUBLIC_ORIGIN`, `SESSION_HOURS`, `COOKIE_SECURE` | Origen autorizado y sesiones. Ajustar el origen exacto y habilitar cookies seguras al usar HTTPS. |
| `APP_TIMEZONE` | Zona horaria de presentación; el horario diario también conserva su propia zona. |
| `TD_API_BASE_URL` | URL base de la API TD para S3 y SMTP. Se configura solo en `api/.env`; no se envía al navegador. También se acepta la clave heredada `URL-Base`. |

Para usar la base propia en otra instalación:

1. Crear la base MySQL `dbPulsosAtom` con `utf8mb4`, usando una cuenta autorizada para aplicar migraciones.
2. Completar `APP_DB_*` y la sección `IDENTITY_*`; después cambiar `DEMO_MODE=false` cuando exista una cuenta inicial habilitada.
3. Desde `api/`, ejecutar `npm run db:migrate`, `npm run db:seed` y `npm run access:bootstrap -- <correo exacto>`.
4. Reiniciar la API y entrar con el correo y contraseña existentes de Somos3C. El histórico real se lee desde Atom; las conversaciones de demostración nunca se importan.

Una conexión ausente o fallida no activa el modo demo como respaldo. En la conexión facilitada se verificaron las 16 tablas, el seed de 130 variables y la lectura de 233 conversaciones de Atom. La instalación local ya usa `DEMO_MODE=false` y tiene un administrador inicial autorizado. El archivo `.env` local no se versiona.

La autenticación real usa `IDENTITY_MODE=person-email`: busca el correo en `dbSomos3c_2.tblPersonas`, comprueba que identifique una sola persona activa y verifica su contraseña contra el hash SHA-512 existente. El correo `mario.cruz@farmavalue.com` existe en esa tabla y tiene acceso activo a los portales Call Center y Atom, pero no figura en `dbSomos3c_2.tblUsuariosPortal`; por eso Pulso no usa esa última tabla para su ingreso. Los permisos de Pulso se guardan en su propia tabla `users`, sin copiar hashes. Un administrador gestiona las concesiones en **Accesos**: busca por correo exacto, asigna administrador o supervisor, edita el rol y activa o inactiva. Las sesiones se guardan en Pulso y se revalidan contra la cuenta de origen en cada solicitud. No se ha cambiado ninguna cuenta ni contraseña de Somos3C.

Para autorizar al primer administrador en otra instalación, ejecuta `cd api && npm run access:bootstrap -- <correo exacto>`. El comando solo funciona si Pulso todavía no tiene un administrador activo; después, los demás accesos se gestionan en el portal.

### Origen Atom confirmado

`dbAtom.tblConversaciones` enlaza su documento vigente con `tblDocumentosConversacion`; los eventos se leen de `tblEventosConversacion`. Los asesores y canales vienen de `tblAsesores` y `tblCanales`. Los códigos de país se resuelven en `dbSomos3c_2.tblCatalogoPaises`, sin duplicar ese catálogo en Pulso. El histórico muestra solo documentos con estado `LISTO` y mantiene todas las conversaciones sin evaluación como pendientes. Las conversaciones abiertas pueden evaluarse provisionalmente; nuevos mensajes o el cierre las dejan pendientes de actualización. Una importación idéntica no genera una evaluación nueva.

El acceso de origen es de lectura. Las evaluaciones, versiones y revisiones se escribirán en las tablas propias de Pulso. La base propia no guarda transcripciones de Atom. Las credenciales del origen no se envían al navegador. Consulta [el diseño de la base de datos](docs/BASE_DATOS.md) para ver las tablas y la separación de conexiones.

### Servicios TD: S3 y SMTP

Los servicios reutilizables viven en `api/src/services/tdApiClient.js`, `tdS3Service.js` y `tdMailService.js`. Exportan `uploadFileToS3`, `getS3TemporaryUrl`, `downloadS3File`, `checkMailHealth`, `sendMail` y `sendSimpleMail`; todas devuelven `{ success, message, data, error }`. La API TD no recibe JWT. El cliente usa únicamente `TD_API_BASE_URL`, HTTPS, un tiempo límite y errores normalizados. `s3Key` no admite `/` ni `\`; la caducidad máxima del enlace es 604800 segundos y el cuerpo de subida tiene un límite de 50 MB.

En modo real, un administrador autenticado puede usar las rutas `/pulsoAtom/api/integrations/td/s3/upload`, `/s3/url`, `/s3/download`, `/mail/health` y `/mail/send` bajo el mismo prefijo. La subida y el correo tienen límite de frecuencia. En modo demostración estas rutas están cerradas. React dispone de los mismos servicios en `web/src/services/tdApiClient.js`, `tdS3Service.js` y `tdMailService.js`; `downloadS3File` entrega un `Blob`. Los helpers `fileToBase64` y `downloadBlob` están en `web/src/services/tdFileHelpers.js` para futuros formularios.

### Evaluación con Clef y Gemma

La lectura histórica de Atom consulta conversaciones y mensajes sin guardar transcripciones en Pulso. Los modelos locales reciben roles, IDs, texto y definiciones activas compatibles con IA a través del Gateway. Las respuestas se validan por variable, identidad de modelo y evidencia. Código y métricas se calculan una sola vez y no cuentan como votos.

En **Evaluaciones → Herramientas internas → Modelos locales**, consultar el Gateway, seleccionar las herramientas e IDs exactos de Clef/Gemma y guardar. Las credenciales permanecen en el servidor. El guardado selecciona doble revisión y pausa el diario para el piloto; no ejecuta IA ni borra evaluaciones. No se requiere `AI_MODEL_PROFILES`, ni claves de GPT/Luna o Gemini. Una política antigua con esos proveedores permanece sin disponibilidad hasta guardar la política local.

El endpoint operativo permite hasta 20 conversaciones por lote. Para la limpieza respaldada y prueba inicial de las últimas cinco, seguir [la guía del piloto local](docs/MODELOS_Y_COMPARACION.md#piloto-controlado-y-limpieza-respaldada). Los comandos de evaluación leen la configuración guardada en Pulso. Las pruebas originales de OpenAI quedan como documentación histórica en [el informe de octubre](docs/PRUEBA_IA_2026-10-27.md).

La programación diaria se configura en el portal por un administrador. El servidor comprueba el horario cada minuto en la zona seleccionada y procesa hasta 100 conversaciones por día, con una única ejecución por fecha. Debe permanecer encendido y conectado a Atom, MySQL y los modelos de la política vigente. Los pendientes que superen el límite quedan para días posteriores.

Con `includeOpenConversations` y `refreshChangedConversations` habilitados en la configuración persistida, se incluyen conversaciones abiertas y cerradas. Las abiertas muestran «Evaluación provisional». Se compara la huella del texto, roles, IDs, fechas de mensajes, país y estado de cierre: una importación idéntica no repite la IA, mientras un mensaje nuevo o el cierre requieren actualizar el resultado. El horario conserva su fecha de inicio para seleccionar registros nuevos; las conversaciones ya evaluadas cuyo contenido cambió también se actualizan aunque Atom no cambie su fecha de actualización.

Cada resultado conserva su huella y checklist. Si Atom cambia durante la llamada de IA, se rechaza ese resultado y el caso queda pendiente. Si cambia después, el portal advierte «Contenido nuevo» e impide una revisión humana sobre evidencia desactualizada. Una conversación abierta cuyo último mensaje es del cliente no recibe un flag definitivo de falta de respuesta. Los errores transitorios o respuestas inválidas tienen un único reintento; los fallos quedan registrados.

La renovación completa del histórico utiliza comandos separados de los lotes ordinarios: respaldo verificado, limpieza transaccional y evaluación reanudable de una lista fija. Consulta [la guía de operación](docs/OPERACION_EVALUACIONES.md). No se ejecuta una limpieza al desplegar ni al iniciar el servidor.

El almacenamiento MySQL inicial separa entidades en tablas con documentos JSON y conserva sus versiones. Antes de consultar un histórico grande se deben incorporar consultas paginadas en SQL e índices para el volumen real; el adaptador actual carga el histórico completo de Atom y el estado completo de Pulso. Esta entrega todavía no es una liberación de producción.

## Verificación

```sh
cd api
npm test
```

```sh
cd web
npm test
npm run build
```

Las pruebas de API cubren importación, roles, formularios, persistencia demo, versiones, evidencia, revisiones, separación de bases, mapeo de Atom, filtros y el contrato estructurado del evaluador. El detalle y las verificaciones manuales están en [docs/QA.md](docs/QA.md).

## Organización

```text
api/
  migrations/       Esquema propio de Pulso
  scripts/          Importación del catálogo, migraciones y usuarios
  src/app.js        Rutas y permisos de la API
  src/domain.js     Reglas, filtros, versiones y revisiones
  src/store.js      Persistencia demo y adaptador MySQL
  src/data/         Catálogo y conversaciones sintéticas
  test/             Pruebas de API
web/
  server.js         Entrega Express y proxy
  src/pages/        Pantallas del portal
  src/components/   Filtros, figuras y elementos compartidos
  src/services/     Cliente de API
  test/             Rutas, recargas y proxy
```

Para volver a extraer el catálogo de los archivos originales (no modifica los archivos de origen ni el catálogo ya editado en una base):

```sh
python3 api/scripts/import-catalog.py \
  --workbook /ruta/Catalogo_variables_calidad_contact_center_v2_1_1.xlsx \
  --prototype /ruta/Pulso_prototipo.html
```


### Doble revisión de modelos

La rama de doble revisión añade dos respuestas independientes por conversación y un único flag operativo. Desde el flag se consultan razones y citas lado a lado; la revisión humana conserva los originales. Administración configura doble revisión o principal con respaldo en **Evaluaciones → Herramientas internas**.

Antes de desplegar se requiere aplicar la migración `002_multi_model.sql` a la base propia mediante `npm run db:migrate` en `api/`, sin lotes activos. Instalar una versión no habilita proveedores ni reevalúa el histórico. Para utilizar Clef/Gemma, configurar GatewayAgents en el servidor y completar Modelos locales en el portal; verificar su inferencia mediante el piloto limitado a las cinco conversaciones más recientes. Consultar [operación y despliegue](docs/MODELOS_Y_COMPARACION.md).

### Clef Flash: respuesta de chat

La instancia `clef-flash` comprobada en el Gateway utiliza **Chat** (`POST /v1/chat/completions`). Si deja `content` vacío y entrega un objeto JSON completo del checklist en `reasoning_content`, Pulso valida ese objeto con las mismas reglas de valores, motivos y evidencia. Esta compatibilidad se limita al ID exacto `clef-flash`; no extrae JSON de prosa ni sustituye una respuesta final no vacía. Las variables ausentes o inválidas siguen pendientes, nunca se convierten en ceros.

El esquema específico de Clef Flash exige las combinaciones válidas de estado, valor y evidencia, y limita las citas a IDs de mensajes existentes. Cada intento registra el campo utilizado (`responseField`) y la versión del esquema, sin conservar el texto original. Esa versión forma parte de la configuración de Clef: sus ejecuciones iniciadas con una versión anterior deben comenzar una nueva ejecución. Las instrucciones comunes, las huellas de Gemma, la política, la programación y las evaluaciones existentes se preservan.

Clef Flash también recibe una aclaración versionada (`decisionInstructionsVersion: clef-flash-decisions-1`) con ejemplos sintéticos de evento presente, evento ausente y contexto insuficiente. Un evento no observado en texto relevante suficiente corresponde a `evaluado/0`; `no_evaluado/null` exige un impedimento concreto. La versión participa en la huella de configuración y se conserva en los intentos. Pulso no transforma abstenciones en ceros a partir de sus motivos; conserva la decisión recibida. Los otros modelos mantienen sus instrucciones actuales.

### Clef: decisiones nativas

El adaptador opcional de decisiones utiliza `POST /v1/systemone` y requiere una instancia que el servidor publique como tipo `decision`. En Modelos locales, seleccionar **Decisiones (System One)** únicamente para ese tipo de instancia y su ID exacto. El Gateway debe publicar esa ruta y `GET /api/v1/models`. La instancia de chat `clef-flash` descrita arriba debe usar **Chat**. Gemma conserva su interfaz de chat.

El adaptador clasifica eventos como presentes, ausentes o con contexto insuficiente. Una segunda decisión selecciona un mensaje de evidencia sin recibir respuestas de Gemma. Las descripciones visibles son plantillas de Pulso, identificadas como tales; Clef no genera justificaciones libres. Las probabilidades se conservan para trazabilidad, no se presentan como certeza.

Los límites de esta implementación son 12 preguntas por solicitud, 254 mensajes para seleccionar evidencia, un máximo de 22 solicitudes de inferencia por intento y el tiempo total configurado para Clef. No se recorta el contenido para hacerlo caber: si excede el presupuesto conservador del contexto, queda pendiente. La lista abierta `productos_solicitados` queda no evaluada por falta de esa capacidad. Código y métricas mantienen su procesamiento habitual.

El protocolo, las instrucciones del adaptador, las solicitudes y la procedencia de cada resultado se guardan. Los reintentos conservan respuestas válidas y no añaden votos. El despliegue no cambia perfiles guardados, programación ni evaluaciones previas; la activación es explícita. Las comparaciones nativas pertenecen a una misma ejecución con contenido y checklist equivalentes, sin reutilizar automáticamente las 500 evaluaciones anteriores de Gemma.

La prueba sintética de `preflightLocalModels` no modifica la base. No ejecutar el piloto de limpieza o reinicio para activar este adaptador sobre un histórico existente: ese procedimiento tiene un alcance diferente y requiere autorización específica.
