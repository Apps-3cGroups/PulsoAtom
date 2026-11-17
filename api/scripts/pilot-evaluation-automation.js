import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { databaseConfig } from '../src/config.js';
import { DemoStore, MysqlStore } from '../src/store.js';
import { registryFromEnv } from '../src/model-registry.js';
import { automationConfiguration, runtimeConfiguration } from '../src/automation-configuration.js';
import { automationClock, runAutomationTick } from '../src/automation-scheduler.js';
import { previousDate } from '../src/daily-activity.js';
import { preflightLocalModels } from '../src/local-model-pilot.js';

// Explicit, synthetic pilot. Never writes Pulso/Atom databases or changes the
// scheduler. Real Gateway calls happen only with --run; the default is a plan.
const args = process.argv.slice(2);
const modes = ['parallel', 'model-first', 'conversation-first'];
const modeIndex = args.indexOf('--mode');
const mode = modeIndex < 0 ? 'parallel' : args[modeIndex + 1];
if (!modes.includes(mode) || args.some((arg, i) => !['--run', '--mode'].includes(arg) && args[i - 1] !== '--mode')) throw new Error('Uso: node scripts/pilot-evaluation-automation.js [--run] [--mode parallel|model-first|conversation-first]');
let database, directory, store;
try {
  let settings = {};
  if (databaseConfig()) { database = new MysqlStore(databaseConfig()); settings = await database.readSettings(); }
  const registry = registryFromEnv({ demo: false }).forState({ settings });
  if (!registry.gatewayConfigured || registry.list().filter(p => p.available).length !== 2) throw new Error('GATEWAY_CONFIGURATION_REQUIRED');
  const countries = [{ code: 'HN', name: 'Honduras' }, { code: 'PA', name: 'Panamá' }, { code: 'CR', name: 'Costa Rica' }];
  const configuration = automationConfiguration(settings, countries, registry);
  Object.assign(configuration, { enabled: true, paused: false, time: '00:00', executionOrder: mode, retries: 0, blockSize: 1,
    countries: countries.map(c => ({ ...c, enabled: c.code !== 'CR', paused: false, dailyLimit: 1 })) });
  if (!args.includes('--run')) {
    console.log(JSON.stringify({ plan: true, synthetic: true, mode, countries: configuration.countries, conversations: 5, expectedSelected: 2, expectedReviews: 4,
      models: registry.list().map(p => ({ id: p.id, model: p.model, protocol: p.protocol })), databaseChanged: false, next: 'Añade --run para enviar únicamente conversaciones sintéticas al Gateway.' }, null, 2));
  } else {
    const preflight = await preflightLocalModels(registry.withRuntime(runtimeConfiguration(configuration)), { settings });
    directory = await mkdtemp(path.join(tmpdir(), 'pulso-automation-pilot-'));
    store = await new DemoStore(path.join(directory, 'state.json')).init();
    const now = new Date(), activityDate = previousDate(automationClock(now, configuration.timezone).date);
    await store.transaction(s => {
      s.settings = { ...settings, version: settings.version || 1, automation: configuration, automationRuntime: {}, automationHistory: [] };
      delete s.settings.evaluationMaintenance;
      s.conversations = ['HN', 'HN', 'PA', 'PA', 'CR'].map((country, i) => ({ id: `synthetic-${country}-${i}`, country, date: activityDate,
        completed: true, lastActivityAt: `${activityDate}T12:01:00Z`, messages: [
          { id: `m-${i}-1`, actor: 'cliente', text: '¿Tienen disponible el producto de prueba? Esta es una conversación sintética.', timestamp: `${activityDate}T12:00:00Z` },
          { id: `m-${i}-2`, actor: 'humano', text: 'Sí, el producto de prueba está disponible.', timestamp: `${activityDate}T12:01:00Z` },
        ] }));
      s.catalog = s.catalog.filter(v => v.active && v.type === 'Flag' && v.method === 'IA').slice(0, 2);
      for (const key of ['jobs', 'tasks', 'attempts', 'evaluations', 'dailyAssignments', 'operationalRefs', 'comparisons']) s[key] = [];
    });
    for (let i = 0; i < 8; i++) {
      const execution = await runAutomationTick(store, registry);
      if (execution) await execution.completion;
      const s = await store.read();
      if (s.jobs.length && s.jobs.every(j => ['completed', 'failed', 'partial'].includes(j.status))) break;
    }
    const result = await store.read();
    const passed = result.dailyAssignments.length === 2 && result.tasks.length === 4 && result.tasks.every(t => t.status === 'completed');
    console.log(JSON.stringify({ passed, synthetic: true, mode, databaseChanged: false, preflight,
      selected: result.dailyAssignments.map(a => ({ country: a.country, conversationId: a.conversationId })),
      tasks: result.tasks.map(t => ({ modelId: t.profile.id, conversationId: t.conversationId, status: t.status, error: t.error })),
      prompts: result.jobs.map(j => ({ version: j.promptSnapshot.version, hash: j.promptSnapshot.hash })),
    }, null, 2));
    if (!passed) process.exitCode = 1;
  }
} catch (error) { console.error(JSON.stringify({ passed: false, code: error.code || error.message, databaseChanged: false })); process.exitCode = 1; }
finally { await store?.close(); await database?.close(); if (directory) await rm(directory, { recursive: true, force: true }); }
