import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../src/errors.js';
import { discoverLocalModels, gatewayToolKeyPattern as keyPattern } from '../src/services/gatewayDiscovery.js';
export { discoverLocalModels } from '../src/services/gatewayDiscovery.js';

export function parseDiscoveryArgs(args) {
  if (!args.length) return {};
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length === 2 && args[0] === '--tool' && keyPattern.test(args[1])) return { toolKey: args[1] };
  throw new AppError(422, 'Uso: node scripts/discover-local-models.js [--tool CLAVE_EXACTA]', 'INVALID_ARGUMENTS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseDiscoveryArgs(process.argv.slice(2));
    if (args.help) console.log('Uso: node scripts/discover-local-models.js [--tool CLAVE_EXACTA]\nSin argumentos lista herramientas. --tool lista modelos de una herramienta activa. Solo consulta; no ejecuta inferencias ni accede a bases de datos.');
    else {
      // Load the existing api/.env only after validating command arguments.
      await import('../src/config.js');
      console.log(JSON.stringify(await discoverLocalModels(args), null, 2));
    }
  } catch (error) {
    const safe = error instanceof AppError ? { code: error.code, message: error.message }
      : { code: 'DISCOVERY_FAILED', message: 'No se pudo consultar el catálogo de modelos locales.' };
    console.error(JSON.stringify({ error: safe }));
    process.exitCode = 1;
  }
}
