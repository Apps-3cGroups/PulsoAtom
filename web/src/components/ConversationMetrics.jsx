import { Popover, Select, Tooltip } from 'antd';
import { CalendarOutlined, ClockCircleOutlined, CommentOutlined, InfoCircleOutlined, MessageOutlined } from '@ant-design/icons';
import { metricValue, conversationMetricIds } from '../services/flags';
import { dailyMetricsView, metricDateText, metricTimeText } from '../services/dailyMetrics';
import { durationLabel, durationParts } from '../services/metricPresentation';
import MetricActivityTimeline from './MetricActivityTimeline';

const numeric = value => new Intl.NumberFormat('es-HN', { maximumFractionDigits: 2 }).format(value);
function Explain({ label, children }) {
  return <Tooltip title={children}><button type="button" className="metric-explain" aria-label={`Cómo se calcula: ${label}`}><InfoCircleOutlined /></button></Tooltip>;
}
function Duration({ value }) {
  const parts = durationParts(value);
  return <div className="conversation-metric-number" aria-label={durationLabel(value)}>{parts ? parts.map(part => <span className="metric-time-part" key={part.unit}><strong>{numeric(part.value)}</strong><span>{part.unit}</span></span>) : <span className="metric-unavailable">No disponible</span>}</div>;
}
function ResponseCard({ id, label, subtitle, variable }) {
  const value = metricValue(variable);
  const reason = variable?.result?.reason || 'No hay datos suficientes para medir esta espera.';
  return <article className="metric-response-card" aria-labelledby={`metric-title-${id}`}>
    <div className="metric-kpi-label"><h3 id={`metric-title-${id}`}>{label}</h3><Explain label={label}>{reason}</Explain></div>
    <Duration value={value} />
    <p className="metric-card-caption">{value === null ? reason : subtitle}</p>
  </article>;
}
function Participation({ assistant, client, counts, children }) {
  const available = assistant !== null && client !== null;
  const total = available ? assistant + client : null;
  const teamShare = total > 0 ? assistant / total : 0;
  return <article className="metric-participation-card">
    <div className="metric-participation-heading"><h3>Quién escribió</h3><Explain label="Mensajes del día">Cuenta los mensajes del cliente y del equipo (Agente humano + Bot). Excluye eventos técnicos y emisores sin identificar. Las proporciones muestran participación, no calidad de atención.</Explain></div>
    <div className="metric-participation-visual">
      <div className="metric-message-ring" role="img" aria-label={available ? `${numeric(total)} ${total === 1 ? 'mensaje' : 'mensajes'}: ${numeric(client)} del cliente y ${numeric(assistant)} del equipo` : 'Distribución de mensajes no disponible'}>
        <svg viewBox="0 0 132 132" aria-hidden="true"><circle cx="66" cy="66" r="55" className="metric-ring-base" />{total > 0 && <><circle cx="66" cy="66" r="55" pathLength="100" className="metric-ring-client" /><circle cx="66" cy="66" r="55" pathLength="100" strokeDasharray={`${teamShare * 100} 100`} className="metric-ring-team" /></>}</svg>
        <div><strong>{total === null ? '—' : numeric(total)}</strong><span>{total === 1 ? 'mensaje' : 'mensajes'}</span></div>
      </div>
      <div className="metric-participation-legend"><div><i className="client-dot" /><span>Cliente</span><strong>{client === null ? '—' : numeric(client)}</strong></div>{[['Bot', counts?.bot], ['Agente humano', counts?.humano]].map(([label, count]) => <div key={label}><i className="team-dot" /><span>{label}</span><strong>{count == null ? '—' : numeric(count)}</strong></div>)}</div>
    </div>
    <p className="metric-participation-caption">{!available ? 'Faltan datos para mostrar la distribución.' : total === 0 ? 'Sin mensajes contabilizados.' : client > assistant ? 'El cliente envió más mensajes.' : assistant > client ? 'El equipo envió más mensajes.' : 'Cliente y equipo enviaron la misma cantidad.'}</p>
    {children}
  </article>;
}

export default function ConversationMetrics({ conversation, selectedDate, onDateChange }) {
  const view = dailyMetricsView(conversation.dailyMetrics, selectedDate);
  const day = view.selectedDay;
  const variables = (Array.isArray(day?.metrics) ? day.metrics : []).filter(v => conversationMetricIds.includes(v.id));
  const byId = new Map(variables.map(v => [v.id, v]));
  const get = id => byId.get(id);
  const value = id => metricValue(get(id));
  const pending = day?.pendingHumanWait;
  const crossDayWaits = Array.isArray(day?.crossDayWaits) ? day.crossDayWaits : [];
  const available = !!day && !view.unavailableReason;
  const time = timestamp => metricTimeText(timestamp, view.timezone);
  const ratio = value('ratio_mensajes_asistente_entre_cliente'), turn = value('num_mensajes_por_turno_asistente');
  const duration = value('min_duracion_conversacion');
  const explanation = <div className="metric-help-content"><p>Las cifras corresponden solo al día seleccionado. La transcripción y el checklist conservan su alcance original.</p><p>El tiempo transcurrido incluye pausas. La espera más larga solo considera intervalos que terminaron con una respuesta humana dentro del día.</p><p>Las esperas pendientes se observan hasta el último mensaje disponible; no avanzan con la hora actual.</p><p>{variables.filter(v => metricValue(v) !== null).length} de 7 métricas disponibles · Calculadas por código.</p>{view.timezone && <p>Zona horaria: {view.timezone}.</p>}</div>;
  return <section className="conversation-metrics" aria-label="Métricas del día de actividad">
    <header><div><span className="eyebrow">LA CONVERSACIÓN EN CIFRAS</span><h2>Así fue este día</h2><p className="metric-day-summary" aria-live="polite" aria-atomic="true">{available ? <><b>{metricDateText(day.date)}</b><span>·</span>{day.messageCount} {day.messageCount === 1 ? 'mensaje' : 'mensajes'}<span>·</span>{time(day.firstMessageAt)}–{time(day.lastMessageAt)}</> : 'Consulta la actividad registrada en esta conversación.'}</p></div><div className="metric-day-controls"><label htmlFor="conversation-metric-day"><CalendarOutlined /> Día de actividad</label><Select id="conversation-metric-day" aria-label="Día de actividad" value={view.selectedDate || undefined} onChange={onDateChange} disabled={!view.days.length} placeholder="Sin días disponibles" options={view.days.map(item => ({ value: item.date, label: metricDateText(item.date) }))} /></div></header>
    {available ? <>
      <div className="metric-overview-grid" key={day.date}>
        <div className="metric-story-panel">
          <div className="metric-time-kpis">
            <article className="metric-feature-card">
              <div className="metric-kpi-label"><h3>Tiempo transcurrido</h3><Explain label="Tiempo transcurrido">{get('min_duracion_conversacion')?.result?.reason || 'Del primer al último mensaje del día. Incluye pausas; no representa tiempo de trabajo activo.'}</Explain></div>
              <Duration value={duration} /><p className="metric-card-caption">{duration === null ? get('min_duracion_conversacion')?.result?.reason || 'No hay datos suficientes.' : 'Del primer al último mensaje. Incluye pausas.'}</p>
            </article>
            <ResponseCard id="first" label="Primera respuesta humana" subtitle="Desde el primer mensaje del cliente." variable={get('min_primera_respuesta_humano')} />
            <ResponseCard id="longest" label="Espera más larga con respuesta" subtitle={value('min_primera_respuesta_humano') !== null && value('min_primera_respuesta_humano') === value('min_silencio_max_humano') ? 'Coincide con la primera respuesta.' : 'Mayor espera atendida dentro del día.'} variable={get('min_silencio_max_humano')} />
          </div>
          <MetricActivityTimeline conversation={conversation} day={day} timezone={view.timezone} firstResponse={get('min_primera_respuesta_humano')} />
        </div>
        <Participation assistant={value('num_mensajes_asistente')} client={value('num_mensajes_cliente')} counts={day.messageCounts}>
      <div className="metric-rhythm-strip">
        <div><span className="metric-rhythm-icon"><CommentOutlined /></span><div><span className="metric-rhythm-label">Por cada mensaje del cliente</span><p><strong>{ratio === null ? '—' : numeric(ratio)}</strong><span>{ratio === null ? 'Relación no disponible' : 'mensajes del equipo'}</span></p></div><Explain label="Relación de mensajes">{get('ratio_mensajes_asistente_entre_cliente')?.result?.reason || 'Mensajes del equipo divididos entre mensajes del cliente. Si no hay mensajes del cliente, no se calcula.'}</Explain></div>
        <div><span className="metric-rhythm-icon"><MessageOutlined /></span><div><span className="metric-rhythm-label">En cada turno del equipo</span><p><strong>{turn === null ? '—' : numeric(turn)}</strong><span>{turn === null ? 'Promedio no disponible' : 'mensajes seguidos, en promedio'}</span></p></div><Explain label="Mensajes por turno">{get('num_mensajes_por_turno_asistente')?.result?.reason || 'Un turno reúne los mensajes seguidos del equipo antes de que vuelva a escribir el cliente.'}</Explain></div>
        </div>
        </Participation>
      </div>
      {pending && <div className="metric-pending-banner" role="note"><span className="metric-pending-icon"><ClockCircleOutlined /></span><div><b>Quedó un mensaje sin respuesta humana</b><p>{pending.observedMinutes > 0 ? <>{durationLabel(pending.observedMinutes)} de espera observada · </> : null}Sin respuesta humana hasta las {time(pending.observedThrough)}, último dato disponible.</p></div><span className="metric-pending-label">Pendiente al corte</span></div>}
    </> : <div className="metric-day-empty"><InfoCircleOutlined /><div><b>Métricas diarias no disponibles</b><p>{view.unavailableReason}</p></div></div>}
    <footer className="metric-day-footer"><span>{crossDayWaits.length > 0 ? <Tooltip title={crossDayWaits.map(wait => `${metricDateText(wait.startDate)} → ${metricDateText(wait.responseDate)}: continuidad no confirmada. No se suma a las esperas del día.`).join(' ')}><span className="metric-cross-day-note" tabIndex={0}><InfoCircleOutlined />Hay mensajes en días distintos. Las esperas se miden dentro de cada día.</span></Tooltip> : 'El día seleccionado solo cambia estas cifras.'}</span><Popover title="Cómo leer estas cifras" content={explanation} trigger="click" placement="topRight"><button type="button" className="metric-help-button" aria-label="Cómo leer estas cifras"><InfoCircleOutlined aria-hidden="true" />Cómo leer estas cifras</button></Popover></footer>
  </section>;
}
