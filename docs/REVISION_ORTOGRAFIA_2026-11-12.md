# Revisión ortográfica de Pulso — 12 de noviembre de 2026

## Alcance y resultados

Revisión de los textos propios del portal: inicio de sesión, navegación, Resumen, Activas, conversación y sus pestañas, histórico, búsqueda, validación, comparación, catálogo, modelos, evaluaciones, accesos, programación, mensajes, estados, filtros, ayudas, tooltips y formularios. Se revisaron los 56 módulos JavaScript/JSX existentes de `web/src`, el HTML de entrada, los mensajes del servidor web y el monitor de seguimiento publicado. Se añadió un módulo de presentación durante la corrección.

La auditoría de las fuentes de API incluyó mensajes de autenticación, accesos, validación, modelos, métricas, programación e integraciones, además de 93 variables vigentes, 130 históricas, 107 etiquetas y 31 notas. El monitor de seguimiento no necesitó cambios ortográficos.

| Incidencia | Antes | Después | Lugares corregidos |
|---|---|---|---|
| O-01 | Mexico | México | Selectores, Resumen, mapa de 30 días, Activas, histórico/búsqueda y detalle, cuando el código es MX |
| O-02 | Panama | Panamá | Los mismos lugares, cuando el código es PA |
| O-03 | Mexico City | Ciudad de México | Selector de zona horaria y estado de la programación |
| O-04 | guión | guion | Dos descripciones del catálogo; tres apariciones en su fuente: definición, condición y disponibilidad. Se corrigen únicamente al mostrarlas en catálogo, editor, versiones, validación y detalle del criterio |
| O-05 | Agente humano + Bot | agente humano + bot | Explicación de los mensajes del día en las métricas de conversación |

O-01 y O-02 estaban confirmadas en la captura del portal; los nombres se reciben de Atom. Se corrigen solo las etiquetas por código. Las vistas que ya muestran códigos, como HN o PA, conservan ese formato.

La búsqueda de países acepta México/Mexico, Panamá/Panama y sus códigos. Esta comprobación evitó que añadir las tildes dificultara buscar sin ellas.

No se encontraron otras faltas de tilde confirmadas en los textos propios revisados. Esto no transforma el contenido libre que se importe o escriba en el futuro.

## Datos conservados

- Mensajes originales de las conversaciones, citas y evidencia, con todos sus errores originales.
- Nombres de personas, comentarios humanos y respuestas de modelos.
- Códigos de países, filtros, parámetros, zonas horarias y valores almacenados.
- Catálogo fuente, versiones históricas, reglas, prompts, colas y configuración de evaluación.
- API y proceso evaluador: ningún archivo modificado.

`catalogText` reconoce exactamente dos frases propias del catálogo; no ejecuta un corrector general. En los campos editables, `getValueProps` ajusta la presentación y conserva el valor del formulario. Una prueba real en navegador con una API local sintética confirmó al guardar: `definitionPreserved=true`, `conditionPreserved=true`, `codeUnchanged=true`, `expectedVersion=1`.

## Validación realizada

- 120/120 pruebas web aprobadas, incluidas cinco pruebas de etiquetas, búsqueda y conservación de datos.
- Compilación Vite aprobada.
- `git diff --check` aprobado.
- Comprobación independiente del diff: sin cambios en transcripciones, catálogo fuente ni evaluación.
- Navegador local: búsqueda «Mexico» devuelve «México»; «Ciudad de México» aparece en la programación; definición y condición muestran «guion»; guardado conserva los valores originales.
- Las cuatro pruebas que abren puertos locales se repitieron con permiso de red local tras un bloqueo EPERM del sandbox; aprobaron. No fue un fallo del producto.
- La compilación mantiene la advertencia existente de tamaño de un bundle; no es un fallo de ortografía ni de compilación.

## Checklist QA

### 1. Flujo completo y navegación

- Estado: cumple
  Criticidad: menor
  Hallazgo: se conservan rutas, parámetros y acciones; el editor abre, guarda y vuelve al listado en la prueba local.
  Evidencia: `web/src/pages/Catalog.jsx`, comprobación de navegador local y pruebas web.
  Comportamiento esperado: corregir etiquetas sin cambiar navegación ni datos.
  Recomendación: mantener las transformaciones limitadas a presentación.

### 2. Catálogo, botones, listados y estados

- Estado: cumple
  Criticidad: menor
  Hallazgo: agregar, editar, activar/inactivar y listado conviven en la pantalla. Las variables pendientes de integración siguen sin poder activarse; guardar muestra confirmación.
  Evidencia: `Catalog.jsx`; la variable de fase 2 figura inactiva, con activación deshabilitada y motivo visible en el navegador local.
  Comportamiento esperado: conservar las reglas y acciones existentes.
  Recomendación: ninguna modificación funcional adicional.

### 3. Formularios y consistencia de datos

- Estado: cumple
  Criticidad: menor
  Hallazgo: las correcciones visuales no cambian el contenido enviado al guardar sin editar la definición.
  Evidencia: prueba local del formulario real; todos los indicadores de conservación resultaron verdaderos.
  Comportamiento esperado: no alterar el catálogo usado por las evaluaciones en curso.
  Recomendación: conservar los valores de formulario y las correcciones de presentación separados.

### 4. Ortografía, tildes y nomenclatura

- Estado: cumple
  Criticidad: menor
  Hallazgo: corregidas las cinco incidencias O-01 a O-05, con cobertura de nombres dinámicos y textos fijos.
  Evidencia: tabla de incidencias, `presentationText.js`, `ScheduleCard.jsx`, `ConversationMetrics.jsx`.
  Comportamiento esperado: etiquetas propias correctas, originales de conversación intactos.
  Recomendación: revisar los nuevos textos que se incorporen al portal con el mismo criterio.

### 5. Modales, feedback y revisión visual

- Estado: cumple
  Criticidad: menor
  Hallazgo: editor, aviso de guardado, estados, etiquetas y búsqueda comprobados en navegador local; no se modificaron CSS, alturas ni disposición.
  Evidencia: editor local con definición/condición corregidas y confirmación de actualización; captura `pulso-ortografia-editor.png` conservada como evidencia local.
  Comportamiento esperado: textos legibles y confirmación de la operación.
  Recomendación: ninguna corrección visual adicional necesaria para este alcance.

### 6. Robustez y estándares adicionales

- Estado: cumple
  Criticidad: menor
  Hallazgo: los países desconocidos conservan su etiqueta; no se inventan alias; buscar sin tilde sigue funcionando. Roles, permisos y reglas permanecen sin cambios.
  Evidencia: `presentation-text.test.js`, revisión del diff y suite completa de web.
  Comportamiento esperado: conservar contratos y acceso mientras se corrigen textos.
  Recomendación: mantener las pruebas de búsqueda y conservación de datos.

## Resumen ejecutivo

Cinco correcciones ortográficas o de presentación del idioma, aplicadas únicamente en la web. Mensajes originales y evaluaciones intactos. Pruebas y compilación aprobadas.

## Hallazgos críticos

No se encontraron hallazgos críticos confirmados dentro de esta revisión ortográfica. No se ejecutaron operaciones de escritura en producción ni una auditoría funcional nueva de todos los módulos.

## Riesgos funcionales

La búsqueda por nombre acentuado podía dejar de aceptar nombres sin tilde; se corrigió y probó antes de la entrega. La corrección del catálogo no modifica los valores almacenados ni los usados por el evaluador.

Observación independiente, fuera de la ortografía: algunas validaciones técnicas predeterminadas de Zod pueden llegar en inglés. No se cambiaron códigos ni mensajes técnicos del proveedor. Una futura revisión de localización podría cubrirlos.

## Desviaciones visuales

Sin cambios de estructura o estilos. No se detectaron problemas de visualización en los controles corregidos y comprobados localmente; no se realizó una auditoría visual exhaustiva de cada combinación de pantalla y tamaño.

## Recomendaciones prioritarias antes de liberar a producción

Publicar solo los archivos de web y este informe. El workflow existente identifica este alcance como frontend-only y evita reinicios de API, workers y PM2. Verificar esa ruta de despliegue y el avance del proceso después de publicar.
