# Validación de Pulso · primera entrega

Fecha: 26 de octubre de 2026. Alcance: portal local con datos demostrativos, API y base de integración futura. Se usaron pruebas automatizadas, revisión del código y navegación real en el navegador integrado; las pruebas de base real y de IA están fuera de esta entrega.

Resultado ejecutado: **11 pruebas de API y 1 del servidor web aprobadas; compilación Vite correcta**. La compilación final también se sirvió con `web/server.js` y se comprobó la recarga de `/pulso/catalogo`. La comprobación visual del tema claro cubre una ventana de escritorio de aproximadamente 1012 px de ancho.

## Checklist QA

### 1. Flujo completo

- Estado: cumple
  Criticidad: critica
  Hallazgo: ingreso demo, navegación, búsqueda, apertura del mensaje coincidente, revisión humana y retorno al resumen funcionan.
  Evidencia: recorrido manual en `/pulso/busqueda?q=cancelar` → `/pulso/conversacion/DEMO-MX-0001`; prueba de refutación y deshacer.
  Comportamiento esperado: consultar y revisar sin abandonar el portal ni perder la evidencia original.
  Recomendación: repetir el recorrido con conversaciones reales cuando se conecte Atom.

### 2. Botones y acciones

- Estado: cumple
  Criticidad: critica
  Hallazgo: guardar, cancelar, cerrar, editar y cambiar estados tienen acción real. Evaluar, habilitar programación y abrir Atom están bloqueados cuando no existe integración.
  Evidencia: guardado de catálogo y horario, modal de revisión, `api/test/portal.test.js`, mensajes visibles en Evaluaciones.
  Comportamiento esperado: confirmar éxitos únicamente después de una operación persistida y explicar los controles no disponibles.
  Recomendación: conservar el bloqueo hasta completar los adaptadores.

### 3. Links y navegación

- Estado: cumple
  Criticidad: critica
  Hallazgo: rutas, recursos y API usan `/pulso`. Las rutas internas recargan y el prefijo llega intacto a la API.
  Evidencia: `web/test/server.test.js`; recarga manual del catálogo y de Evaluaciones; recarga del catálogo en la compilación Express.
  Comportamiento esperado: no redirigir a `/` ni devolver un 404 en rutas válidas del portal.
  Recomendación: repetir estas pruebas al colocar un proxy o dominio de despliegue.

### 4. Catálogos y mantenimientos

- Estado: cumple
  Criticidad: critica
  Hallazgo: agregar, editar, activar/inactivar y listado conviven en el catálogo. El estado visible coincide con la acción por fila.
  Evidencia: `web/src/pages/Catalog.jsx`, captura `pulso-catalogo.png`; altas y duplicados por API; edición en navegador; activación de dos variables, contador de 12 a 14 e inactivación de retorno a 12.
  Comportamiento esperado: conservar 130 variables iniciales y permitir su mantenimiento con versiones.
  Recomendación: mantener las tres plantillas de guion inactivas hasta definir puntos concretos.

### 5. Formularios

- Estado: cumple
  Criticidad: critica
  Hallazgo: campos obligatorios, código único, longitudes, formato, versión esperada y evidencia se validan. Se comprobó persistencia demo después de recargar.
  Evidencia: envío vacío de Agregar variable; cambio y restauración del nombre de `resultado_conversacion`, versiones 1–3 visibles; pruebas automatizadas de duplicado, conflicto y evidencia; horario cambiado a 08:00 y restaurado a 07:00 tras recarga.
  Comportamiento esperado: no guardar datos inválidos ni sobrescribir cambios concurrentes.
  Recomendación: validar transacciones contra la base real antes de habilitar su uso.

### 6. Ortografía, redacción y tildes

- Estado: cumple
  Criticidad: menor
  Hallazgo: se completaron nombres visibles con tildes y frases legibles, manteniendo los códigos originales del Excel. Se corrigió la etiqueta de revisión para incluir tanto administradores como supervisores.
  Evidencia: `api/src/data/catalog-labels.json`, `catalog.json`, `web/src/pages/Conversation.jsx`.
  Comportamiento esperado: mostrar nombres claros sin cambiar el identificador de cada variable.
  Recomendación: revisar nomenclatura de negocio al incorporar las siguientes etapas del checklist.

### 7. Estados de carga, espera y feedback

- Estado: cumple
  Criticidad: media
  Hallazgo: se muestran cargas, errores con reintento, resultados vacíos y confirmaciones de guardado. La indisponibilidad temporal de la API se presentó como error y el reintento recuperó el catálogo.
  Evidencia: reinicio de API durante QA; mensajes «Variable actualizada en la demostración», «2 variables actualizadas» y «La programación sigue inactiva».
  Comportamiento esperado: no presentar resultados ficticios ni confirmar operaciones fallidas.
  Recomendación: ampliar los casos de errores reales de Atom y del proveedor de IA al conectarlos.

### 8. Revisión visual y alineación con diseño

- Estado: cumple
  Criticidad: media
  Hallazgo: el portal utiliza un tema claro con los verdes, las figuras y colores de prioridad, el mapa por país/asistente y la jerarquía del prototipo. Se corrigió la visibilidad del estado en el catálogo.
  Evidencia: `pulso-resumen.png`, `pulso-catalogo.png`, comparación con los HTML y la captura proporcionados; revisión manual de tema claro.
  Comportamiento esperado: adaptar el diseño al histórico y al catálogo sin mostrar actividad en tiempo real.
  Recomendación: revisar conjuntamente la densidad visual al mostrar un volumen real mayor.

- Estado: revisar
  Criticidad: media
  Hallazgo: existen reglas responsive, pero no se ejecutó una prueba en un dispositivo móvil físico ni en todos los tamaños de pantalla.
  Evidencia: reglas de 700, 980, 1200 y 1500 px en `web/src/styles.css`; capturas de escritorio disponibles.
  Comportamiento esperado: navegación, drawers y tablas accesibles en pantallas pequeñas.
  Recomendación: validar en los dispositivos que se usarán antes de liberar a producción.

### 9. Tablas o listados

- Estado: cumple
  Criticidad: media
  Hallazgo: hay búsqueda, filtros, paginación, estados y selección por lotes; las filas y los contadores se actualizan después de guardar.
  Evidencia: pruebas de filtros/fechas/paginación; búsqueda manual «cancelar» devuelve 8 conversaciones; prueba manual de lote en la compilación final.
  Comportamiento esperado: resultados coherentes con los filtros y sin alterar el histórico al cambiar el catálogo.
  Recomendación: probar con el tamaño real del histórico al integrar consultas SQL paginadas.

### 10. Modales

- Estado: cumple
  Criticidad: media
  Hallazgo: los drawers de edición e historial abren y cierran; los modales de activación y revisión explican su efecto y permiten cancelar.
  Evidencia: envío vacío, edición/restauración, historial de versiones, confirmación de lote y modal de deshacer revisión en el navegador.
  Comportamiento esperado: mantener el contexto y requerir motivo/comentario al revisar flags.
  Recomendación: conservar las confirmaciones para cambios de estado por lote.

### 11. Consistencia funcional

- Estado: cumple
  Criticidad: critica
  Hallazgo: no evaluado se distingue de cero; la evaluación conserva versiones; refutar y deshacer agregan eventos; el modo real nunca recurre a datos demo.
  Evidencia: pruebas 4, 6, 7, 8 y 10 de API; revisión manual con dos eventos en `DEMO-MX-0001`.
  Comportamiento esperado: mostrar resultado base, evidencia y revisión humana sin reescribir el pasado.
  Recomendación: preservar esta separación al incorporar el evaluador automático.

### 12. Robustez general

- Estado: cumple
  Criticidad: media
  Hallazgo: se corrigió la advertencia de compatibilidad de Ant Design 5 con React 19 usando el paquete oficial. No se observaron nuevas advertencias ni errores de consola en el recorrido final de la compilación.
  Evidencia: `web/src/main.jsx`, paquete `@ant-design/v5-patch-for-react-19`, [documentación oficial](https://5x.ant.design/docs/react/v5-for-19/), consola después del arranque final.
  Comportamiento esperado: renderizado y modales compatibles con las versiones instaladas.
  Recomendación: mantener el paquete mientras se use esta combinación de versiones.

- Estado: revisar
  Criticidad: media
  Hallazgo: la compilación avisa de un paquete inicial de aproximadamente 883 kB (283 kB comprimido). El adaptador MySQL inicial carga el estado completo y todavía no está probado con volumen real.
  Evidencia: salida de `npm run build`, `api/src/store.js`.
  Comportamiento esperado: carga y consultas adecuadas al entorno de producción.
  Recomendación: medir con volumen y red reales; dividir dependencias y pasar filtros/paginación a SQL antes de importar un histórico grande.

### 13. Estándares adicionales

- Estado: cumple
  Criticidad: critica
  Hallazgo: permisos visibles y de API son coherentes; el supervisor consulta el catálogo sin acciones de modificación. Configuración sensible separada del navegador y archivos `.env` ignorados.
  Evidencia: acceso manual como supervisor; pruebas de 401/403, origen autorizado, cookies y cierre de sesión; `.gitignore`, archivos de ejemplo y `api/src/auth.js`.
  Comportamiento esperado: aplicar permisos también en el servidor y mantener secretos fuera del frontend.
  Recomendación: verificar cuentas reales, HTTPS y configuración del despliegue antes de publicar.

## Resumen ejecutivo

La primera entrega funciona con datos demostrativos persistidos localmente. Catálogo, revisiones y configuración tienen operaciones verificadas. La evaluación real permanece bloqueada y los datos de ejemplo están identificados.

## Hallazgos críticos

No hay fallos críticos confirmados en el alcance local probado. No se certifica producción: faltan conexión MySQL, autenticación con cuentas reales, integración de Atom y ejecución de IA.

## Riesgos funcionales

Persistencia y concurrencia MySQL sin ejecutar; importación incremental y procesamiento diario pendientes; volumen real y casos de no aplicabilidad por variable pendientes. Las modificaciones demo no se migran automáticamente al modo real.

## Desviaciones visuales

Se sustituyó actividad en tiempo real por histórico y última carga; se añadieron Catálogo y Evaluaciones, la banda DEMO y estados pendientes. El resumen utiliza 216 conversaciones sintéticas, por lo que su mapa tiene menor densidad que la referencia. La revisión móvil sigue pendiente.

## Recomendaciones prioritarias antes de liberar a producción

1. Recibir la conexión y nombres de tablas; inspeccionar columnas y relaciones sin modificar Atom.
2. Ejecutar migraciones, cuentas, persistencia y conflictos contra MySQL.
3. Implementar importación incremental y consultas paginadas con índices adecuados.
4. Validar las 12 variables iniciales con evidencia real y conectar el procesador de lotes y el horario diario.
5. Completar pruebas de dispositivos, volumen y configuración del despliegue.
