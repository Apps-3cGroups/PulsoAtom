# QA — Doble revisión del flag operativo

Fecha: 3 de noviembre de 2026. Rama: `codex/dual-model-flag-review`.
Este informe corresponde a esta integración sobre main/PR7; los informes anteriores de octubre son históricos.

## Checklist QA

### 1. Flujo completo y consistencia

- Estado: cumple
  Criticidad: critica
  Hallazgo: dos revisiones independientes producen un solo flag; se incluyen detecciones exclusivas del segundo modelo. Cambiar la política no ejecuta IA ni modifica el histórico.
  Evidencia: `multi-model.test.js`, `model-routes.test.js`; prueba local de 20 conversaciones/40 revisiones sintéticas.
  Comportamiento esperado: mantener identidad de cada respuesta y no duplicar alertas.
  Recomendacion: conservar estas pruebas como regresión.

### 2. Acciones, formularios y permisos

- Estado: cumple
  Criticidad: critica
  Hallazgo: solo administración modifica la política/ejecuta. Segundo modelo obligatorio y distinto; conflictos de versión rechazados. La política se guardó desde la UI demo con confirmación y quedó persistida.
  Evidencia: API 403/409/422; formulario `ModelControls`, política demo versión 2.
  Comportamiento esperado: guardado real, errores visibles, controles deshabilitados mientras se guarda.
  Recomendacion: configurar credenciales solo mediante entorno backend.

### 3. Catálogos y mantenimiento

- Estado: cumple
  Criticidad: media
  Hallazgo: los perfiles se registran/habilitan en configuración de despliegue; el formulario es una política versionada, no un CRUD de credenciales. La selección lista disponibles y pendientes; permite cambiar entre doble revisión y principal/respaldo.
  Evidencia: `model-registry.js`, `model-routes.js`, `ModelControls.jsx`.
  Comportamiento esperado: no crear/borrar credenciales desde el navegador. El catálogo de variables conserva su CRUD existente.
  Recomendacion: mantener esta separación; agregar, editar y activar perfiles corresponde a configuración backend por diseño.

### 4. Paneles, modales y revisiones

- Estado: cumple
  Criticidad: critica
  Hallazgo: GPT/Gemini muestran resultado, justificación, citas y criterio. Una refutación conserva ambas respuestas, autor, motivo y fecha. Guardar ya no desmonta el panel. Solo la conversación completa permite levantar flags omitidos.
  Evidencia: `QuickView`, `FlagModelComparison`, `ReviewModal`; refutación de discrepancia y de acuerdo probadas desde UI demo; imagen `pulso-doble-revision-demo.png`.
  Comportamiento esperado: revisión humana común sin reemplazar originales.
  Recomendacion: conservar la separación entre cita de evidencia y transcripción completa.

### 5. Navegación y enlaces

- Estado: cumple
  Criticidad: media
  Hallazgo: rutas anidadas recargables; vuelta a flags, cierre de panel y acceso a conversación completa mantienen navegación existente.
  Evidencia: pruebas web de servidor/proxy, recarga directa de Evaluaciones en `/pulsoAtom` y navegación de la demo.
  Comportamiento esperado: no redirigir fuera de la subruta.
  Recomendacion: compilar con la misma subruta en API y web.

### 6. Carga, feedback y robustez

- Estado: cumple
  Criticidad: critica
  Hallazgo: reintentos limitados, fallos visibles y reanudación sin repetir éxitos. Cero con respuesta pendiente/abstención no se interpreta como ausencia confirmada. Si Atom cambia durante la llamada, no se publica el resultado. La actualización del panel no produce un loader de página completa.
  Evidencia: pruebas de contingencia, actualización del origen, idempotencia y guardado; `useApi` conserva datos de la misma consulta.
  Comportamiento esperado: ningún fallo se convierte en voto o cero.
  Recomendacion: revisar intentos desde el historial cuando una ejecución quede parcial.

### 7. Tablas y redacción

- Estado: cumple
  Criticidad: media
  Hallazgo: historial distingue conversaciones de revisiones completadas/total, errores y estado en español. No muestra porcentajes de certeza basados en acuerdo.
  Evidencia: UI: 20 conversaciones, 40/40 revisiones, cero errores; `Evaluations.jsx` y `FlagModelComparison.jsx`.
  Comportamiento esperado: cifras y etiquetas no mezclan tareas por modelo con conversaciones.
  Recomendacion: mantener las columnas separadas al agregar más proveedores.

### 8. Revisión visual

- Estado: cumple
  Criticidad: media
  Hallazgo: Resumen sin desplazamiento exterior en 1366×768, 1440×900 y 1920×1080; panel con scroll interno. En 390×844 las columnas se apilan y conservan ancho visible (327 px) y botón inferior.
  Evidencia: mediciones DOM iguales al viewport y capturas en navegador; `pulso-doble-revision-demo.png`.
  Comportamiento esperado: mapa protagonista y evidencia legible sin desbordamiento horizontal.
  Recomendacion: comprobar también equipos físicos de los supervisores antes de publicación amplia.

### 9. Conservación de datos y proveedores reales

- Estado: revisar
  Criticidad: critica
  Hallazgo: no se aplicó una migración ni se ejecutó Gemini real en esta entrega. Localmente faltan su clave/modelo/habilitación. Pruebas SQL de persistencia usan conexión simulada; no sustituyen validar en el servidor.
  Evidencia: `api/.env` inspeccionado solo para presencia de configuración; suite `mysql-store.test.js`; migración 002 aditiva.
  Comportamiento esperado: verificar migración aplicada, conteos históricos y funcionamiento real antes de publicar.
  Recomendacion: con respaldo y sin lotes activos, verificar/aplicar migraciones; configurar Gemini y ejecutar un piloto explícito. No reevaluar todo el histórico.

### 10. Arquitectura y estándares adicionales

- Estado: cumple
  Criticidad: critica
  Hallazgo: React/Ant Design y Node/Express/MySQL separados; claves solo backend. Evaluaciones originales y referencias operativas separadas; código sin votos y reglas híbridas identificadas. La lógica existente de abiertas/modificadas continúa y no se segmentan atenciones.
  Evidencia: `operational-evaluation.js`, adaptadores, pruebas `refresh.test.js` y `multi-model.test.js`.
  Comportamiento esperado: datos demo separados; Atom de solo lectura.
  Recomendacion: no presentar la demo como resultados reales.

## Resumen ejecutivo

Implementación y revisión local completadas. Compilación web aprobada. Pruebas: 77 API y 19 web. La muestra visual contiene datos sintéticos identificados. No hubo consumo externo de IA ni cambios de configuración de producción.

## Hallazgos criticos

No quedan fallos funcionales confirmados en los flujos locales probados. La validación MySQL/proveedores reales y la migración en el servidor permanecen pendientes antes de publicar.

## Riesgos funcionales

Gemini requiere credencial y modelo propios, habilitados en el backend. La API nueva necesita las tablas de migración 002. El despliegue existente no aplica migraciones automáticamente. Las versiones históricas sin contexto equivalente no se incorporan automáticamente a una doble revisión.

## Desviaciones visuales

No se observaron desbordamientos en los tamaños comprobados. En móvil se utiliza una columna. Vite advierte que el bundle principal supera 500 kB; la compilación finaliza y las pantallas usan carga diferida.

## Recomendaciones prioritarias antes de liberar a produccion

1. Verificar/aplicar migración 002 con respaldo y sin lotes activos, antes de fusionar/desplegar.
2. Configurar Gemini, reiniciar API y guardar la política elegida.
3. Ejecutar un piloto real pequeño y explícito, comprobar ambas respuestas y el consumo.
4. Mantener el resultado operativo único y revisar discrepancias humanas sin interpretar acuerdo como certeza.
