# Gemini: respuesta compacta para el catálogo v5

Al enviar las 49 variables de IA de fase 1, Gemini rechazaba con HTTP 400 el esquema que repetía una propiedad completa por variable. El diagnóstico con contenido sintético confirmó que un esquema compacto admite las 49 variables.

El adaptador ahora solicita una lista de resultados identificados por `variableId`. El esquema tiene tamaño constante y la normalización devuelve el contrato interno que ya utiliza Pulso. Se conservan el contenido y las instrucciones de evaluación; no se cambia el modelo ni las credenciales.

La validación común sigue comprobando tipos, categorías, abstenciones y evidencia. Los IDs duplicados o ajenos se rechazan; un ID ausente queda pendiente y permite conservar y reintentar los resultados restantes sin duplicar votos.

La reanudación del mismo lote también normaliza las referencias del checklist a ambos lados de la comparación: MySQL puede reordenar las claves de un objeto JSON sin cambiar sus valores, lo que antes provocaba un falso `CATALOG_CHANGED`. La corrección no cambia el algoritmo global de huellas ni las huellas históricas. Un cambio real de versión sigue bloqueando la reanudación y se conservan los modelos completados y los resultados parciales válidos.

Validación de esta corrección aislada sobre `origin/main` (`d588c85`): **113 pruebas API aprobadas** con `npm test`, incluidos cinco casos nuevos del formato compacto y una regresión de reanudación tras reordenamiento JSON. Los proveedores de la suite son simulados. La comprobación sintética separada contra Gemini obtuvo HTTP 200 con las 49 variables. No se incluyen conversaciones reales, credenciales ni manifiestos de ejecución en esta entrega.
