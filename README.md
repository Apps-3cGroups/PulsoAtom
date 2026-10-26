# Pulso

Portal local de revisión de calidad de conversaciones de Atom. Primera entrega: interfaz, catálogo editable, revisión humana y preparación de conexiones. Las evaluaciones automáticas y la lectura de Atom todavía no se ejecutan.

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

## Vincular con GitHub

El proyecto está preparado como un repositorio Git local en la rama `main`. El primer commit contiene código, catálogo, ejemplos de configuración y capturas. `.gitignore` excluye las credenciales (`.env`), datos locales de demostración, dependencias y la compilación.

Cuando tengas el repositorio remoto y acceso a GitHub, desde esta carpeta:

```sh
git remote add origin URL_DEL_REPOSITORIO
git push -u origin main
```

Si GitHub CLI indica que la sesión expiró, vuelve a iniciar sesión con `gh auth login` antes de subirlo. No pegues contraseñas ni tokens en el chat ni en la URL del remoto.

## Lo que incluye

- **Resumen:** indicadores, conversaciones prioritarias y mapa por país, asistente y fecha. Las prioridades históricas no tienen contador de vencimiento.
- **Histórico y Búsqueda:** filtros de fechas, país, asistente, prioridad, estado y variable; búsqueda de mensajes con apertura de evidencia en contexto.
- **Conversación:** transcripción, checklist utilizado, evidencia, refutación, flags humanos y reversión con auditoría. Un ítem no evaluado no se presenta como un cero.
- **Catálogo:** 130 variables, 17 familias y 12 variables P1/P2 de fase 1 activas inicialmente. Permite agregar, editar, activar e inactivar individualmente o por lotes. No hay borrado destructivo.
- **Evaluaciones:** interfaz a demanda y horario diario configurable. Muestra los requisitos pendientes y bloquea la ejecución automática hasta completar Atom, IA y procesamiento de lotes.
- Tema claro en todas las pantallas. Tipografías locales; no se envía contenido a servicios de fuentes.

Los códigos, familias, definiciones, métodos, fases y condiciones provienen del Excel. El HTML aporta polaridades, nombres cortos y el lenguaje visual. `catalog-labels.json` completa nombres legibles sin cambiar los códigos. Las tres variables `guion_[punto]_*` se conservan como plantillas no activables; requieren definir un punto concreto antes de usarlas.

## Demostración y permisos

Con `DEMO_MODE=true`, la pantalla de acceso permite entrar como administrador o supervisor. Contiene 216 conversaciones sintéticas y resultados identificados como demostración; **no son análisis realizados por IA**. Las modificaciones sí se escriben en `api/.data/demo-store.json`, de forma local y separada de MySQL. El archivo se crea una sola vez y se reutiliza al reiniciar.

| Acción | Administrador | Supervisor |
| --- | --- | --- |
| Consultar todos los países, conversaciones y catálogo | Sí | Sí |
| Refutar, levantar y deshacer flags con comentario | Sí | Sí |
| Crear y modificar variables / activar lotes | Sí | No |
| Guardar horario diario | Sí | No |

Cada edición del catálogo conserva una versión. Las evaluaciones hacen referencia a las versiones utilizadas. Las revisiones humanas se agregan al historial sin sobrescribir la evidencia del resultado original. Los cambios concurrentes detectados devuelven un conflicto en lugar de reemplazar silenciosamente una versión reciente.

Los datos demostrativos no se importarán automáticamente a la base real. Las pruebas visuales dejaron un ejemplo de edición/restauración del nombre de la primera variable, activación/inactivación de las dos primeras variables y una refutación/deshacer en `DEMO-MX-0001`; sus valores actuales están restaurados y las acciones permanecen en el historial.

## Configuración posterior

Completa **`api/.env`**, que está excluido del control de versiones. No uses variables `VITE_*` para secretos. La web solo necesita su propio `web/.env` con puerto y URL interna de la API.

| Grupo | Uso |
| --- | --- |
| `APP_DB_*` | Base MySQL propia de Pulso: cuentas, catálogo, versiones, evaluaciones y auditoría. |
| `ATOM_DB_*`, `ATOM_*_TABLE` | Conexión independiente a las tablas de origen. Los valores están reservados; aún no se hacen consultas a Atom. |
| `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | Configuración reservada del servicio de IA; el adaptador se implementará después. |
| `PUBLIC_ORIGIN`, `SESSION_HOURS`, `COOKIE_SECURE` | Origen autorizado y sesiones. Ajustar el origen exacto y habilitar cookies seguras al usar HTTPS. |
| `APP_TIMEZONE` | Zona horaria de presentación; el horario diario también conserva su propia zona. |

Para usar la base propia cuando esté disponible:

1. Crear una base MySQL dedicada a Pulso con `utf8mb4`, usando una cuenta autorizada para aplicar migraciones.
2. Completar `APP_DB_*` y cambiar `DEMO_MODE=false`.
3. Desde `api/`, ejecutar `npm run db:migrate`, `npm run db:seed` y `npm run user:create`.
4. `user:create` solicita nombre, correo, rol y contraseña en una terminal interactiva. La contraseña se oculta al escribir y se guarda con scrypt. No hay contraseñas reales predeterminadas ni registro público.
5. Reiniciar la API y entrar con la cuenta creada. La carga inicial real incluye el catálogo, pero no conversaciones ni usuarios de demostración.

Una conexión ausente o fallida no activa el modo demo como respaldo. Las migraciones y el adaptador MySQL están implementados, pero **su ejecución y persistencia real se validarán al recibir la conexión**.

### Datos que necesitaremos de Atom

Motor y conexión; nombres de las tablas; identificadores y relaciones entre conversación, mensaje, asistente y país. Después inspeccionaremos columnas, estados y fechas para acordar:

- Identificador estable de la conversación y de cada mensaje.
- Inicio, cierre y última modificación, con su zona horaria.
- Autor de cada mensaje: cliente, bot o humano; texto y referencias multimedia.
- Asistente asignado, país, canal, identificador del cliente y URL de origen cuando exista.
- Cómo reconocer nuevos registros, actualizaciones y conversaciones completas sin duplicarlas.

El acceso de origen será de lectura. Las evaluaciones, versiones y revisiones se escribirán en las tablas propias de Pulso. Las credenciales del origen no se envían al navegador.

### Trabajo pendiente de integración

El llenado del `.env` por sí solo no habilita el motor. Faltan el mapeo e importación incremental de Atom, los evaluadores de IA y código, el tratamiento de dependencias/no aplicabilidad de cada variable y un procesador de lotes con reintentos, control de duplicados y programación diaria. La evaluación inicial cubrirá las 12 variables acordadas, con pruebas sobre conversaciones reales autorizadas.

El almacenamiento MySQL inicial separa entidades en tablas con documentos JSON y conserva sus versiones. Antes de importar un histórico grande se deben incorporar consultas paginadas en SQL e índices para el volumen real; el adaptador inicial carga el estado completo. Esta entrega es una base local de desarrollo, todavía no una liberación de producción.

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

Hay 11 pruebas de API y 1 del servidor web: importación, roles, formularios, persistencia demo, versiones, lotes atómicos, evidencia, revisiones, búsqueda, filtros, ausencia de simulación en modo real, rutas y proxy. El detalle y las verificaciones manuales están en [docs/QA.md](docs/QA.md).

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
