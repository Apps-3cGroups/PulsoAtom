# QA intensivo — Pulso

Fecha: 27 de octubre de 2026. Alcance comprobado: portal claro bajo `/pulso`, modo demo, lectura real de Atom mediante una instancia QA local de solo lectura y catálogo en `dbPulsosAtom`. La instancia QA utilizó una cuenta temporal en memoria; no creó usuarios ni evaluaciones en MySQL. La ejecución de IA aún no existe.

## Resumen ejecutivo

El histórico, búsqueda, detalle y catálogo funcionan en el alcance probado y conservan una separación visible entre datos demo y reales. El diseño claro mantiene la marca, las cinco métricas, las prioridades P1/P2, las figuras y el mapa por país/asistente del ejemplo. La vista real tiene menor densidad porque solo muestra conversaciones existentes; no se añadieron flags ficticios. No está listo para producción: faltan cuenta real, motor de evaluación, procesamiento diario y pruebas de persistencia de extremo a extremo con una sesión real.

## Estado general

| Área | Estado | Evidencia |
| --- | --- | --- |
| Diseño claro | Aprobado con ajustes | Comparación visual con `Pulso_prototipo.html`, `Directrices_Pulso.html` y la captura original; [resumen](pulso-resumen.png), [catálogo](pulso-catalogo.png), [catálogo móvil](qa-catalogo-movil.png). |
| Navegación y rutas | Aprobado | Recorrido en `/pulso`, histórico, conversación, búsqueda, catálogo y evaluaciones; recarga de ruta interna en `web/test/server.test.js`. |
| Catálogo | Aprobado en demo y lectura real | 130 variables, 12 activas; alta y edición protegidas por rol; formulario vacío, selección entre páginas, filtros, confirmación y cancelación comprobados en navegador. |
| Atom | Aprobado para lectura del histórico actual | 233 conversaciones, 9,937 mensajes visibles, países CR 165, HN 64 y SV 4; sin IDs duplicados ni campos obligatorios faltantes. |
| Base propia | Aprobado para lectura; escrituras reales pendientes de QA | 16 tablas; los 130 IDs y 12 estados activos coinciden con la importación del Excel. Cero usuarios, evaluaciones y revisiones reales. |
| Evaluación y horario | Bloqueado por alcance pendiente | Pantalla informa que IA y lotes faltan; iniciar evaluación está deshabilitado y guardar horario no activa el proceso. |
| Responsive | Aprobado en 390 px para las vistas recorridas | Sin desplazamiento horizontal de página en resumen, catálogo y detalle; la tabla del catálogo desplaza sus columnas sin tapar el nombre de la variable. |

## Bugs por categoría

| ID | Categoría | Severidad | Hallazgo y corrección | Evidencia |
| --- | --- | --- | --- | --- |
| V-01 | Responsive | Medio | Las columnas derechas fijas del catálogo tapaban el nombre de la variable en móvil. Se desactivó su posición fija bajo 700 px; la tabla conserva scroll horizontal. | `web/src/styles.css`, `web/src/pages/Catalog.jsx`, [captura móvil](qa-catalogo-movil.png). |
| F-01 | Consistencia funcional | Medio | El detalle de una conversación pendiente mostraba un panel vacío con el título “Checklist de esta evaluación”. Ahora presenta las 12 variables activas como checklist previsto, todas marcadas “No evaluada”. | `web/src/pages/Conversation.jsx`; comprobación con conversación real sin evaluación. |
| F-02 | Catálogo / lotes | Medio | Una selección podía quedar oculta al cambiar filtros y seguir disponible para activar/inactivar. El cambio de filtros o búsqueda ahora limpia la selección; el cambio de página la conserva. | `web/src/pages/Catalog.jsx`; prueba de selección en dos páginas y posterior búsqueda. |
| C-01 | Contenido | Bajo | El acceso real enumeraba los seis países del demo; ahora solo los enumera en demo. “sistema” se muestra como “Sistema” y el estado vacío del histórico ya no sugiere conectar una fuente que funciona. | `web/src/App.jsx`, `web/src/pages/Conversation.jsx`, `web/src/pages/Conversations.jsx`. |
| D-01 | Datos | Bajo | El selector de países podía incluir códigos de conversaciones sin documento listo. Ahora usa el mismo criterio `Estado = 'LISTO'` que el histórico. | `api/src/atom.js`; lectura SQL repetida contra Atom. |

## Checklist QA

### Flujo, navegación y botones

- Estado: cumple. Criticidad: media. Resumen → histórico → detalle → búsqueda → mensaje coincidente funcionó con datos reales. El enlace a Atom está deshabilitado porque todavía no se conoce una URL válida. Las rutas internas permanecen bajo `/pulso`.
- Estado: cumple. Criticidad: media. Los botones de IA y programación están deshabilitados con explicación; la API devuelve conflicto si se intenta ejecutar una evaluación no implementada.

### Catálogo, formularios, tablas y modales

- Estado: cumple. Criticidad: media. Agregar, editar, activar/inactivar y listado conviven en la misma pantalla para administradores; supervisores solo consultan. El formulario vacío muestra errores y la cancelación no altera el contador de activas.
- Estado: cumple. Criticidad: media. Selección entre páginas, filtro, búsqueda, paginación y limpieza de selección comprobadas en navegador. La tabla móvil conserva nombres legibles y las acciones quedan disponibles al desplazar horizontalmente.
- Estado: revisar. Criticidad: crítica para liberar. No existe una cuenta real en `users`; por eso no se probaron altas, ediciones y revisiones con sesión y persistencia MySQL reales. Las pruebas automatizadas cubren el flujo con almacenes de prueba y demo.

### Datos e integración

- Estado: cumple. Criticidad: media. La consulta real resolvió países mediante `dbSomos3c_2.tblCatalogoPaises`; el historial obtuvo 233 conversaciones con documentos `LISTO` y 9,937 mensajes de contenido. Los eventos `log` y `note` no se muestran como mensajes de conversación.
- Estado: cumple. Criticidad: media. Las 130 variables importadas coinciden por ID y estado activo con el catálogo de MySQL; ninguna evaluación simulada aparece en modo real.
- Estado: revisar. Criticidad: alta para escalar volumen. El adaptador carga el histórico completo de Atom y usa caché de un minuto; aún no hay paginación SQL ni lectura incremental.
- Estado: revisar. Criticidad: alta para producción. IA, reintentos, idempotencia y programación diaria todavía no existen; se mantienen bloqueados de forma explícita.

### Visual, accesibilidad y robustez

- Estado: cumple. Criticidad: media. Tema claro, tipografías, jerarquía, P1/P2, colores de refutación y alerta humana, y mapa de rectángulos contrastados con el prototipo. En datos reales, las métricas sin evaluación muestran “—” y las conversaciones pendientes “?”, sin convertir ausencia de análisis en ausencia de riesgo.
- Estado: cumple. Criticidad: media. Vistas principales comprobadas a ancho de escritorio y 390 px; sin desbordamiento horizontal de página. Cargas, errores, vacío y estados deshabilitados están presentes.
- Estado: revisar. Criticidad: menor. Falta comprobar dispositivos físicos y lectores de pantalla. El bundle inicial de Vite sigue avisando por tamaño aproximado de 878 kB antes de compresión.

## Prompts para corregir con Codex

```text
Contexto: Pulso en web/ y api/, ruta base /pulso. La lectura de Atom funciona, pero la evaluación no.
Objetivo: implementar evaluación a demanda y diaria de las 12 variables activas, sin resultados ficticios.
Instrucciones: usar los IDs de conversación y mensaje de Atom, conservar versión de checklist, registrar resultados y evidencia en dbPulsosAtom, añadir idempotencia, reintentos y pruebas con conversaciones autorizadas.
Restricciones: Atom solo lectura; no copiar transcripciones completas a Pulso; mantener web/api separados.
Criterios de aceptación: ejecución visible de inicio a fin, estados y errores verificables, resultados auditables, re-evaluación sin sobrescribir la anterior.
```

```text
Contexto: el histórico actual carga todas las conversaciones y eventos de Atom en una caché de un minuto.
Objetivo: escalar consultas de resumen, histórico, búsqueda y detalle.
Instrucciones: paginar y filtrar en SQL, medir con el volumen real, mantener los mismos conteos y orden visible, e indexar los campos usados.
Restricciones: conservar /pulso y la separación entre bases.
Criterios de aceptación: resultados y filtros equivalentes al adaptador actual; tiempos y carga medidos; sin acceso de escritura a Atom.
```

## Criterio de salida

Antes de liberar: crear cuenta real, cambiar `DEMO_MODE=false`, probar autenticación y operaciones de catálogo/revisión contra `dbPulsosAtom`, implementar y validar IA y lotes, verificar HTTPS/cookies del despliegue, y medir con un histórico mayor. El bundle grande y la prueba en dispositivos físicos siguen como riesgos de rendimiento y presentación.

## Hallazgos críticos

No se detectaron fallos críticos en los recorridos ejecutados. La evaluación con IA y la cuenta real faltan por diseño y bloquean la salida a producción.

## Riesgos funcionales

El histórico real es legible y buscable, pero todas las conversaciones siguen pendientes. No hay resultados ni flags auténticos para validar el flujo humano de revisión sobre MySQL. El procesamiento diario permanece inactivo.

## Desviaciones visuales

El tema es claro, como se solicitó. La barra “En curso” del prototipo se reemplazó por Histórico porque no hay ingestión en tiempo real. La densidad del mapa depende de los datos existentes; no se rellenó con actividad simulada en modo real.

## Recomendaciones prioritarias antes de liberar a producción

1. Crear una cuenta administradora real y probar persistencia y permisos con la base propia.
2. Implementar el evaluador y el procesador diario con evidencia y versiones.
3. Pasar el histórico de la carga completa a consultas paginadas e incrementales.
4. Validar el diseño en dispositivos reales y monitorear tiempos y errores de la integración.
