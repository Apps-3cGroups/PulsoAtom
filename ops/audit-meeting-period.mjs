import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { operationalEvaluation, hasCompleteLocalModelPair } from '../api/src/operational-evaluation.js';

export const COUNTRIES = ['HN', 'PA', 'CR', 'SV', 'MX', 'NI'];
const PROFILES = ['clef-local', 'gemma-local'];
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const group = (items, key) => items.reduce((map, item) => map.set(item[key], [...(map.get(item[key]) || []), item]), new Map());
const countFields = ['anyComplete', 'clefComplete', 'gemmaComplete', 'bothComplete'];
const emptyCounts = () => Object.fromEntries(countFields.map(key => [key, 0]));
const dayOf = (value, timezone) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

// Repeated attempts and replaced result IDs never become extra conversations.
// Completion is historical: no source content is fetched and no current-source
// fingerprint claim is made by this read-only inventory. The pair predicate is
// shared with the portal rather than approximated by a second SQL definition.
export function countMeetingCases(state, metadata, timezone = 'America/Tegucigalpa') {
  const tasks = group(state.tasks, 'conversationId'), evaluations = group(state.evaluations, 'conversationId');
  const refs = new Map(state.operationalRefs.map(ref => [ref.id, ref.evaluationId]));
  const visible = [], historical = [];
  let missingTimestamp = 0, operationalAnchors = 0, completeComplementCases = 0;
  for (const conversation of metadata) {
    if (!COUNTRIES.includes(conversation.country)) continue;
    const date = dayOf(conversation.activityAt, timezone);
    if (!date) { missingTimestamp++; continue; }
    const localTasks = tasks.get(conversation.conversationId) || [];
    const localEvaluations = evaluations.get(conversation.conversationId) || [];
    const jobIds = new Set([...localTasks, ...localEvaluations].map(item => item.jobId));
    const local = { tasks: localTasks, jobs: state.jobs.filter(job => jobIds.has(job.id)),
      catalogVersions: state.catalogVersions, comparisons: state.comparisons.filter(sample => jobIds.has(sample.jobId)), conversations: [],
      evaluations: localEvaluations.map(evaluation => ({ ...evaluation,
        validationErrors: evaluation.validationErrorCount ? [{}] : [] })) };
    const modelsFor = anchor => {
      if (!anchor || anchor.purpose !== 'operational') return { profiles: new Set(), both: false, complement: false };
      const view = operationalEvaluation(local, anchor);
      const profiles = new Set((view.modelReviews || []).filter(review => review.status === 'completed' && PROFILES.includes(review.profileId)).map(review => review.profileId));
      return { profiles, both: hasCompleteLocalModelPair(view) && PROFILES.every(profile => profiles.has(profile)),
        complement: !!view.dual && view.modelReviews?.some(review => review.provenance === 'cohort-complement') };
    };
    const anchor = local.evaluations.find(evaluation => evaluation.id === refs.get(conversation.conversationId));
    if (anchor) operationalAnchors++;
    const current = modelsFor(anchor);
    if (current.both && current.complement) completeComplementCases++;
    const previous = { profiles: new Set(), both: false };
    for (const evaluation of local.evaluations.filter(item => item.purpose === 'operational')) {
      const result = modelsFor(evaluation);
      result.profiles.forEach(profile => previous.profiles.add(profile));
      // Different jobs/sources cannot be combined into a fabricated pair.
      previous.both ||= result.both;
    }
    const row = result => ({ date, country: conversation.country, anyComplete: Number(result.profiles.size > 0),
      clefComplete: Number(result.profiles.has('clef-local')), gemmaComplete: Number(result.profiles.has('gemma-local')), bothComplete: Number(result.both) });
    visible.push(row(current)); historical.push(row(previous));
  }
  return { visible, historical, missingTimestamp, operationalAnchors, completeComplementCases };
}

export function rankMeetingPeriods(cases) {
  const dates = [...new Set(cases.filter(item => item.anyComplete).map(item => item.date))].sort();
  const aggregate = selectedDates => {
    const countries = COUNTRIES.map(country => ({ country, ...emptyCounts() }));
    const selected = new Set(selectedDates);
    for (const item of cases) if (selected.has(item.date)) {
      const country = countries.find(row => row.country === item.country);
      for (const key of countFields) country[key] += item[key];
    }
    const totals = countries.reduce((total, row) => Object.fromEntries(countFields.map(key => [key, total[key] + row[key]])), emptyCounts());
    return { dates: [...selectedDates].sort(), ...totals, countries,
      countriesWithAny: countries.filter(row => row.anyComplete > 0).length, countriesWithBoth: countries.filter(row => row.bothComplete > 0).length };
  };
  const daily = dates.map(date => ({ date, ...aggregate([date]) }));
  const order = key => (a, b) => b[key] - a[key] || b.dates.at(-1).localeCompare(a.dates.at(-1));
  const windows = dates.map(date => {
    const last = Date.parse(`${date}T12:00:00Z`);
    const selected = [2, 1, 0].map(days => new Date(last - days * 86400000).toISOString().slice(0, 10));
    return { from: selected[0], to: selected[2], ...aggregate(selected) };
  });
  const top = (items, key) => [...items].sort(order(key)).slice(0, 5);
  return { total: aggregate(dates), daily: [...daily].reverse(),
    topThreeIndividualByAny: aggregate(top(daily, 'anyComplete').slice(0, 3).map(day => day.date)),
    topThreeIndividualByBoth: aggregate(top(daily, 'bothComplete').slice(0, 3).map(day => day.date)),
    bestConsecutiveByAny: top(windows, 'anyComplete'), bestConsecutiveByBoth: top(windows, 'bothComplete'),
    bestConsecutiveAllSixAny: top(windows.filter(window => window.countriesWithAny === 6), 'anyComplete'),
    bestConsecutiveAllSixBoth: top(windows.filter(window => window.countriesWithBoth === 6), 'bothComplete') };
}

const json = (alias, fields) => fields.map(field => `'${field}',JSON_EXTRACT(${alias}.payload,'$.${field}')`).join(',');
const jobEligible = "(JSON_UNQUOTE(JSON_EXTRACT(j.payload,'$.purpose'))='operational' OR JSON_UNQUOTE(JSON_EXTRACT(j.payload,'$.cohortId')) LIKE 'clef-complement-%')";
const query = async (connection, sql, values = []) => {
  const [rows] = await connection.query({ sql, values, timeout: 25000 });
  if (rows.length > 50000) throw Object.assign(new Error('Audit bound exceeded.'), { code: 'AUDIT_LIMIT' });
  return rows;
};

async function paged(connection, sql, alias, onProgress) {
  const values = [];
  let cursor = 0;
  for (;;) {
    const rows = await query(connection, `${sql} AND ${alias}.sequence_id > ? ORDER BY ${alias}.sequence_id LIMIT 150`, [cursor]);
    values.push(...rows.map(row => decode(row.payload)));
    if (values.length > 50000) throw Object.assign(new Error('Audit bound exceeded.'), { code: 'AUDIT_LIMIT' });
    onProgress({ stage: alias, records: values.length });
    if (rows.length < 150) return values;
    cursor = rows.at(-1).auditSequence;
  }
}

export async function auditMeetingPeriod({ app, atom, tables, timezone = 'America/Tegucigalpa', onProgress = () => {}, onSnapshot = async () => {} }) {
  const startedAt = new Date().toISOString();
  // Keep the second read-only connection alive while large projected result
  // batches are read from Pulso. No source writes or model requests occur here.
  const keepAlive = setInterval(() => { void atom.ping().catch(() => {}); }, 10000);
  try {
    for (const connection of [app, atom]) {
      await query(connection, 'SET TRANSACTION READ ONLY');
      await query(connection, 'START TRANSACTION WITH CONSISTENT SNAPSHOT');
    }
    const state = {};
    state.operationalRefs = (await query(app, 'SELECT payload FROM operational_refs')).map(row => decode(row.payload));
    state.jobs = await paged(app, `SELECT j.sequence_id auditSequence,JSON_OBJECT(${json('j', ['id', 'purpose', 'mode', 'maintenanceId', 'cohortId', 'cohortManifestHash', 'modelProfiles', 'catalogVersions', 'conversationIds'])},
      'promptSnapshot',CASE WHEN JSON_TYPE(JSON_EXTRACT(j.payload,'$.promptSnapshot'))='OBJECT' THEN JSON_OBJECT(
        'hash',JSON_EXTRACT(j.payload,'$.promptSnapshot.hash'),'profiles',JSON_OBJECT(
          'clef-local',JSON_OBJECT('hash',JSON_EXTRACT(j.payload,'$.promptSnapshot.profiles."clef-local".hash')),
          'gemma-local',JSON_OBJECT('hash',JSON_EXTRACT(j.payload,'$.promptSnapshot.profiles."gemma-local".hash')))) ELSE NULL END) payload
      FROM evaluation_jobs j WHERE ${jobEligible}`, 'j', onProgress);
    state.catalogVersions = (await query(app, `SELECT JSON_OBJECT(${json('v', ['id', 'itemId', 'version'])},'snapshot',JSON_OBJECT(
      'method',JSON_EXTRACT(v.payload,'$.snapshot.method'),'type',JSON_EXTRACT(v.payload,'$.snapshot.type'))) payload FROM catalog_versions v`)).map(row => decode(row.payload));
    state.tasks = await paged(app, `SELECT t.sequence_id auditSequence,JSON_OBJECT(${json('t', ['id', 'jobId', 'conversationId', 'evaluationId', 'status', 'profile', 'context', 'reusedEvaluationId', 'reusedJobId', 'reusedTaskId', 'fallback'])},
      'error',CASE WHEN JSON_TYPE(JSON_EXTRACT(t.payload,'$.error')) IS NULL OR JSON_TYPE(JSON_EXTRACT(t.payload,'$.error'))='NULL' THEN NULL ELSE TRUE END) payload
      FROM evaluation_tasks t JOIN evaluation_jobs j ON j.id=t.job_key WHERE ${jobEligible}`, 't', onProgress);
    state.evaluations = await paged(app, `SELECT e.sequence_id auditSequence,JSON_OBJECT(${json('e', ['id', 'jobId', 'taskId', 'conversationId', 'purpose', 'profileId', 'requestedProfileId', 'provider', 'model', 'modelConfiguration', 'sourceHash', 'catalogHash', 'promptHash', 'modelPromptHash', 'promptVersion', 'rulesVersion', 'catalogVersions', 'partial', 'demo', 'usedFallback', 'createdAt', 'protocol', 'adapterVersion', 'instructionsHash'])},
      'validationErrorCount',CASE WHEN JSON_TYPE(JSON_EXTRACT(e.payload,'$.validationErrors'))='ARRAY'
        THEN JSON_LENGTH(JSON_EXTRACT(e.payload,'$.validationErrors')) ELSE 0 END,
      'error',CASE WHEN JSON_TYPE(JSON_EXTRACT(e.payload,'$.error')) IS NULL OR JSON_TYPE(JSON_EXTRACT(e.payload,'$.error'))='NULL' THEN NULL ELSE TRUE END,
      'results',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('variableId',r.variableId,'status',r.status,'value',NULL,
        'error',CASE WHEN JSON_TYPE(r.error) IS NULL OR JSON_TYPE(r.error)='NULL' THEN NULL ELSE TRUE END))
        FROM JSON_TABLE(e.payload,'$.results[*]' COLUMNS(variableId VARCHAR(160) PATH '$.variableId',status VARCHAR(40) PATH '$.status',error JSON PATH '$.error' NULL ON EMPTY)) r),JSON_ARRAY())) payload
      FROM evaluations e JOIN evaluation_jobs j ON j.id=JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.jobId')) WHERE ${jobEligible}`, 'e', onProgress);
    onProgress({ stage: 'comparisons', records: 0 });
    state.comparisons = (await query(app, `SELECT JSON_OBJECT(${json('s', ['id', 'jobId', 'cohortId', 'modelProfiles', 'catalogVersions'])},
      'cases',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('conversationId',c.conversationId,'sourceHash',c.sourceHash,'catalogHash',c.catalogHash,
        'promptHash',c.promptHash,'promptVersion',c.promptVersion,'rulesVersion',c.rulesVersion)) FROM JSON_TABLE(s.payload,'$.cases[*]' COLUMNS(
        conversationId VARCHAR(200) PATH '$.conversationId',sourceHash VARCHAR(64) PATH '$.sourceHash',catalogHash VARCHAR(64) PATH '$.catalogHash',
        promptHash VARCHAR(64) PATH '$.promptHash',promptVersion VARCHAR(200) PATH '$.promptVersion',rulesVersion VARCHAR(200) PATH '$.rulesVersion')) c),JSON_ARRAY())) payload
      FROM comparison_samples s JOIN evaluation_jobs j ON j.id=s.id WHERE JSON_UNQUOTE(JSON_EXTRACT(j.payload,'$.cohortId')) LIKE 'clef-complement-%'`)).map(row => decode(row.payload));
    await onSnapshot(state);
    const ids = [...new Set(state.evaluations.filter(evaluation => evaluation.purpose === 'operational').map(evaluation => evaluation.conversationId))];
    const metadata = [];
    onProgress({ stage: 'metadata', records: 0 });
    for (let offset = 0; offset < ids.length; offset += 300) {
      const batch = ids.slice(offset, offset + 300);
      metadata.push(...await query(atom, `SELECT c.IdConversacion conversationId,p.ISO_Code2 country,
        COALESCE(c.FechaUltimaActividadUtc,(SELECT MAX(ev.FechaHoraUtc) FROM ${tables.events} ev WHERE ev.IdDocumento=c.IdDocumentoVigente
          AND ev.TipoOrigen IN ('text','quickReply','interactive','template','file','call','geopoint')
          AND (ev.TipoOrigen IN ('file','call','geopoint') OR LENGTH(TRIM(COALESCE(ev.Texto,'')))>0)),c.FechaInicioUtc) activityAt
        FROM ${tables.conversations} c JOIN ${tables.documents} d ON d.IdDocumento=c.IdDocumentoVigente AND d.Estado='LISTO'
        JOIN ${tables.countries} p ON p.CodigoPais=c.CodigoPais WHERE c.IdConversacion IN (${batch.map(() => '?').join(',')})`, batch));
    }
    metadata.forEach(row => { row.conversationId = String(row.conversationId); });
    onProgress({ stage: 'counting', records: metadata.length });
    const counted = countMeetingCases(state, metadata, timezone);
    return { readOnly: true, inferenceExecuted: false, startedAt, checkedAt: new Date().toISOString(), timezone,
      dateBasis: 'Current Atom conversation last activity, with message/start fallback; not evaluation execution date.',
      completionBasis: 'Portal operationalEvaluation and hasCompleteLocalModelPair: completed Clef/Gemma reviews from one operational job or its explicit validated cohort complement; unique conversation IDs; no partial/error/demo/fallback results.',
      sourceFreshness: 'Not checked: historical saved evaluations may refer to earlier source content. Counts do not certify current-source equivalence.',
      visibleBasis: 'Current operational reference, ignoring the fixed reviewSelection default.',
      historicalBasis: 'Any retained operational job with completed currently-linked results; not arbitrary comparison jobs and not two unrelated single-model runs.',
      metadataCases: metadata.length, missingSourceMetadata: ids.length - metadata.length,
      missingTimestamp: counted.missingTimestamp, currentOperationalAnchors: counted.operationalAnchors,
      completeVisibleCohortComplementCases: counted.completeComplementCases,
      currentVisible: rankMeetingPeriods(counted.visible), savedHistorical: rankMeetingPeriods(counted.historical) };
  } finally { clearInterval(keepAlive); await Promise.allSettled([app.rollback(), atom.rollback()]); }
}

async function main(args) {
  if (args.length) throw Object.assign(new Error('No arguments accepted.'), { code: 'INVALID_ARGUMENTS' });
  const { databaseConfig, atomDatabaseConfig, config } = await import('../api/src/config.js');
  const mysql = createRequire(new URL('../api/package.json', import.meta.url))('mysql2/promise');
  const appConfig = databaseConfig(), atomConfig = atomDatabaseConfig();
  if (config.demo || !appConfig || !atomConfig) throw Object.assign(new Error('Real database configuration required.'), { code: 'REAL_MODE_REQUIRED' });
  const connections = [];
  const timer = setTimeout(() => connections.forEach(connection => connection.destroy()), 300000);
  try {
    const app = await mysql.createConnection(appConfig); connections.push(app);
    const atom = await mysql.createConnection(atomConfig.connection); connections.push(atom);
    const tables = Object.fromEntries(Object.entries(atomConfig.tables).map(([key, value]) => [key, mysql.escapeId(value)]));
    console.log(JSON.stringify(await auditMeetingPeriod({ app, atom, tables, timezone: config.timezone })));
  } finally { clearTimeout(timer); connections.forEach(connection => connection.destroy()); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => {
  console.log(JSON.stringify({ readOnly: true, inferenceExecuted: false, error: /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'AUDIT_FAILED' }));
  process.exitCode = 1;
});
