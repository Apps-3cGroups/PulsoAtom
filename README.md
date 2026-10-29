# Pulso

Portal de revisión de calidad de conversaciones de Atom. El histórico se consulta en Atom; el catálogo, las evaluaciones y la auditoría viven en `dbPulsosAtom`. Incluye evaluación operativa, perfiles OpenAI/Gemini, comparación reproducible y validación humana. Los proveedores requieren configuración y habilitación explícita. Consulta [la guía de modelos y comparación](docs/MODELOS_Y_COMPARACION.md).

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

Abre **http://127.0.0.1:3000/pulso/**. Las dependencias ya están instaladas en esta entrega y ambos `.env` locales están preparados. Los puertos predeterminados son 3000 para web y 4001 para API.

Para servir la compilación con Express, detén primero el servidor de desarrollo web:

```sh
cd web
npm run build
npm start
```

La API debe seguir encendida. Todas las rutas y recursos viven bajo `/pulso`; `/` devuelve 404 deliberadamente. `web/server.js` sirve el frontend y reenvía `/pulso/api` a la API.

## Repositorio

El proyecto está vinculado a [PulsoAtom](https://github.com/Apps-3cGroups/PulsoAtom) en la rama `main`. `.gitignore` excluye las credenciales (`.env`), datos locales de demostración, dependencias y la compilación. No pegues contraseñas ni tokens en el chat ni en la URL del remoto.

## Lo que incluye

- **Resumen:** indicadores y mapa por país, asistente y fecha. Cada conversación abre una vista rápida con alertas, evidencia y revisiones humanas; permite refutar los flags vigentes que muestra. Para leer los mensajes completos y realizar otras revisiones, se abre la conversación completa.
- **Histórico y Búsqueda:** filtros de fechas, país, asistente, prioridad, estado y variable; búsqueda de mensajes con apertura de evidencia en contexto.
- **Conversación:** transcripción, checklist utilizado, evidencia, refutación, flags humanos y reversión con auditoría. Un ítem no evaluado no se presenta como un cero.
- **Catálogo:** 130 variables, 17 familias y 12 variables P1/P2 de fase 1 activas inicialmente. Permite agregar, editar, activar e inactivar individualmente o por lotes. No hay borrado destructivo.
- **Evaluaciones:** lotes a demanda de hasta 20 conversaciones desde el portal, con progreso y fallos visibles. El horario diario se puede guardar, pero su ejecución automática sigue inactiva.
- **Comparación:** muestras de hasta 20 conversaciones y tres modelos, evidencia por variable y validación a ciegas. Los resultados comparativos no reemplazan la evaluación operativa.
- **Perfiles y contingencia:** principal/respaldo versionados en Evaluaciones, intentos auditados y selector de resultados guardados en Resumen, Histórico, Búsqueda y Conversación.
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
| Guardar horario diario o política principal/respaldo | Sí | No |
| Crear o reanudar muestras comparativas | Sí | No |
| Consultar comparaciones y guardar dictámenes humanos | Sí | Sí |

Cada edición del catálogo conserva una versión. Las evaluaciones hacen referencia a las versiones utilizadas. Las revisiones humanas se agregan al historial sin sobrescribir la evidencia del resultado original. Los cambios concurrentes detectados devuelven un conflicto en lugar de reemplazar silenciosamente una versión reciente.

Los datos demostrativos no se importarán automáticamente a la base real. Las pruebas visuales dejaron un ejemplo de edición/restauración del nombre de la primera variable, activación/inactivación de las dos primeras variables y una refutación/deshacer en `DEMO-MX-0001`; sus valores actuales están restaurados y las acciones permanecen en el historial.

## Configuración posterior

Completa **`api/.env`**, que está excluido del control de versiones. No uses variables `VITE_*` para secretos. La web solo necesita su propio `web/.env` con puerto y URL interna de la API.

| Grupo | Uso |
| --- | --- |
| `APP_DB_*` | Base MySQL propia `dbPulsosAtom`: cuentas, catálogo, versiones, evaluaciones y auditoría. |
| `ATOM_DB_*`, `ATOM_*_TABLE` | Conexión independiente de lectura a conversaciones, eventos y países. El catálogo de países proviene de `dbSomos3c_2.tblCatalogoPaises`. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_TIMEOUT_MS` | OpenAI Responses API con salida JSON Schema estricta. La clave permanece solo en `api/.env`. |
| `OPENAI_EVALUATION_ENABLED` | Bloqueo explícito de transferencia; `false` por defecto. Se activa solo al habilitar nuevos lotes de evaluación. |
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

`dbAtom.tblConversaciones` enlaza su documento vigente con `tblDocumentosConversacion`; los eventos se leen de `tblEventosConversacion`. Los asesores y canales vienen de `tblAsesores` y `tblCanales`. Los códigos de país se resuelven en `dbSomos3c_2.tblCatalogoPaises`, sin duplicar ese catálogo en Pulso. El histórico muestra solo documentos con estado `LISTO` y mantiene todas las conversaciones sin evaluación como pendientes. La conversación se revisa dentro de Pulso. Las muestras nuevas verifican la huella del origen y requieren una nueva muestra si Atom cambia.

El acceso de origen es de lectura. Las evaluaciones, versiones y revisiones se escribirán en las tablas propias de Pulso. La base propia no guarda transcripciones de Atom. Las credenciales del origen no se envían al navegador. Consulta [el diseño de la base de datos](docs/BASE_DATOS.md) para ver las tablas y la separación de conexiones.

### Servicios TD: S3 y SMTP

Los servicios reutilizables viven en `api/src/services/tdApiClient.js`, `tdS3Service.js` y `tdMailService.js`. Exportan `uploadFileToS3`, `getS3TemporaryUrl`, `downloadS3File`, `checkMailHealth`, `sendMail` y `sendSimpleMail`; todas devuelven `{ success, message, data, error }`. La API TD no recibe JWT. El cliente usa únicamente `TD_API_BASE_URL`, HTTPS, un tiempo límite y errores normalizados. `s3Key` no admite `/` ni `\`; la caducidad máxima del enlace es 604800 segundos y el cuerpo de subida tiene un límite de 50 MB.

En modo real, un administrador autenticado puede usar las rutas `/pulso/api/integrations/td/s3/upload`, `/s3/url`, `/s3/download`, `/mail/health` y `/mail/send` bajo el mismo prefijo. La subida y el correo tienen límite de frecuencia. En modo demostración estas rutas están cerradas. React dispone de los mismos servicios en `web/src/services/tdApiClient.js`, `tdS3Service.js` y `tdMailService.js`; `downloadS3File` entrega un `Blob`. Los helpers `fileToBase64` y `downloadBlob` están en `web/src/services/tdFileHelpers.js` para futuros formularios.

### Evaluación operativa y proveedores

La lectura histórica de Atom ya está conectada: el servidor consulta las conversaciones, su documento vigente y los eventos, y resuelve el país en el catálogo corporativo. Las respuestas se mantienen en memoria durante un minuto; no se guardan transcripciones en Pulso. El adaptador OpenAI envía roles, IDs y texto de los mensajes, junto con las definiciones activas compatibles, a Responses API. Gemini usa el mismo contenido y contrato de resultados mediante un adaptador separado. Solicita `store: false`, valida que los resultados incluyan todas las variables solicitadas y que cada evidencia positiva cite mensajes reales, y guarda los resultados y la versión del checklist en Pulso. Ya se ejecutó y documentó una muestra de cinco conversaciones reales.

La transferencia está deshabilitada por defecto (`OPENAI_EVALUATION_ENABLED=false`). En esta instalación local ya se autorizó y habilitó para futuros lotes, y el portal está configurado en modo real. Una vez habilitada, `cd api && npm run eval:sample` selecciona cinco conversaciones pendientes al azar, las evalúa y presenta IDs y flags sin imprimir transcripciones; `npm run eval:sample -- --recheck <ID de ejecución>` reevalúa únicamente los mismos cinco IDs de una muestra anterior. El endpoint del portal permite lotes a demanda de hasta 20 conversaciones. La primera muestra y su reevaluación están documentadas en [el informe de prueba](docs/PRUEBA_IA_2026-10-27.md).

La programación diaria se configura en el portal por un administrador. Al activarla, Pulso guarda la fecha de inicio y solo considera conversaciones completadas que Atom haya creado o actualizado desde entonces; el histórico anterior puede evaluarse a demanda. El servidor revisa el horario cada minuto en la zona seleccionada, procesa hasta 100 pendientes por día y registra una única ejecución por fecha. Debe estar encendido a la hora programada. El horario se debe fijar después de la carga diaria de Atom; la programación permanece inactiva hasta confirmarlo. Los intentos quedan persistidos: un reintento por modelo y respaldo opcional para fallos técnicos. Los trabajos parciales o interrumpidos se reanudan explícitamente desde su detalle, sin repetir los resultados completados. No se procesan automáticamente más de 100 conversaciones por día.

Solo se seleccionan conversaciones con fecha de cierre en Atom. Una conversación cuyo documento ya esté disponible pero todavía no tenga `FechaFinUtc` permanece pendiente; así no se marca prematuramente la ausencia de respuesta al último mensaje.

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
