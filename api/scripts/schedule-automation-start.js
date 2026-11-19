import { pathToFileURL } from 'node:url';
import { cancelAutomationJob } from '../src/automation-scheduler.js';
import { saveAutomationConfiguration } from '../src/automation-configuration.js';

export function parseScheduleArguments(args) {
  const fields = ['starts-at', 'cancel-before', 'expected-version'];
  const options = {};
  for (const arg of args) {
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match || !fields.includes(match[1]) || options[match[1]]) throw new Error('Invalid schedule arguments');
    options[match[1]] = match[2];
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(options['starts-at'] || '') || !Number.isFinite(Date.parse(options['starts-at']))
    || !/^\d{4}-\d{2}-\d{2}$/.test(options['cancel-before'] || '') || !/^[1-9]\d*$/.test(options['expected-version'] || '')) throw new Error('Provide an ISO UTC start, activity cutoff and expected version');
  return { startsAt: options['starts-at'], cancelBefore: options['cancel-before'], expectedVersion: Number(options['expected-version']) };
}
const pending = (state, job) => state.tasks.filter(t => t.jobId === job.id && !['completed', 'deferred'].includes(t.status));
const previousJobs = (state, cutoff) => state.jobs.filter(j => j.automation?.activityDate < cutoff && pending(state, j).length);
export async function scheduleAutomationStart(store, options, date = new Date()) {
  const { startsAt, cancelBefore, expectedVersion } = options;
  if (Date.parse(startsAt) <= date.getTime()) throw new Error('The requested start must be in the future');
  const author = { id: 'operations', name: 'Programación solicitada por el administrador' };
  const validate = state => {
    const config = state.settings.automation;
    if (state.settings.version !== expectedVersion || !config?.enabled || !config.paused) throw new Error('Expected version must be enabled and globally paused');
    if (state.jobs.some(j => j.status === 'running') || state.tasks.some(t => t.status === 'running')) throw new Error('Wait for the active request to finish');
    if (Date.parse(startsAt) <= Date.now()) throw new Error('The requested start has passed');
  };
  const summary = state => ({ version: state.settings.version, startsAt: state.settings.automation.startsAt,
    enabled: state.settings.automation.enabled, paused: state.settings.automation.paused,
    time: state.settings.automation.time, timezone: state.settings.automation.timezone,
    countries: state.settings.automation.countries.map(({code, dailyLimit, enabled, paused}) => ({code, dailyLimit, enabled, paused})),
    modelOrder: state.settings.automation.modelOrder, executionOrder: state.settings.automation.executionOrder,
    oldPendingReviews: previousJobs(state, cancelBefore).reduce((n,j) => n + pending(state,j).length, 0),
    runningJobs: state.jobs.filter(j => j.status === 'running').length,
    cancelledRuns: state.jobs.filter(j => j.automation?.cancelledAt).map(j => ({id:j.id,activityDate:j.automation.activityDate,status:j.status,cancelled:j.cancelled,completed:j.completed})),
    completedRuns: state.jobs.filter(j => j.automation && j.status === 'completed').map(j => ({id:j.id,completed:j.completed,total:j.total})),
    otherRunnable: state.jobs.filter(j => !j.automation && ['queued','interrupted','running'].includes(j.status)).map(j => ({id:j.id,status:j.status,oneOffRun:j.oneOffRun?.id || null})),
    oneOffRuns: (state.settings.oneOffEvaluations || []).map(r => ({id:r.id,enabled:r.enabled,status:r.status,expiresAt:r.expiresAt,superseded:!!r.executionSupersededBy})) });
  const before = await store.readAutomationState();
  if (before.settings.version === expectedVersion + 1 && before.settings.automation?.startsAt === startsAt && !before.settings.automation.paused && !previousJobs(before, cancelBefore).length) return summary(before);
  validate(before);
  for (const ref of previousJobs(before, cancelBefore)) {
    const worker = store.evaluationWorker ? store.evaluationWorker(ref.id) : store;
    await worker.transaction(state => {
      validate(state);
      const job = state.jobs.find(j => j.id === ref.id);
      cancelAutomationJob(state, job, { author, reason: `Pendientes anteriores a ${cancelBefore} cancelados por solicitud del administrador` }, date);
    });
  }
  const configurationTransaction = store.evaluationConfigurationTransaction ? fn => store.evaluationConfigurationTransaction(fn) : fn => store.transaction(fn);
  await configurationTransaction(state => {
    validate(state);
    if (previousJobs(state, cancelBefore).length) throw new Error('Old pending reviews remain');
    saveAutomationConfiguration(state, { expectedVersion, automation: { ...state.settings.automation, paused: false, startsAt } }, author);
  });
  const result = summary(await store.readAutomationState());
  if (result.version !== expectedVersion + 1 || result.startsAt !== startsAt || result.oldPendingReviews || result.runningJobs || result.paused) throw new Error('Schedule verification failed');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let store;
  try {
    const options = parseScheduleArguments(process.argv.slice(2));
    const { databaseConfig } = await import('../src/config.js');
    const { MysqlStore } = await import('../src/store.js');
    store = new MysqlStore(databaseConfig());
    console.log(JSON.stringify(await scheduleAutomationStart(store, options), null, 2));
  } catch (error) { console.error(JSON.stringify({ error: error.code || 'SCHEDULE_FAILED', message: error.code ? 'Revisa el estado y la conectividad antes de reintentar.' : error.message })); process.exitCode = 1; }
  finally { await store?.close(); }
}
