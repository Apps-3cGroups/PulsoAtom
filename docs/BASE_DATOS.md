# Bases de datos de Pulso

`dbPulsosAtom` es la base propia de Pulso. La base de Atom es independiente y es la fuente de conversaciones y mensajes. La API se conecta a ambas desde el servidor: lee Atom y escribe catálogo, evaluaciones y revisiones en Pulso. No hay claves foráneas entre bases ni copias de transcripciones completas en Pulso.

## Tablas de `dbPulsosAtom`

| Grupo | Tablas | Finalidad |
| --- | --- | --- |
| Acceso | `users`, `sessions` | Cuentas con rol administrador o supervisor y sesiones. |
| Checklist | `catalog_items`, `catalog_versions`, `catalog_audit` | Definición editable de las 130 variables, snapshots de cada versión y quién cambió cada ítem. Las 12 variables iniciales activas se cargan con `db:seed`. |
| Origen | `source_conversation_refs`, `source_sync_cursors`, `ingestion_batches` | Identificadores de Atom, marca de avance y registro de cargas diarias. No contienen mensajes. |
| Evaluación | `evaluation_jobs`, `evaluations`, `evaluation_results`, `evaluation_evidence` | Solicitudes a demanda o diarias, snapshot de la evaluación, resultado por variable y citas de mensajes que justifican el resultado. `evaluations` preserva el checklist/versiones usados. |
| Revisión humana | `review_events` | Refutaciones, alertas levantadas y reversiones como eventos históricos. |
| Configuración y migraciones | `portal_settings`, `schema_migrations`, `app_lock` | Horario diario, configuración del portal, control de esquema y serialización de escrituras del adaptador actual. |

El esquema está en [`api/migrations/001_initial.sql`](../api/migrations/001_initial.sql). Las entidades activas del adaptador actual se almacenan como documentos JSON por tabla; los resultados y citas también se indexan en tablas propias para consultas futuras. `source_conversation_refs`, `source_sync_cursors` e `ingestion_batches` están reservados para el procesamiento incremental de evaluaciones y aún no reciben escrituras. La lectura histórica consulta Atom en cada actualización de la caché de un minuto. No hay evaluaciones automáticas activas.

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
ATOM_DB_NAME=dbAtom
ATOM_DB_USER=USUARIO_SOLO_LECTURA
ATOM_DB_PASSWORD=CONTRASEÑA_DE_ATOM
ATOM_DB_SSL=false
ATOM_CONVERSATIONS_TABLE=tblConversaciones
ATOM_MESSAGES_TABLE=tblEventosConversacion
ATOM_AGENTS_TABLE=tblAsesores
ATOM_DOCUMENTS_TABLE=tblDocumentosConversacion
ATOM_CHANNELS_TABLE=tblCanales
ATOM_COUNTRIES_TABLE=dbSomos3c_2.tblCatalogoPaises
```

Los valores de host, usuario y contraseña son **marcadores**, no credenciales válidas. Se editan solo en `api/.env`, excluido de Git. `APP_DB_*` usa `dbPulsosAtom`; `ATOM_DB_*` lee `dbAtom` y el catálogo corporativo de países. `DEMO_MODE=true` mantiene las pantallas con datos sintéticos separados de ambas bases.

Cuando exista `dbPulsosAtom`, se completan `APP_DB_*` y se ejecuta desde `api/`:

```sh
npm run db:migrate
npm run db:seed
npm run user:create
```

Después de crear una cuenta real, se cambia `DEMO_MODE=false` y se reinicia la API. El esquema y el seed ya se verificaron en la conexión proporcionada. El histórico se probó con 233 conversaciones: 165 de Costa Rica, 64 de Honduras y 4 de El Salvador. Falta acordar el criterio de conversación lista para evaluar y cómo tratar ediciones posteriores en la evaluación automática.
