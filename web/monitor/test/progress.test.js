import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_DATE, MonitorError, createApi, createCollector, createPoller, portalBase, summarize } from '../progress.js';
const ids = ['clef-local', 'gemma-local'];
const counts = (profileId, total, completed = 0, partial = 0, running = 0) => ({ profileId, total, completed, partial, failed: 0, running, pending: total - completed - partial - running });
function job(id, country, total, progress) {
  const conversationIds = Array.from({ length: total }, (_, i) => `${id}-${i}`);
  return { id, purpose: 'operational', status: 'running', dailyActivity: { date: ACTIVITY_DATE, timezone: 'America/Tegucigalpa' },
    conversationIds, conversationCountries: Object.fromEntries(conversationIds.map(id => [id, country])),
    modelProfiles: ids.map(id => ({ id })), modelProgress: progress, updatedAt: '2026-11-10T16:00:00Z' };
}
const fixture = () => [
  { ...job('first', 'HN', 15, [counts(ids[0], 15, 15), counts(ids[1], 15, 10, 5)]), status: 'partial' },
  job('current', 'HN', 185, [counts(ids[0], 185, 153, 1, 2), counts(ids[1], 185)]),
];
test('suma los lotes de Honduras, incluye Panamá por asignar y separa parciales de completas', () => {
  const jobs = fixture();
  jobs[1].deferredConversationIds = ['outside']; jobs[1].conversationCountries.outside = 'HN';
  const data = summarize({ jobs });
  assert.equal(data.target, 397); assert.equal(data.total, 794);
  assert.deepEqual([data.completed, data.partial, data.running, data.pending], [178, 6, 2, 608]);
  assert.equal(data.models[0].processed, 169); assert.equal(data.models[0].pending, 226);
  assert.equal(data.models[1].processed, 15); assert.equal(data.models[1].pending, 382);
  assert.equal(data.models[0].status, 'En curso'); assert.equal(data.models[1].status, 'Pendiente');
  assert.equal(data.countries[0].assigned, 200); assert.equal(data.countries[1].unassigned, 197);
  assert.equal(data.countries[1].counts.pending, 394); assert.equal(data.deferred, 1);
  assert.equal(data.finished, false);
});
test('incorpora el nuevo lote de Panamá automáticamente y cierra solo cuando terminan ambos modelos', () => {
  const jobs = fixture(); jobs[1].modelProgress = [counts(ids[0],185,184,1), counts(ids[1],185,185)]; jobs[1].status = 'partial';
  const pa = job('panama', 'PA', 197, [counts(ids[0],197,197), counts(ids[1],197,196,0,1)]); jobs.push(pa);
  let data = summarize({ jobs }); assert.equal(data.finished, false); assert.equal(data.unassigned, 0); assert.equal(data.models[1].active, true);
  pa.modelProgress[1] = counts(ids[1],197,197); pa.status = 'completed';
  data = summarize({ jobs }); assert.equal(data.finished, true); assert.equal(data.processed,794); assert.equal(data.percent,100); assert.equal(data.partial,6);
});
test('excluye otros días y rechaza conversaciones duplicadas, países desconocidos y totales inválidos', () => {
  const jobs=fixture(); const other=job('other','HN',1,[counts(ids[0],1),counts(ids[1],1)]);other.dailyActivity.date='2026-11-08';
  assert.equal(summarize({jobs:[...jobs,other]}).target,397);
  assert.throws(()=>summarize({jobs:[...jobs,jobs[0]]}),MonitorError);
  jobs[1].modelProgress[0].pending++; assert.throws(()=>summarize({jobs}),MonitorError);
  const unknown=fixture();delete unknown[1].conversationCountries[unknown[1].conversationIds[0]];assert.throws(()=>summarize({jobs:unknown}),MonitorError);
});
test('el país no se inventa para lotes mixtos; el avance global se conserva', () => {
  const jobs=fixture();jobs[1].conversationCountries[jobs[1].conversationIds[0]]='PA';
  const data=summarize({jobs});assert.equal(data.processed,184);assert.ok(data.countries.every(c=>!c.modelBreakdownAvailable));
});
test('un solo GET autenticado obtiene los agregados; no lee respuestas ni inicia evaluaciones', async () => {
  const calls=[];const collect=createCollector(async path=>{calls.push(path);return{jobs:fixture()};});
  const snapshot=await collect();assert.deepEqual(calls,['/evaluations']);assert.equal(snapshot.models.length,2);
  assert.ok(snapshot.batches.every(b=>!('conversationIds' in b)&&!('modelProfiles' in b)));
});
test('cliente conserva la sesión del portal y distingue acceso vencido de error de servidor', async () => {
  assert.equal(portalBase('/pulsoAtom/monitor-evaluaciones/index.html'),'/pulsoAtom');
  assert.throws(()=>portalBase('/monitor-evaluaciones/index.html'));
  let request;const api=createApi('/pulsoAtom',async(...args)=>{request=args;return{status:401,ok:false};});
  await assert.rejects(api('/evaluations'),error=>error.status===401);
  assert.equal(request[0],'/pulsoAtom/api/evaluations');assert.equal(request[1].credentials,'same-origin');assert.equal(request[1].method,undefined);
});
test('la actualización nunca se superpone y se detiene al terminar o perder sesión', async () => {
  let resolve,calls=0,scheduled=0;
  const poller=createPoller({collect:()=>{calls++;return new Promise(r=>{resolve=r;});},schedule:()=>{scheduled++;return 1;},cancel(){}});
  const first=poller.refresh();await poller.refresh();assert.equal(calls,1);resolve({finished:false});await first;assert.equal(scheduled,1);
  const second=poller.refresh();resolve({finished:true});await second;assert.equal(scheduled,1);poller.stop();
  const auth=createPoller({collect:async()=>{throw new MonitorError('Sesión',401);},schedule:()=>{scheduled++;return 1;},cancel(){}});
  await auth.refresh();assert.equal(scheduled,1);auth.stop();
});
