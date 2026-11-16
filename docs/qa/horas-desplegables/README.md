# QA: horas locales y desplegables

Fecha: 2026-11-16. Rama: `codex/horas-locales-desplegables`, desde `main` (`26f3115`). Trabajo en copia aislada; la carpeta original y sus cambios locales se conservan.

Se revisaron los videos `Problema.mp4` y `Grabación de pantalla 2026-11-16…mov`. El primero muestra foco en los filtros sin opciones visibles; el segundo muestra las opciones en Safari. El usuario confirmó Chrome para el equipo afectado y la capital como criterio horario. Los videos originales no se incorporaron al repositorio.

## Cambios

La API incorpora `displayTimezone` y `displayTimezoneSource` en conversaciones, listados y validación humana. Panamá usa `America/Panama`; los seis países del catálogo demo también tienen zona. Para países con varias zonas se usa la capital: México, por ejemplo, usa `America/Mexico_City`. Se incluyen otras capitales regionales en `api/src/conversation-timezone.js`. Un país sin correspondencia muestra UTC con un aviso explícito.

`COUNTRY_TIMEZONES` permite excepciones operativas mediante un objeto JSON ISO→IANA en el backend; la configuración inválida se rechaza al iniciar. No es necesario definirlo para los países incluidos. La zona explícita de una conversación, si existe, tiene prioridad. `APP_TIMEZONE` mantiene los cortes de reporte y automatización. No hay migración ni modificación de las fechas UTC, las huellas de evaluación, las asignaciones o los resultados guardados.

La transcripción, las evidencias, las revisiones, las métricas y las vistas de conversación comparten la conversión local. Los separadores de mensajes cambian al día local; los intervalos que cruzan medianoche indican ambas fechas. `Intl.DateTimeFormat` aplica las reglas históricas de zona y horario de verano disponibles en el entorno; no se restan horas fijas. Referencia: [base de zonas IANA](https://www.iana.org/time-zones).

Los Select escritos por el portal comparten un componente que admite un clic completo sin depender únicamente de `mousedown`. Mantiene teclado, búsqueda, selección, cierre y estados deshabilitados. No reabre al escoger una opción, borrar una selección o retirar una etiqueta. La flecha es decorativa y no intercepta eventos. Se elimina la animación de apertura de estos menús y se ajusta su capa, conservando el contexto de paneles y modales. Los controles internos de Ant Design reciben el tema común. Se utilizó el contrato de apertura de [Select](https://ant.design/components/select/) y se contrastó con la versión instalada 5.29.3.

## Checklist QA

### Horas y consistencia funcional

- Estado: cumple.
  Criticidad: media.
  Hallazgo: la transcripción usaba Honduras para todos los países; ahora usa la zona explícita del país/capital.
  Evidencia: pruebas de API y `conversation-time.test.js`; ejemplo sintético en Chrome: `2026-11-16T01:39Z` → 15 de noviembre, 20:39, Panamá.
  Comportamiento esperado: misma hora local en transcripción, citas y vistas relacionadas, independiente de la zona del equipo.
  Recomendación: conservar la conversión centralizada y los datos de origen en UTC.

### Flujo, acciones, formularios y estados

- Estado: cumple en el entorno probado.
  Criticidad: media.
  Hallazgo: texto, superficie y flecha admiten apertura; las opciones son seleccionables y el cierre funciona. Búsqueda de asistente y selección múltiple de países verificadas.
  Evidencia: Chrome 157.0.8103.51; seis filtros de Búsqueda expandidos con opciones visibles y opacidad 1; pruebas DOM con los componentes reales de React/Ant Design.
  Comportamiento esperado: clic en la caja, navegación por teclado, Escape, limpiar y quitar etiquetas sin reaperturas accidentales; discapacidad individual o heredada del formulario respetada.
  Recomendación: reutilizar `components/Select.jsx` en los nuevos campos.

### Tablas, listados, paneles y presentación

- Estado: cumple en el entorno probado.
  Criticidad: media.
  Hallazgo: los listados muestran horas de la misma zona que el detalle; el menú de métricas queda visible sobre el panel. Los intervalos que abarcan dos fechas locales muestran ambas.
  Evidencia: capturas adjuntas; menú de métricas con capa 1150 y control administrativo de selección con opciones visibles.
  Comportamiento esperado: menú accesible sin quedar tapado y fechas consistentes con las horas.
  Recomendación: mantener la zona de cálculo indicada junto a la zona de presentación.

### Robustez y navegación

- Estado: cumple.
  Criticidad: media.
  Hallazgo: las pruebas no detectan regresiones en API, web o rutas base. Tiempos ausentes o ambiguos no se interpretan usando la zona del navegador.
  Evidencia: 632 pruebas API y 135 web aprobadas; compilación de producción bajo `/pulsoAtom`; pruebas de DST de Nueva York y Santiago, reglas históricas de México y medianoche en Panamá. Clic y opciones también comprobados en el navegador integrado.
  Comportamiento esperado: conservar origen, histórico, cuotas, consenso y agrupación operativa de jornadas.
  Recomendación: ejecutar estas regresiones al modificar formatos o controles comunes.

### Reproducción del reporte y compatibilidad

- Estado: revisar.
  Criticidad: media.
  Hallazgo: la falla persistente del video no se reprodujo exactamente en el Chrome disponible. La corrección protege apertura y visibilidad, pero no demuestra una causa única en el equipo afectado.
  Evidencia: el video no incluye versión de Chrome ni estado de extensiones. El caso real de Panamá aún no tiene ID/fecha para cotejar el dato de Atom. Safari nativo no ofreció una ventana controlable para esta sesión; su comportamiento original se observó en el video.
  Comportamiento esperado: confirmar el mismo resultado en el equipo del reporte y cotejar una conversación real con su UTC de origen.
  Recomendación: repetir los clics en ese Chrome tras actualizar el portal, verificar Safari y aportar el ID del caso de Panamá si persiste el desfase.

No aplica cambiar altas, bajas, permisos, validaciones de negocio o persistencia de catálogos: esta corrección solo reemplaza sus selectores. Se conservaron etiquetas, tildes y navegación; las pruebas existentes de permisos, configuración y evaluación se mantienen aprobadas.

## Resumen ejecutivo

Implementación local terminada y verificada. Chrome abre las opciones de los seis filtros reportados; la muestra sintética de Panamá muestra 20:39 y el cambio de día a las 00:00. El ejemplo demuestra la conversión; no sustituye la verificación de la conversación real.

## Hallazgos críticos

No hay hallazgos críticos nuevos confirmados en las pruebas. La reproducción final en el equipo afectado y el cotejo del registro real permanecen pendientes.

## Riesgos funcionales

La exactitud de las reglas históricas depende de una base IANA actualizada en el navegador/sistema. Las fechas sin offset no se presentan como instantes válidos. Países nuevos sin zona configurada muestran UTC identificado. La hora local puede caer en otra fecha respecto de la jornada de reporte de Honduras.

## Desviaciones visuales

Se añade una indicación de zona y se retira la animación del menú. No se detectaron opciones tapadas en Chrome. La compilación conserva el aviso existente de tamaño de algunos chunks.

## Recomendaciones prioritarias antes de liberar a producción

1. Revisar e integrar esta rama mediante el flujo normal de publicación; todavía no se ha desplegado esta corrección.
2. Repetir el recorrido del video en el Chrome afectado y validar Safari.
3. Cotejar el caso original de Panamá con ID, fecha y timestamp UTC de Atom. No alterar el dato de origen basándose solo en el ejemplo sintético.

## Evidencia visual

Solo datos sintéticos locales:

- [Conversación de Panamá](panama-chrome.jpg).
- [Panel con horas locales y opciones visibles](panel-chrome.jpg).
- [Filtros en Chrome](filtros-chrome.jpg).
- [Filtros en navegador integrado](filtros-iab.jpg).
