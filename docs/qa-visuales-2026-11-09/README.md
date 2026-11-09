# Validación de ajustes visuales — 9 de noviembre de 2026

Rama: `codex/ajustes-visuales-portal`, basada en `main` después de la programación diaria HN/PA (4518417).

## Alcance

- Bot y Agente humano comparten fondo índigo; Cliente conserva fondo blanco y texto de alto contraste. Nombres coherentes en conversación, revisión y validación.
- Identificación de participantes con los metadatos de Atom; conteos separados de Bot y Agente humano en las métricas del día seleccionado. Los eventos técnicos y emisores desconocidos no se cuentan como asistentes.
- Resumen con Hoy, 3 días y 30 días. Celdas de igual ancho, sin números ni signos de admiración. Mapa mensual compacto que conserva cada conversación y su detalle al abrirla.
- Activas sin período: tarjetas por conversación con asistente, flags vigentes y pie con cliente e inicio; sin ID visible ni etiquetas repetidas de prioridad.
- Se conservan la revisión por coincidencia de Clef/Gemma, los estados parciales, las métricas diarias y la configuración del evaluador automático de main.

## Comprobaciones

- API: 406 pruebas aprobadas. Regresión de clasificación ATOM/BOT/SISTEMA, cliente y agente humano.
- Métricas diarias: 10 pruebas aprobadas, incluyendo conteos independientes por fecha y valores no disponibles ante fechas inválidas.
- Web: 93 pruebas aprobadas, incluyendo períodos y conservación de 1.200 conversaciones al indexar el mapa.
- Compilación Vite correcta; mantiene el aviso existente de tamaño de bundle.
- Fuente Atom: consulta de solo lectura confirma los campos Direccion e IdAsesor.
- Navegador, demo aislada, viewport 1067 × 889: los 30 días y las seis regiones visibles en una pantalla; 216 conversaciones renderizadas, sin desbordamiento del documento.
- Conversación DEMO-MX-0001: Cliente blanco; Bot y Agente humano rgb(223, 229, 255). Métricas: Cliente 2, Bot 1, Agente humano 2, total 5.
- Activas: 12 tarjetas por página, cero filtros de período, sin IDs visibles en las tarjetas. Se mantiene la advertencia cuando falta una revisión de modelo.

Las capturas corresponden a datos sintéticos de la rama integrada. No se ejecutaron inferencias para esta validación.

## Evidencia

- [Resumen de 30 días](resumen-30-dias.png)
- [Conversación](conversacion.png)
- [Métricas diarias](metricas.png)
- [Activas](activas.png)

## Corrección de simbología

Hoy y 3 días conservan los símbolos originales: círculos para flags y refutaciones, triángulos para revisión humana y signo positivo. Las celdas mantienen un ancho común de 56 px para que quepan las cinco figuras, sin contadores ni signos de admiración.

En 30 días, cada figura se adapta al espacio disponible. Si su espacio mide al menos 6 × 6 px, se dibuja el símbolo original; por debajo de ese tamaño se mantiene la franja de su color para no ocultar flags ni desbordar la celda. No se modifica la agrupación mensual.

Validación en navegador a 1280 × 720: Hoy muestra 54 conversaciones y 8 símbolos; 3 días, 162 conversaciones y 31 símbolos, sin franjas en ambos casos. En 30 días se muestran 216 conversaciones y los 44 símbolos visibles de la demo; todas sus celdas miden 11 px de ancho y el documento cabe en el viewport. Las 93 pruebas web y la compilación pasan.

- [3 días con símbolos restaurados](resumen-3-dias-simbolos.png)
- [30 días conservando la simbología](resumen-30-dias-simbolos.png)
