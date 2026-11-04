# Catálogo v5: formato Gemini, reanudación y persistencia

Al enviar las 49 variables de IA de fase 1, Gemini rechazaba con HTTP 400 el esquema que repetía una propiedad completa por variable. El diagnóstico con contenido sintético confirmó que un esquema compacto admite las 49 variables.

El adaptador ahora solicita una lista de resultados identificados por `variableId`. El esquema tiene tamaño constante y la normalización devuelve el contrato interno que ya utiliza Pulso. Se conservan el contenido y las instrucciones de evaluación; no se cambia el modelo ni las credenciales.

La validación común sigue comprobando tipos, categorías, abstenciones y evidencia. El esquema declara `maxItems: 3` para las evidencias, alineando la generación con el límite de tres mensajes que las instrucciones y el validador ya exigían. Los IDs duplicados o ajenos se rechazan; un ID ausente queda pendiente y permite conservar y reintentar los resultados restantes sin duplicar votos.

La reanudación del mismo lote también normaliza las referencias del checklist a ambos lados de la comparación: MySQL puede reordenar las claves de un objeto JSON sin cambiar sus valores, lo que antes provocaba un falso `CATALOG_CHANGED`. La corrección no cambia el algoritmo global de huellas ni las huellas históricas. Un cambio real de versión sigue bloqueando la reanudación y se conservan los modelos completados y los resultados parciales válidos.

La persistencia agrupa resultados y evidencias en sentencias parametrizadas, con fragmentos de hasta 100 filas y un presupuesto aproximado de 256 KiB. Guardar una evaluación de 64 variables sin evidencias pasa de 129 escrituras secuenciales a tres; el caso de prueba con 64 resultados y 125 citas requiere cinco escrituras. Estos conteos describen el trabajo SQL, no una garantía de latencia. Se mantienen las versiones y valores anteriores, y una falla en cualquier fragmento revierte la transacción completa, sin alterar otras evaluaciones.

El heartbeat admite una sola escritura pendiente o en curso: si la base tarda, omite ticks intermedios en vez de acumular transacciones. Al terminar cancela futuros ticks y espera la escritura pendiente antes de cerrar el almacén.

Validación de esta corrección aislada sobre `origin/main` (`d588c85`): **121 pruebas API aprobadas** con `npm test`, incluidos seis casos nuevos del formato compacto, una regresión de reanudación tras reordenamiento JSON y siete pruebas de persistencia/heartbeat. Se comprueba que flags y descriptores admiten tres evidencias y dejan pendiente un ítem que devuelve cuatro, así como límites de fragmentos, equivalencia con escritura secuencial, rollback y heartbeat lento. Los proveedores y bases de la suite son simulados. La comprobación sintética separada del esquema compacto contra Gemini obtuvo HTTP 200 con las 49 variables. No se incluyen conversaciones reales, credenciales ni manifiestos de ejecución en esta entrega.
