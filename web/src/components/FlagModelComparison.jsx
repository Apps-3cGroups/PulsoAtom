import { classificationOf } from '../services/flags';
import { modelResultStatus } from '../services/modelReview';
import { Tag } from 'antd';
import { CheckCircleOutlined, ExclamationCircleOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { dateText, timeText } from './common';

export default function FlagModelComparison({ variable, demo }) {
  const comparison = variable.result.comparison;
  if (!comparison) return <p className="muted">Esta evaluación histórica no tiene una segunda revisión comparable.</p>;
  if (comparison.codeOnly) return <p>{comparison.label}. Este resultado se calcula una sola vez para ambos modelos.</p>;
  const agreed = comparison.agreement === 'agree-positive';
  return <section className="flag-comparison" aria-label={`Revisión de modelos: ${variable.name}`}>
    {demo && <Tag color="gold">Demostración · resultados sintéticos</Tag>}
    <div className={`flag-agreement ${agreed ? 'flag-agreement-positive' : ''}`}>
      {agreed || comparison.agreement === 'agree-negative' ? <CheckCircleOutlined /> : comparison.agreement === 'disagree' ? <ExclamationCircleOutlined /> : <ClockCircleOutlined />}
      <div><strong>{agreed ? 'Detectado por 2 modelos' : comparison.label}</strong><p>El acuerdo entre modelos no equivale a certeza. El dictamen humano se aplica al flag común.</p></div>
    </div>
    {comparison.contingencyLabel && <p className="flag-contingency"><strong>{comparison.contingencyLabel}</strong></p>}
    <div className="flag-model-columns">{comparison.cells.map(cell => {
      const result = cell.result;
      const status = modelResultStatus(cell);
      return <article className="flag-model-column" key={cell.profileId}>
        <header><h3>{cell.label}</h3><Tag color={result?.value === 1 ? classificationOf(variable) === 'positive' ? 'green' : classificationOf(variable) === 'critical' ? 'red' : 'pink' : result?.status === 'evaluado' ? 'default' : 'gold'}>{status}</Tag><small>{cell.model}</small></header>
        <div className="flag-model-body"><h4>{result?.reasonSource === 'adapter_template' ? 'Decisión del modelo' : 'Justificación'}</h4><p>{result?.reason || cell.error?.message || 'La respuesta de este modelo todavía no está disponible.'}</p>
          {result?.reasonSource === 'adapter_template' && <p className="muted small">Descripción preparada por Pulso a partir de la decisión. Este modelo no genera una justificación textual.</p>}
          {result?.codeRule && <div className="flag-rule-note"><b>IA + código</b><p>Una regla compartida ajustó el resultado. No cuenta como un voto independiente.</p>{result.aiResult && <p>Respuesta inicial de IA: {result.aiResult.status === 'evaluado' ? result.aiResult.value === 1 ? 'Evento detectado' : 'Evento no detectado' : 'Sin conclusión'}. {result.aiResult.reason}</p>}</div>}
          <h4>{result?.evidenceSource === 'model_choice' ? 'Mensaje seleccionado por el modelo' : 'Evidencia citada'}</h4>{result?.evidence?.length ? result.evidence.map((e, i) => <blockquote key={`${e.messageId}-${i}`}><p>“{e.quote}”</p><small>Mensaje {e.messageId}</small></blockquote>) : <p className="muted">Sin cita registrada.</p>}
          {cell.createdAt && <small className="muted">{dateText(cell.createdAt)} · {timeText(cell.createdAt)}</small>}
        </div>
      </article>;
    })}</div>
    {comparison.detections === 2 && <p className="flag-evidence-note">{comparison.commonEvidence ? 'Ambos modelos citan al menos un mensaje en común.' : 'Los modelos citan mensajes diferentes.'}</p>}
    <details className="flag-criterion"><summary>Criterio evaluado · versión {variable.version}</summary><p>{variable.definition}</p>{variable.condition && <p>{variable.condition}</p>}</details>
  </section>;
}
