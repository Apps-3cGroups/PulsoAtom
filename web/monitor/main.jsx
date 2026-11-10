import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@ant-design/v5-patch-for-react-19';
import { Alert, Button, ConfigProvider, Progress, Tag } from 'antd';
import { ArrowLeftOutlined, CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import 'antd/dist/reset.css';
import './style.css';
import { createApi, createCollector, createPoller, portalBase } from './progress.js';

const time = value => value ? new Intl.DateTimeFormat('es-HN', { timeZone: 'America/Tegucigalpa', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(value)) : '—';
const number = value => new Intl.NumberFormat('es-HN').format(value);
const pct = value => value.toLocaleString('es-HN', { maximumFractionDigits: 1 });
function Brand() { return <span className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /></span><span>Pulso<span className="brand-period">.</span></span></span>; }

function Monitor({ base }) {
  const [snapshot, setSnapshot] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false), [clock, setClock] = useState(Date.now());
  const poller = useRef(null);
  useEffect(() => {
    const instance = createPoller({ collect: createCollector(createApi(base)), onStart: () => setBusy(true),
      onData: data => { setSnapshot(data); setError(null); setClock(Date.now()); }, onError: setError, onEnd: () => setBusy(false) });
    poller.current = instance; instance.refresh();
    const timer = setInterval(() => setClock(Date.now()), 15_000);
    return () => { clearInterval(timer); instance.stop(); };
  }, [base]);
  const auth = [401, 403].includes(error?.status);
  const stale = !!snapshot && (!!error || clock - Date.parse(snapshot.observedAt) > 90_000);
  const quiet = snapshot && !snapshot.finished && snapshot.activity && clock - Date.parse(snapshot.activity) > 10 * 60_000;
  const status = auth ? 'Inicia sesión en Pulso' : stale ? 'Última lectura guardada' : snapshot?.finished ? 'Corrida finalizada' : snapshot?.paused ? 'En pausa' : snapshot?.interrupted ? 'Revisión interrumpida' : quiet ? 'Sin actividad reciente' : 'Actualización automática';
  const active = snapshot?.models.filter(m => m.active || m.running > 0).map(m => m.label).join(' y ');
  return <div className="monitor-shell">
    <header className="monitor-topbar"><a href={`${base}/`} aria-label="Volver a Pulso"><Brand /></a><span className="topbar-divider" /><span className="monitor-name">Avance en vivo</span><a className="back-link" href={`${base}/evaluaciones`}><ArrowLeftOutlined /> Volver al portal</a></header>
    <main className="monitor-main">
      <div className="page-intro"><div><span className="eyebrow">HONDURAS Y PANAMÁ · ACTIVIDAD DEL 9 DE NOVIEMBRE</span><h1>Así avanza la revisión<span>.</span></h1><p>Clef y Gemma sobre las mismas conversaciones. Completas, parciales y pendientes, en un solo lugar.</p></div><Button icon={<ReloadOutlined />} loading={busy && !!snapshot} disabled={busy} onClick={() => poller.current?.refresh()}>Actualizar ahora</Button></div>
      <div className={`connection-strip${stale || quiet || snapshot?.interrupted || snapshot?.paused ? ' connection-warning' : ''}`} role="status"><span><i className={!error && !snapshot?.finished && !quiet ? 'pulse-dot' : ''} />{status}{!error && !snapshot?.finished && <small> · cada 30 segundos</small>}</span><span>{snapshot ? `Última consulta: ${time(snapshot.observedAt)}` : 'Conectando con Pulso…'} <small>· hora de Honduras</small></span></div>
      {error && <Alert type={auth ? 'warning' : 'error'} showIcon message={error.message} action={auth ? <Button href={`${base}/`} target="_blank" rel="noopener noreferrer">Iniciar sesión</Button> : undefined} />}
      {!snapshot ? <section className="waiting-panel" aria-busy={busy}><Brand /><h2>{error ? 'El avance aparecerá al recuperar la conexión' : 'Consultando la corrida actual'}</h2><p>{error ? 'Inicia sesión en Pulso y vuelve aquí para actualizar.' : 'Leyendo los resultados guardados de Honduras y Panamá.'}</p></section> : <>
        <section className="progress-overview" aria-label="Avance general de las revisiones">
          <div className="progress-main"><div className="progress-heading"><span className="eyebrow">AVANCE GENERAL</span><Tag bordered={false}>{number(snapshot.target)} conversaciones · 2 modelos</Tag></div><div className="progress-content"><div className="donut"><Progress type="circle" percent={snapshot.percent} size={196} strokeWidth={7} strokeColor={stale ? '#8792a6' : '#4f5fd5'} trailColor="#edf0f7" format={() => <div className="donut-label"><strong>{number(snapshot.processed)}</strong><span>de {number(snapshot.total)} revisiones</span></div>} /></div><div className="progress-copy"><div className="progress-percent">{pct(snapshot.percent)}<span>%</span></div><h2>{snapshot.finished ? 'Ambos modelos terminaron.' : active ? `${active} está evaluando.` : 'Esperando el siguiente paso.'}</h2><p>El avance suma completas, parciales y fallidas. Las parciales conservan resultados, pero requieren revisión.</p></div></div><div className="progress-bottom"><span>{snapshot.running} revisiones en proceso</span><span>Cupo diario: <b>200 por país</b></span></div></div>
          <div className="count-grid"><Count title="Completas" value={snapshot.completed} text="Checklist completo guardado" tone="blue" icon={<CheckCircleOutlined />} /><Count title="Pendientes" value={snapshot.pending} text="Incluye las que esperan su turno" tone="muted" icon={<ClockCircleOutlined />} /><Count title="Parciales" value={snapshot.partial} text="Falta parte del checklist" tone="amber" icon={<ExclamationCircleOutlined />} /><Count title="En proceso" value={snapshot.running} text="Evaluaciones que están trabajando" tone="blue" icon={<ReloadOutlined />} /><div className="error-count"><span>Fallidas</span><strong>{snapshot.failed}</strong><span>Se muestran separadas de las parciales</span></div></div>
        </section>
        <section className="model-grid" aria-label="Avance por modelo">{snapshot.models.map((model, index) => <article className={`model-card model-${index}`} key={model.id}><div className="model-card-head"><div><span className="eyebrow">MODELO {index + 1}</span><h2>{model.label}</h2><span className="model-code">{model.model}</span></div><Tag color={stale ? 'default' : model.active ? 'processing' : model.pending ? 'default' : model.partial || model.failed ? 'warning' : 'success'}>{stale ? 'Último estado conocido' : model.status}</Tag></div><div className="model-amount"><strong>{number(model.processed)}<span> / {number(model.total)}</span></strong><b>{pct(model.percent)}%</b></div><Progress percent={model.percent} showInfo={false} strokeColor={index ? '#8b65c9' : '#4f5fd5'} trailColor="#edf0f7" /><div className="model-counts"><Metric label="Completas" value={model.completed} /><Metric label="Parciales" value={model.partial} /><Metric label="Fallidas" value={model.failed} /><Metric label="En proceso" value={model.running} /><Metric label="Pendientes" value={model.pending} /></div><p>{model.active ? `Está procesando ${model.running || 'las siguientes'} conversaciones.` : model.pending ? 'Las pendientes se procesarán cuando llegue el turno de este modelo.' : 'No quedan revisiones pendientes de este modelo.'}</p></article>)}</section>
        <section className="country-grid" aria-label="Detalle por país">{snapshot.countries.map(country => <article className="country-card" key={country.code}><div><span className="country-code">{country.code}</span><h3>{country.name}</h3><b>{country.target} conversaciones</b></div>{country.modelBreakdownAvailable ? <><Progress percent={country.processed / country.totalReviews * 100} showInfo={false} strokeColor="#6174a8" /><p><strong>{country.processed} / {country.totalReviews}</strong> revisiones terminadas · {country.unassigned ? `${country.unassigned} conversaciones esperan asignación al siguiente lote` : 'Todas asignadas a sus lotes'}</p></> : <p>{country.assigned} conversaciones asignadas. El avance por modelo se muestra en el resumen superior.</p>}{country.deferred > 0 && <small>{country.deferred} conversaciones adicionales fuera del cupo de esta tanda.</small>}</article>)}</section>
        {(snapshot.interrupted || quiet || snapshot.paused) && !stale && <Alert type="warning" showIcon message={snapshot.paused ? 'La corrida tiene una pausa registrada.' : snapshot.interrupted ? 'Hay un lote interrumpido por retomar.' : 'No hay actividad guardada en los últimos 10 minutos.'} />}
        <details className="run-details"><summary>Ver los {snapshot.batches.length} lotes de esta corrida</summary><div className="run-list">{snapshot.batches.map(batch => <div key={batch.id}><b>{batch.countries.join(' + ')} · {batch.cases} conversaciones</b><span className="run-id">{batch.id.slice(0, 8)}</span>{batch.models.map(m => <span key={m.id}>{m.label}: <strong>{m.processed}/{m.total}</strong></span>)}<a href={`${base}/evaluaciones`}>Ver detalle →</a></div>)}</div></details>
        <footer className="monitor-footer"><span>Última actividad guardada: <b>{time(snapshot.activity)}</b></span><span>Consulta de avance · Los lotes nuevos de esta misma fecha se incorporan automáticamente.</span></footer>
      </>}
    </main>
  </div>;
}
function Metric({ label, value }) { return <div><strong>{number(value)}</strong><span>{label}</span></div>; }
function Count({ title, value, text, tone, icon }) { return <article className={`count-card count-${tone}`}><div><span>{title}</span>{icon}</div><strong>{number(value)}</strong><p>{text}</p></article>; }
let base, routeError;
try { base = portalBase(window.location.pathname); } catch (error) { routeError = error; }
createRoot(document.getElementById('root')).render(<ConfigProvider theme={{ token: { colorPrimary: '#4f5fd5', colorInfo: '#4f5fd5', fontFamily: '"Instrument Sans", sans-serif', colorText: '#20283b', borderRadius: 10 }, components: { Button: { primaryShadow: 'none' } } }}>{routeError ? <Alert type="error" message={routeError.message} /> : <Monitor base={base} />}</ConfigProvider>);
