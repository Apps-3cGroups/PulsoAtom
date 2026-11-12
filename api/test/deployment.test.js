import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { DemoStore, UnconfiguredStore } from '../src/store.js';

const apiRoot = fileURLToPath(new URL('../', import.meta.url));
const settings = { demo: true, origin: 'http://127.0.0.1:3000', sessionHours: 8, secureCookie: false, timezone: 'America/Tegucigalpa' };

test('BASE_PATH normaliza la subruta y PORT tiene prioridad sobre API_PORT para PM2', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    "const { config } = await import('./src/config.js'); console.log(JSON.stringify({ basePath: config.basePath, port: config.port }));"], {
    cwd: apiRoot, encoding: 'utf8', env: { ...process.env, BASE_PATH: '/operacion/pulsoAtom/', PORT: '4311', API_PORT: '9999' },
  });
  assert.deepEqual(JSON.parse(output.trim()), { basePath: '/operacion/pulsoAtom', port: 4311 });
});

test('la API inicia con la subruta /pulsoAtom solicitada', async () => {
  const app = createApp(new UnconfiguredStore(), { ...settings, demo: false });
  await request(app).get('/pulsoAtom/api/meta').expect(200);
  await request(app).get('/pulso/api/meta').expect(404);
  await request(app).get('/api/meta').expect(404);
});

test('login, sesión y logout usan la subruta configurada y la misma ruta de cookie', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pulso-path-test-'));
  const store = await new DemoStore(path.join(directory, 'state.json')).init();
  const app = createApp(store, { ...settings, basePath: '/operacion/pulsoAtom/' });
  const agent = request.agent(app);
  try {
    await agent.get('/operacion/pulsoAtom/api/health').expect(200);
    await agent.get('/pulsoAtom/api/health').expect(404);
    const login = await agent.post('/operacion/pulsoAtom/api/auth/demo').set('Origin', settings.origin).send({ role: 'admin' }).expect(200);
    assert.match(login.headers['set-cookie'][0], /Path=\/operacion\/pulsoAtom(?:;|$)/);
    await agent.get('/operacion/pulsoAtom/api/auth/me').expect(200);
    const logout = await agent.post('/operacion/pulsoAtom/api/auth/logout').set('Origin', settings.origin).send({}).expect(204);
    assert.match(logout.headers['set-cookie'][0], /Path=\/operacion\/pulsoAtom(?:;|$)/);
    await agent.get('/operacion/pulsoAtom/api/auth/me').expect(401);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('la API rechaza montar el portal en la raíz del dominio', () => {
  assert.throws(() => createApp(new UnconfiguredStore(), { ...settings, basePath: '/' }), /subruta/i);
});

const workflowPath = new URL('../../.github/workflows/deploy-pulso-atom.yml', import.meta.url);

test('la auditoría de un lote exige UUID y solo entra en la ruta explícita de lectura', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const operation = 'evaluation-batch-inspect';
  const options = workflow.match(/options: \[([^\]]+)\]/)?.[1];
  const allowed = workflow.match(/\$env:GEMMA_OPERATION -cnotin @\(([^)]+)\)/)?.[1];
  const checkoutOperations = workflow.match(/\$useCheckoutSource = \$env:GEMMA_OPERATION -cin @\(([^)]+)\)/)?.[1];
  const checkoutCondition = workflow.match(/uses: actions\/checkout@v4\n\s+if: ([^\n]+)/)?.[1];
  const jobCondition = workflow.match(/gemma-check:\n\s+if: ([^\n]+)/)?.[1];
  for (const value of [options, allowed, checkoutOperations, checkoutCondition, jobCondition]) {
    assert.ok(value?.includes(operation));
  }
  assert.match(jobCondition, /github\.event_name == 'workflow_dispatch'/);
  const mapping = workflow.split('\n').find(line => line.trim().startsWith(`'${operation}' {`));
  assert.equal(mapping.trim(), "'evaluation-batch-inspect' { $entryScript = 'scripts/inspect-evaluation-batch.js'; $scriptArguments = \"--job-id $($env:EVALUATION_JOB_ID)\" }");
  const guard = workflow.match(/if \(\$env:GEMMA_OPERATION -ceq 'evaluation-batch-inspect'\) \{\s+if \(\$env:EVALUATION_JOB_ID -cnotmatch '([^']+)'/);
  assert.ok(guard);
  const uuid = new RegExp(guard[1]);
  assert.equal(uuid.test('d530a03e-9182-47bf-8639-069f6f90e537'), true);
  for (const value of ['', '../state', '$(id)', 'a; id', 'd530a03e-9182-47bf-8639-069f6f90e537 --start', 'd530a03e-9182-47bf-8639-069f6f90e537\n']) {
    assert.equal(uuid.test(value), false);
  }
  assert.ok(workflow.indexOf(guard[0]) < workflow.indexOf('switch -CaseSensitive ($env:GEMMA_OPERATION)'));
  const deployCondition = workflow.match(/\n  deploy:\n\s+if: ([^\n]+)/)?.[1];
  assert.equal(deployCondition, "${{ github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.operation == 'deploy') }}");
});

test('ampliar Gemma admite 500 sin ampliar el límite del reinicio inicial ni aceptar argumentos inyectados', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const guard = operation => {
    const block = workflow.match(new RegExp(`if \\(\\$env:GEMMA_OPERATION -ceq '${operation}'\\) \\{([\\s\\S]*?)^ {10}\\}`, 'm'))?.[1];
    assert.ok(block, `Falta la validación específica de ${operation}`);
    return variable => {
      const pattern = block.match(new RegExp(`\\$env:${variable} -cnotmatch '([^']+)'`))?.[1];
      assert.ok(pattern, `Falta validar ${variable} en ${operation}`);
      return new RegExp(pattern);
    };
  };
  const initialLimit = guard('gemma-start')('CONVERSATION_LIMIT');
  const extension = guard('gemma-extend');
  for (const value of ['1', '20', '100']) assert.equal(initialLimit.test(value), true);
  for (const value of ['101', '500', '501']) assert.equal(initialLimit.test(value), false);
  for (const variable of ['EXPECTED_EVALUATIONS', 'CONVERSATION_LIMIT']) {
    const pattern = extension(variable);
    for (const value of ['1', '20', '100', '499', '500']) assert.equal(pattern.test(value), true);
    for (const value of ['', '0', '-1', '501', '1000', '01', '20.5', '20; id', '$(id)', '20 --start']) assert.equal(pattern.test(value), false);
  }
});

test('gemma-extend es una operación explícita sobre producción validada y nunca invoca el reinicio', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const mapping = workflow.split('\n').find(line => line.trim().startsWith("'gemma-extend' {"));
  assert.ok(mapping);
  assert.match(mapping, /\$entryScript = 'scripts\/extend-gemma-renewal\.js'/);
  assert.match(mapping, /--extend --maintenance-id \$\(\$env:MAINTENANCE_ID\) --expected-total \$\(\$env:EXPECTED_EVALUATIONS\) --from \$\(\$env:FROM_DATE\) --to \$\(\$env:TO_DATE\) --limit \$\(\$env:CONVERSATION_LIMIT\)/);
  assert.doesNotMatch(mapping, /--start|--prepare|reset-evaluations/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && .*inputs\.operation == 'gemma-extend'/);
  const checkoutOperations = workflow.match(/\$useCheckoutSource = \$env:GEMMA_OPERATION -cin @\(([^)]+)\)/)?.[1];
  assert.ok(checkoutOperations);
  assert.doesNotMatch(checkoutOperations, /'gemma-extend'/);
  assert.match(workflow, /if \(\$env:GEMMA_OPERATION -cin @\('gemma-start', 'gemma-extend'\)\) \{\s+if \(\$env:FROM_DATE -cnotmatch/);
  assert.equal((workflow.match(/\[datetime\]::TryParseExact/g) || []).length, 2);
  assert.match(workflow, /\$fromDate -gt \$toDate/);
  const uuidGuard = workflow.match(/\$env:GEMMA_OPERATION -cin @\('gemma-status', 'gemma-extend'\) -and \$env:MAINTENANCE_ID -cnotmatch '([^']+)'/);
  assert.ok(uuidGuard);
  const uuid = new RegExp(uuidGuard[1]);
  assert.equal(uuid.test('77f00000-0000-4000-8000-000000000000'), true);
  for (const value of ['', '../maintenance', '77f00000-0000-4000-8000-000000000000; id']) assert.equal(uuid.test(value), false);
  const production = workflow.match(/\$remoteCommand = @'\n([\s\S]*?)\n {10}'@/)?.[1];
  assert.ok(production);
  assert.ok(production.indexOf('"$actual_sha" = "__EXPECTED_SHA__"') < production.indexOf('exec node'));
  assert.ok(production.indexOf('diff --quiet HEAD -- api') < production.indexOf('exec node'));
  assert.match(production, /node --env-file=\/var\/www\/nodeapps\/PulsoAtom\/api\/\.env __ENTRY_SCRIPT__ __SCRIPT_ARGUMENTS__/);
});

test('el próximo lote local separa inspección y estado de su inicio sobre el commit desplegado', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const allowed = workflow.match(/\$env:GEMMA_OPERATION -cnotin @\(([^)]+)\)/)?.[1];
  const options = workflow.match(/options: \[([^\]]+)\]/)?.[1];
  const jobCondition = workflow.match(/gemma-check:\n\s+if: ([^\n]+)/)?.[1];
  const checkoutOperations = workflow.match(/\$useCheckoutSource = \$env:GEMMA_OPERATION -cin @\(([^)]+)\)/)?.[1];
  const checkoutCondition = workflow.match(/uses: actions\/checkout@v4\n\s+if: ([^\n]+)/)?.[1];
  for (const value of [allowed, options, jobCondition, checkoutOperations, checkoutCondition]) assert.ok(value);
  for (const operation of ['local-next500-inspect', 'local-next500-start', 'local-next500-status']) {
    assert.ok(allowed.includes(`'${operation}'`));
    assert.ok(options.split(',').map(s => s.trim()).includes(operation));
    assert.ok(jobCondition.includes(`inputs.operation == '${operation}'`));
    const mapping = workflow.split('\n').find(line => line.trim().startsWith(`'${operation}' {`));
    assert.equal(mapping.trim(), `'${operation}' { $entryScript = 'scripts/start-next-local-batch.js'; $scriptArguments = '--${operation.split('-').at(-1)}' }`);
    assert.doesNotMatch(mapping, /\$env:|\$\(|--prepare|--extend|--reset/);
  }
  for (const readonly of ['local-next500-inspect', 'local-next500-status']) {
    assert.ok(checkoutOperations.includes(`'${readonly}'`));
    assert.ok(checkoutCondition.includes(`inputs.operation == '${readonly}'`));
  }
  assert.doesNotMatch(checkoutOperations, /'local-next500-start'/);
  assert.doesNotMatch(checkoutCondition, /'local-next500-start'/);
  assert.match(jobCondition, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /if \(-not \$useCheckoutSource -and \$env:GITHUB_SHA -cnotmatch '\^\[a-f0-9\]\{40\}\$'\)/);
  const production = workflow.match(/\$remoteCommand = @'\n([\s\S]*?)\n {10}'@/)?.[1];
  assert.ok(production);
  for (const guard of ['"$actual_sha" = "__EXPECTED_SHA__"', 'diff --quiet HEAD -- api']) {
    assert.ok(production.indexOf(guard) >= 0 && production.indexOf(guard) < production.indexOf('exec node'));
  }
  const incidentStop = production.match(/if \[ '__OPERATION__' = 'gemma-tuesday-recover' \]; then[\s\S]*?\n\s+fi/)?.[0];
  assert.ok(incidentStop);
  assert.match(incidentStop, /trap restart_incident_api EXIT/);
  assert.match(incidentStop, /pm2 stop pulso-atom-api/);
  assert.match(incidentStop, /pm2 restart pulso-atom-api/);
  assert.doesNotMatch(production.replace(incidentStop, ''), /git pull|pm2|npm |migrate|reset-evaluations/);
  const deployCondition = workflow.match(/\n  deploy:\n\s+if: ([^\n]+)/)?.[1];
  assert.equal(deployCondition, "${{ github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.operation == 'deploy') }}");
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /Verified removal of the current temporary SSH key and directory/);
});
