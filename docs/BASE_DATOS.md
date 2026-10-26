# Bases de datos de Pulso

`dbPulsosAtom` es la base propia de Pulso. La base de Atom es independiente y será la fuente de conversaciones y mensajes. La API se conectará a ambas desde el servidor: leerá Atom con una cuenta de solo lectura y escribirá catálogo, evaluaciones y revisiones en Pulso. No se crearán claves foráneas entre bases ni se copiarán transcripciones completas a Pulso.

## Tablas de `dbPulsosAtom`

| Grupo | Tablas | Finalidad |
| --- | --- | --- |
| Acceso | `users`, `sessions` | Cuentas con rol administrador o supervisor y sesiones. |
| Checklist | `catalog_items`, `catalog_versions`, `catalog_audit` | Definición editable de las 130 variables, snapshots de cada versión y quién cambió cada ítem. Las 12 variables iniciales activas se cargan con `db:seed`. |
| Origen | `source_conversation_refs`, `source_sync_cursors`, `ingestion_batches` | Identificadores de Atom, marca de avance y registro de cargas diarias. No contienen mensajes. |
| Evaluación | `evaluation_jobs`, `evaluations`, `evaluation_results`, `evaluation_evidence` | Solicitudes a demanda o diarias, snapshot de la evaluación, resultado por variable y citas de mensajes que justifican el resultado. `evaluations` preserva el checklist/versiones usados. |
| Revisión humana | `review_events` | Refutaciones, alertas levantadas y reversiones como eventos históricos. |
| Configuración y migraciones | `portal_settings`, `schema_migrations`, `app_lock` | Horario diario, configuración del portal, control de esquema y serialización de escrituras del adaptador actual. |

El esquema está en [`api/migrations/001_initial.sql`](../api/migrations/001_initial.sql). Las entidades activas del adaptador actual se almacenan como documentos JSON por tabla; los resultados y citas también se indexan en tablas propias para consultas futuras. `source_conversation_refs`, `source_sync_cursors` e `ingestion_batches` quedan preparados para la integración incremental, pero el conector de Atom aún no los alimenta. La aplicación real seguirá mostrando el histórico vacío hasta implementar esa lectura. No hay evaluaciones automáticas activas.

Cada evaluación debe quedar ligada al identificador estable de Atom y a las versiones exactas del checklist. Si una conversación cambia en Atom, se podrá revaluar sin sobrescribir la evaluación anterior. Los IDs de mensajes de Atom se guardarán junto con las citas necesarias para auditar un resultado; no habrá una copia de la tabla de mensajes.

## Configuración de conexiones

En [`api/.env.example`](../api/.env.example) hay dos grupos separados:

```dotenv
DEMO_MODE=false
APP_DB_HOST=HOST_DE_PULSO
APP_DB_PORT=3306
APP_DB_NAME=dbPulsosAtom
APP_DB_USER=USUARIO_DE_PULSO
APP_DB_PASSWORD=CONTRASEÑA_DE_PULSO
APP_DB_SSL=false

ATOM_DB_ENGINE=mysql
ATOM_DB_HOST=HOST_DE_ATOM
ATOM_DB_PORT=3306
ATOM_DB_NAME=BASE_EXISTENTE_DE_ATOM
ATOM_DB_USER=USUARIO_SOLO_LECTURA
ATOM_DB_PASSWORD=CONTRASEÑA_DE_ATOM
ATOM_DB_SSL=false
ATOM_CONVERSATIONS_TABLE=TABLA_DE_CONVERSACIONES
ATOM_MESSAGES_TABLE=TABLA_DE_MENSAJES
ATOM_AGENTS_TABLE=
ATOM_COUNTRIES_TABLE=
```

Los valores anteriores son **marcadores**, no credenciales válidas. Se editan solo en `api/.env`, excluido de Git. `APP_DB_*` es la única conexión que usan hoy las migraciones y el almacenamiento real; `ATOM_DB_*` queda reservado hasta conocer el motor, tablas y relaciones de Atom. Si Atom no es MySQL, se cambiará `ATOM_DB_ENGINE` y se implementará su conector correspondiente. `DEMO_MODE=true` mantiene las pantallas con datos sintéticos separados de ambas bases.

Cuando exista `dbPulsosAtom`, se completan `APP_DB_*` y se ejecuta desde `api/`:

```sh
npm run db:migrate
npm run db:seed
npm run user:create
```

Después se cambia `DEMO_MODE=false` y se reinicia la API. No hemos probado todavía la migración contra una instancia MySQL real. Para conectar Atom hará falta conocer nombres de tablas, columnas de ID y relación conversación-mensaje, fechas de creación/actualización y zona horaria, asistente, país, canal, autor, texto y multimedia. También hará falta acordar el criterio de conversación lista para evaluar y la forma de identificar ediciones posteriores.
