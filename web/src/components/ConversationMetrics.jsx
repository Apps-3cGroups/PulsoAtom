import { Select, Tooltip } from 'antd';
import { CalendarOutlined, ClockCircleOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { metricValue, conversationMetricIds } from '../services/flags';
import { dailyMetricsView, metricDateText, metricTimeText } from '../services/dailyMetrics';

const times = [
  ['min_primera_respuesta_humano', 'Primera respuesta humana', 'Desde el primer mensaje del cliente.'],
  ['min_silencio_max_humano', 'Mayor silencio humano', 'Espera completada dentro del día.'],
  ['min_duracion_conversacion', 'Tiempo transcurrido del día', 'Entre el primer y el último mensaje.'],
];
const numeric = value => new Intl.NumberFormat('es-HN', { maximumFractionDigits: 2 }).format(value);
function Explain({ variable, fallback }) {
  return <Tooltip title={variable?.result?.reason || fallback}><InfoCircleOutlined aria-label="Cómo se calcula" tabIndex={0} /></Tooltip>;
}

export default function ConversationMetrics({ conversation, selectedDate, onDateChange }) {
  const view = dailyMetricsView(conversation.dailyMetrics, selectedDate);
  const day = view.selectedDay;
  const variables = (Array.isArray(day?.metrics) ? day.metrics : []).filter(v => conversationMetricIds.includes(v.id));
  const byId = new Map(variables.map(v => [v.id, v]));
  const get = id => byId.get(id);
  const value = id => metricValue(get(id));
  const missing = id => get(id)?.result?.reason || 'Sin datos suficientes para calcular esta cifra en el día seleccionado.';
  const assistant = value('num_mensajes_asistente'), client = value('num_mensajes_cliente');
  const maxMessages = Math.max(assistant ?? 0, client ?? 0, 1);
  const maxTime = Math.max(...times.map(([id]) => value(id) ?? 0), 1);
  const pending = day?.pendingHumanWait;
  const crossDayWaits = Array.isArray(day?.crossDayWaits) ? day.crossDayWaits : [];
  const time = timestamp => metricTimeText(timestamp, view.timezone);

  return <section className="conversation-metrics" aria-label="Métricas del día de actividad">
    <header>
      <div><span className="eyebrow">LA CONVERSACIÓN EN CIFRAS</span><h2>Tiempo, participación y ritmo</h2></div>
      <div className="metric-day-controls">
        <label htmlFor="conversation-metric-day"><CalendarOutlined /> Día de actividad</label>
        <Select id="conversation-metric-day" aria-label="Día de actividad" size="small" value={view.selectedDate || undefined} onChange={onDateChange} disabled={!view.days.length} placeholder="Sin días disponibles" options={view.days.map(item => ({ value: item.date, label: metricDateText(item.date) }))} />
      </div>
    </header>
    {day && !view.unavailableReason ? <>
      <div className="metric-day-summary" aria-live="polite" aria-atomic="true">
        <span><b>{metricDateText(day.date)}</b> · {day.messageCount} {day.messageCount === 1 ? 'mensaje' : 'mensajes'} · {time(day.firstMessageAt)}–{time(day.lastMessageAt)}{view.timezone && <span className="metric-timezone"> · {view.timezone}</span>}</span>
        <span className="metric-source-label">Cálculo por código · {variables.filter(v => metricValue(v) !== null).length} de {conversationMetricIds.length} disponibles</span>
      </div>
      <div className="conversation-metrics-grid">
        <div className="time-metrics">{times.map(([id, label, detail]) => {
          const n = value(id);
          return <article className="conversation-time-metric" key={id}>
            <div className="conversation-metric-title"><ClockCircleOutlined /><span>{label}</span><Explain variable={get(id)} fallback={missing(id)} /></div>
            <div className="conversation-metric-number">{n === null ? <span className="metric-unavailable">No disponible</span> : <><strong>{numeric(n)}</strong><span>min</span></>}</div>
            {n === null ? <p className="metric-missing-reason">{missing(id)}</p> : <><div className="metric-time-track" aria-hidden="true"><span style={{ width: `${Math.max(0, n) / maxTime * 100}%` }} /></div><small>{detail}</small></>}
          </article>;
        })}</div>
        <article className="message-metrics">
          <div className="conversation-metric-title"><b>Balance de mensajes</b><Explain fallback="Mensajes del asistente (bot y humano) y del cliente dentro del día seleccionado. Se excluyen eventos del sistema." /></div>
          <div className="message-bars">{[['Asistente', assistant, 'num_mensajes_asistente'], ['Cliente', client, 'num_mensajes_cliente']].map(([label, n, id]) => <div className={`message-bar-row ${id}`} key={id}><div><span>{label}</span><strong>{n === null ? '—' : numeric(n)}</strong></div>{n === null ? <p className="metric-missing-reason">{missing(id)}</p> : <div className="message-bar-track" aria-hidden="true"><span style={{ width: `${Math.max(0, n) / maxMessages * 100}%` }} /></div>}</div>)}</div>
          <div className="rhythm-metrics">{[['ratio_mensajes_asistente_entre_cliente', 'Asistente / cliente', '×'], ['num_mensajes_por_turno_asistente', 'Mensajes por turno', 'prom.']].map(([id, label, unit]) => <div key={id}><div className="conversation-metric-title"><span>{label}</span><Explain variable={get(id)} fallback={missing(id)} /></div><strong>{value(id) === null ? '—' : numeric(value(id))}<small>{value(id) === null ? 'No disponible' : unit}</small></strong>{value(id) === null && <p className="metric-missing-reason">{missing(id)}</p>}</div>)}</div>
        </article>
      </div>
      {(pending || crossDayWaits.length > 0) && <div className="metric-day-notices">
        {pending && <div className="metric-day-notice"><ClockCircleOutlined /><div><b>Respuesta humana pendiente al corte</b><p>{typeof pending.observedMinutes === 'number' && Number.isFinite(pending.observedMinutes) ? `${numeric(pending.observedMinutes)} min observados` : 'Intervalo observado no disponible'} · {time(pending.startedAt)}–{time(pending.observedThrough)}. Sin respuesta humana registrada hasta ese corte.</p></div></div>}
        {crossDayWaits.length > 0 && <div className="metric-day-notice"><InfoCircleOutlined /><div><b>Continuidad entre días por confirmar</b><p>{crossDayWaits.length === 1 ? `${metricDateText(crossDayWaits[0].startDate)} → ${metricDateText(crossDayWaits[0].responseDate)}.` : `${crossDayWaits.length} intervalos con respuesta humana en otro día.`} Estos intervalos se excluyen de los tiempos de respuesta del día.</p></div></div>}
      </div>}
    </> : <div className="metric-day-empty"><InfoCircleOutlined /><div><b>Métricas diarias no disponibles</b><p>{view.unavailableReason}</p></div></div>}
    <footer className="metric-day-footer">
      <p>El día seleccionado solo cambia estas cifras; el checklist conserva la evaluación guardada.</p>
      {day && !view.unavailableReason && times.some(([id]) => value(id) !== null) && <span>Barras de tiempo en una escala común de {numeric(maxTime)} min.</span>}
      {view.invalidTimestampCount > 0 && <span>{view.invalidTimestampCount} {view.invalidTimestampCount === 1 ? 'mensaje sin fecha válida queda' : 'mensajes sin fecha válida quedan'} fuera del cálculo diario.</span>}
    </footer>
  </section>;
}
