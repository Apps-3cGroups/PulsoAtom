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
  const quiet = snapshot && !snapshot.finished && (snapshot.stalled || !snapshot.preparing && snapshot.activity && clock - Date.parse(snapshot.activity) > 10 * 60_000);
  const status = auth ? 'Inicia sesión en Pulso' : stale ? 'Última lectura guardada' : snapshot?.finished ? 'Alcance completado' : snapshot?.blocked ? 'La ejecución requiere atención' : quiet ? 'Sin actividad reciente' : snapshot?.paused ? 'En pausa' : snapshot?.interrupted ? 'Revisión interrumpida' : snapshot?.preparing ? 'Preparando siguientes revisiones' : 'Actualización automática';
  const active = snapshot?.models.filter(m => m.active || m.running > 0).map(m => m.label).join(' y ');
  return <div className="monitor-shell">
    <header className="monitor-topbar"><a href={`${base}/`} aria-label="Volver a Pulso"><Brand /></a><span className="topbar-divider" /><span className="monitor-name">Avance en vivo</span><a className="back-link" href={`${base}/evaluaciones`}><ArrowLeftOutlined /> Volver al portal</a></header>
    <main className="monitor-main">
      <div className="page-intro"><div><span className="eyebrow">HONDURAS Y PANAMÁ · RECUPERACIÓN DEL MARTES 10 Y MIÉRCOLES 11</span><h1>Así avanza la revisión<span>.</span></h1><p>Avance del alcance autorizado: 212 conversaciones, con sus revisiones pendientes de Clef y Gemma.</p></div><Button icon={<ReloadOutlined />} loading={busy && !!snapshot} disabled={busy} onClick={() => poller.current?.refresh()}>Actualizar ahora</Button></div>
      <div className={`connection-strip${stale || quiet || snapshot?.blocked || snapshot?.interrupted || snapshot?.paused ? ' connection-warning' : ''}`} role="status"><span><i className={!error && !snapshot?.finished && !quiet ? 'pulse-dot' : ''} />{status}{!error && <small> · cada 30 segundos</small>}</span><span>{snapshot ? `Última consulta: ${time(snapshot.observedAt)}` : 'Conectando con Pulso…'} <small>· hora de Honduras</small></span></div>
      {error && <Alert type={auth ? 'warning' : 'error'} showIcon message={error.message} action={auth ? <Button href={`${base}/`} target="_blank" rel="noopener noreferrer">Iniciar sesión</Button> : undefined} />}
      {!snapshot ? <section className="waiting-panel" aria-busy={busy}><Brand /><h2>{error ? 'El avance aparecerá al recuperar la conexión' : 'Consultando la corrida actual'}</h2><p>{error ? 'Inicia sesión en Pulso y vuelve aquí para actualizar.' : 'Leyendo los resultados guardados de Honduras y Panamá.'}</p></section> : <>
        <Alert type="info" showIcon message={`${number(snapshot.preserved)} revisiones anteriores conservadas · ${snapshot.excluded} conversación excluida por autorización, sin borrar sus resultados.`} />
        <section className="progress-overview" aria-label="Avance general de las revisiones">
          <div className="progress-main"><div className="progress-heading"><span className="eyebrow">AVANCE GENERAL</span><Tag bordered={false}>{number(snapshot.target)} conversaciones · {number(snapshot.total)} revisiones</Tag></div><div className="progress-content"><div className="donut"><Progress type="circle" percent={snapshot.percent} size={196} strokeWidth={7} strokeColor={stale ? '#8792a6' : '#4f5fd5'} trailColor="#edf0f7" format={() => <div className="donut-label"><strong>{number(snapshot.completed)}</strong><span>de {number(snapshot.total)} revisiones</span></div>} /></div><div className="progress-copy"><div className="progress-percent">{pct(snapshot.percent)}<span>%</span></div><h2>{snapshot.finished ? 'Revisión del alcance completada.' : active ? `${active} está evaluando.` : 'Esperando el siguiente paso.'}</h2><p>El avance cuenta únicamente revisiones completas. Las parciales y fallidas conservan resultados y se muestran por separado.</p></div></div><div className="progress-bottom"><span>{snapshot.running} revisiones en proceso</span><span>Procesamiento: <b>{snapshot.concurrency} a la vez</b></span></div></div>
          <div className="count-grid"><Count title="Completas" value={snapshot.completed} text="Checklist completo guardado" tone="blue" icon={<CheckCircleOutlined />} /><Count title="Pendientes" value={snapshot.pending} text="Incluye las que esperan su turno" tone="muted" icon={<ClockCircleOutlined />} /><Count title="Parciales" value={snapshot.partial} text="Falta parte del checklist" tone="amber" icon={<ExclamationCircleOutlined />} /><Count title="En proceso" value={snapshot.running} text="Evaluaciones que están trabajando" tone="blue" icon={<ReloadOutlined />} /><div className="error-count"><span>Fallidas</span><strong>{snapshot.failed}</strong><span>Se muestran separadas de las parciales</span></div></div>
        </section>
        <section className="model-grid" aria-label="Avance por modelo">{snapshot.models.map((model, index) => <article className={`model-card model-${index}`} key={model.id}><div className="model-card-head"><div><span className="eyebrow">MODELO {index + 1}</span><h2>{model.label}</h2><span className="model-code">{model.model}</span></div><Tag color={stale ? 'default' : model.active ? 'processing' : model.pending ? 'default' : model.partial || model.failed ? 'warning' : 'success'}>{stale ? 'Último estado conocido' : model.status}</Tag></div><div className="model-amount"><strong>{number(model.completed)}<span> / {number(model.total)}</span></strong><b>{pct(model.percent)}%</b></div><Progress percent={model.percent} showInfo={false} strokeColor={index ? '#8b65c9' : '#4f5fd5'} trailColor="#edf0f7" /><div className="model-counts"><Metric label="Completas" value={model.completed} /><Metric label="Parciales" value={model.partial} /><Metric label="Fallidas" value={model.failed} /><Metric label="En proceso" value={model.running} /><Metric label="Pendientes" value={model.pending} /></div><p>{model.active ? `Está procesando ${model.running || 'las siguientes'} conversaciones.` : model.pending ? 'Las pendientes se procesan en el orden del lote.' : 'No quedan revisiones pendientes de este modelo.'}</p></article>)}</section>
        <section className="country-grid" aria-label="Revisiones completas por día del alcance">{snapshot.phases.map(phase => <article className="country-card" key={phase.key}><div><span className="country-code">{phase.code}</span><h3>{phase.name}</h3><b>{phase.target} conversaciones</b></div><Progress percent={phase.counts.completed / phase.totalReviews * 100} showInfo={false} strokeColor="#6174a8" /><p><strong>{phase.counts.completed} / {phase.totalReviews}</strong> revisiones completas · {phase.unassigned ? `${phase.unassigned} conversaciones esperan la creación de su lote` : 'Lote asignado'}</p><small>{phase.key === 'tuesday' ? '167 nuevas con ambos modelos + 2 revisiones pendientes de Gemma. Una conversación excluida.' : '43 conversaciones iniciadas el miércoles. Su última actividad puede ubicarlas el jueves en Resumen.'}</small></article>)}</section>
        {(snapshot.blocked || snapshot.interrupted || quiet || snapshot.paused) && !stale && <Alert type="warning" showIcon message={snapshot.blocked ? 'La ejecución se detuvo y conserva los resultados guardados.' : snapshot.paused ? 'Hay otro mantenimiento activo.' : snapshot.interrupted ? 'Hay un lote interrumpido por retomar.' : 'No hay actividad guardada en los últimos 10 minutos.'} />}
        <details className="run-details"><summary>Ver los {snapshot.batches.length} lotes de esta corrida</summary><div className="run-list">{snapshot.batches.map(batch => <div key={batch.id}><b>{batch.label} · {batch.cases} conversaciones</b><span className="run-id">{batch.id.slice(0, 8)}</span>{batch.models.map(m => <span key={m.id}>{m.label}: <strong>{m.completed}/{m.total}</strong></span>)}<a href={`${base}/evaluaciones`}>Ver detalle →</a></div>)}</div></details>
        <footer className="monitor-footer"><span>Última actividad guardada: <b>{time(snapshot.activity)}</b></span><span>Solo lectura · Este monitor sigue exclusivamente las 212 conversaciones autorizadas.</span></footer>
      </>}
    </main>
  </div>;
}
function Metric({ label, value }) { return <div><strong>{number(value)}</strong><span>{label}</span></div>; }
function Count({ title, value, text, tone, icon }) { return <article className={`count-card count-${tone}`}><div><span>{title}</span>{icon}</div><strong>{number(value)}</strong><p>{text}</p></article>; }
let base, routeError;
try { base = portalBase(window.location.pathname); } catch (error) { routeError = error; }
createRoot(document.getElementById('root')).render(<ConfigProvider theme={{ token: { colorPrimary: '#4f5fd5', colorInfo: '#4f5fd5', fontFamily: '"Instrument Sans", sans-serif', colorText: '#20283b', borderRadius: 10 }, components: { Button: { primaryShadow: 'none' } } }}>{routeError ? <Alert type="error" message={routeError.message} /> : <Monitor base={base} />}</ConfigProvider>);
