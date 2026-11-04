import { Tooltip } from 'antd';
import { ClockCircleOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { metricValue, conversationMetricIds } from '../services/flags';

const times = [
  ['min_primera_respuesta_humano', 'Primera respuesta humana', 5],
  ['min_silencio_max_humano', 'Mayor silencio humano', 10],
  ['min_duracion_conversacion', 'Duración de la conversación', 120],
];
const numeric = value => new Intl.NumberFormat('es-HN', { maximumFractionDigits: 2 }).format(value);
function Explain({ variable, fallback }) { return <Tooltip title={variable?.result?.reason || variable?.definition || fallback}><InfoCircleOutlined aria-label="Cómo se calcula" tabIndex={0} /></Tooltip>; }

export default function ConversationMetrics({ conversation }) {
  const variables = (conversation.metrics || conversation.variables?.filter(v => v.type === 'Métrica') || []).filter(v => conversationMetricIds.includes(v.id));
  if (!variables.length) return null;
  const byId = new Map(variables.map(v => [v.id, v]));
  const get = id => byId.get(id);
  const value = id => metricValue(get(id));
  const missing = id => get(id)?.result?.reason || (get(id)?.enabledInEvaluation === false ? 'Fuera del checklist de esta evaluación.' : 'Sin cálculo disponible en esta evaluación.');
  const assistant = value('num_mensajes_asistente'), client = value('num_mensajes_cliente');
  const maxMessages = Math.max(assistant || 0, client || 0, 1);
  return <section className="conversation-metrics" aria-label="Métricas de la conversación">
    <header><div><span className="eyebrow">LA CONVERSACIÓN EN CIFRAS</span><h2>Tiempo, participación y ritmo</h2></div><span className="metric-source-label">Código y cálculo · {variables.filter(v => metricValue(v) !== null).length} de {conversationMetricIds.length} disponibles</span></header>
    <div className="conversation-metrics-grid">
      <div className="time-metrics">{times.map(([id, label, threshold]) => {
        const n = value(id), scale = Math.max(threshold * 1.5, n ?? 0, 1);
        return <article className="conversation-time-metric" key={id}>
          <div className="conversation-metric-title"><ClockCircleOutlined /><span>{label}</span><Explain variable={get(id)} fallback={missing(id)} /></div>
          <div className="conversation-metric-number">{n === null ? <span className="metric-unavailable">No disponible</span> : <><strong>{numeric(n)}</strong><span>min</span></>}</div>
          {n === null ? <p className="metric-missing-reason">{missing(id)}</p> : <><div className="metric-time-track" aria-hidden="true"><span style={{ width: `${n / scale * 100}%` }} /><i style={{ left: `${threshold / scale * 100}%` }} /></div><small>{id === 'min_primera_respuesta_humano' ? '5 min de referencia · horario pendiente' : `Referencia del flag: más de ${threshold} min`}</small></>}
        </article>;
      })}</div>
      <article className="message-metrics"><div className="conversation-metric-title"><b>Balance de mensajes</b><Explain fallback="Mensajes del asistente (bot y humano) y del cliente. Se excluyen eventos del sistema." /></div><div className="message-bars">{[['Asistente', assistant, 'num_mensajes_asistente'], ['Cliente', client, 'num_mensajes_cliente']].map(([label, n, id]) => <div className={`message-bar-row ${id}`} key={id}><div><span>{label}</span><strong>{n === null ? '—' : numeric(n)}</strong></div>{n === null ? <p className="metric-missing-reason">{missing(id)}</p> : <div className="message-bar-track"><span style={{ width: `${n / maxMessages * 100}%` }} /></div>}</div>)}</div><div className="rhythm-metrics">{[['ratio_mensajes_asistente_entre_cliente', 'Asistente / cliente', '×'], ['num_mensajes_por_turno_asistente', 'Mensajes por turno', 'prom.']].map(([id, label, unit]) => <div key={id}><div className="conversation-metric-title"><span>{label}</span><Explain variable={get(id)} fallback={missing(id)} /></div><strong>{value(id) === null ? '—' : numeric(value(id))}<small>{value(id) === null ? 'No disponible' : unit}</small></strong>{value(id) === null && <p className="metric-missing-reason">{missing(id)}</p>}</div>)}</div></article>
    </div>
  </section>;
}
