# Flags operativos por coincidencia de modelos

La vista operativa publica flags automáticos críticos, normales y positivos solo cuando dos modelos distintos detectaron el mismo evento. Resumen, Activas, Histórico, Búsqueda y Conversación comparten esta regla en la API, incluidos contadores y filtros.

La coincidencia se calcula a partir de las evaluaciones del lote dual, sus tareas y la identidad efectiva de cada modelo. Requiere conversación, contenido, checklist, variable, instrucciones y reglas equivalentes, con dos respuestas válidas de valor 1. No basta una etiqueta guardada que diga «2 modelos». Dos perfiles del mismo modelo, identidades ausentes, errores, abstenciones y resultados no equivalentes no publican flags automáticos.

Las detecciones individuales se conservan para consulta en Conversación. Una discrepancia no significa evento ausente; una segunda revisión pendiente tampoco. El detalle conserva ambas respuestas y su evidencia, sin alterar evaluaciones guardadas ni ejecutar IA al consultar.

Los resultados de código, cálculo o una regla compartida no representan votos independientes. Sus valores siguen disponibles en el detalle y las métricas; sus eventos no aparecen como flags automáticos bajo esta política. Los resultados por modelo en administración conservan la respuesta original.

Los flags humanos mantienen su identificación. Una persona puede levantar un evento sin consenso desde la conversación completa, aportando evidencia y motivo. Deshacer esa revisión vuelve a aplicar la regla de coincidencia. Las refutaciones históricas siguen visibles como trazabilidad; el denominador del porcentaje refutado incluye los flags con consenso y esas refutaciones conservadas.

Este cambio es de presentación y consulta: no elimina evaluaciones, no recalifica conversaciones, no reactiva variables inactivas ni cambia la programación o los modelos configurados. Los históricos sin doble revisión equivalente dejan de generar flags automáticos visibles; sus respuestas permanecen guardadas.

## Integración posterior de dos modelos locales

La arquitectura permite agregar adaptadores, conservar perfiles y comparar dos modelos distintos del mismo proveedor. Actualmente los proveedores reales soportados son OpenAI y Gemini; el perfil local existente es demostrativo.

Cuando esté lista la API interna, se debe confirmar el protocolo, los identificadores efectivos, la autenticación en variables de entorno, el acceso desde el servidor de Pulso, el formato estructurado, el contexto máximo y los tiempos de respuesta. El adaptador OpenAI actual usa `/responses`: compatibilidad con `/chat/completions` por sí sola no garantiza su reutilización. La capacidad de infraestructura se verificará con una muestra delimitada antes de sustituir los modelos actuales.
