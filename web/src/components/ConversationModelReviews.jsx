import { useMemo, useState } from 'react';
import { Select, Tag, Tooltip } from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, ReadOutlined } from '@ant-design/icons';
import { modelReviewVariables, modelReviewStatusLabel } from '../services/modelReview';
import FlagModelComparison from './FlagModelComparison';
import { dateText, timeText } from './common';

export default function ConversationModelReviews({ conversation }) {
  const [selectedId, setSelectedId] = useState(null);
  const reviews = conversation.evaluation?.modelReviews || [];
  const variables = useMemo(() => modelReviewVariables(conversation.variables), [conversation.variables]);
  const selected = variables.find(variable => variable.id === selectedId) || variables[0];
  if (!reviews.length) return null;
  return <section className="conversation-model-reviews" aria-label="Evaluaciones guardadas de los modelos">
    <header className="model-reviews-heading"><div><span className="eyebrow">DOS MIRADAS, UNA CONVERSACIÓN</span><h2>Evaluaciones de los modelos</h2></div><span className="muted small"><ReadOutlined /> Resultados guardados</span></header>
    <div className="model-review-cards">{reviews.map(review => {
      const complete = review.status === 'completed';
      const error = ['partial', 'failed'].includes(review.status);
      const hasResult = ['completed', 'partial'].includes(review.status) || review.evaluatedCount > 0;
      return <article key={review.profileId} className={`model-review-card ${complete ? 'review-complete' : error ? 'review-error' : 'review-pending'}`}>
        <span className="model-review-icon" aria-hidden="true">{complete ? <CheckCircleOutlined /> : error ? <ExclamationCircleOutlined /> : <ClockCircleOutlined />}</span>
        <div className="model-review-description"><h3>{review.label || review.profileId}</h3><Tooltip title={review.model}><span className="model-review-model">{review.model}</span></Tooltip><span>{modelReviewStatusLabel(review.status)}</span></div>
        <div className="model-review-coverage"><strong>{hasResult ? <>{review.evaluatedCount ?? 0}<small>/{review.totalVariables ?? 0}</small></> : '—'}</strong><span>{hasResult ? 'variables con resultado' : 'Sin resultado guardado'}</span>{review.abstainedCount > 0 && <small>{review.abstainedCount} sin contexto suficiente</small>}{review.errorCount > 0 && <Tag color="orange">{review.errorCount} con errores</Tag>}{review.createdAt && <small>{dateText(review.createdAt, { year: undefined })} · {timeText(review.createdAt)}</small>}</div>
      </article>;
    })}</div>
    {selected ? <>
      <div className="model-review-selector"><label htmlFor="model-review-variable">Revisar una variable</label><Select id="model-review-variable" aria-label="Variable para ver las evaluaciones de ambos modelos" value={selected.id} onChange={setSelectedId} showSearch optionFilterProp="label" options={variables.map(variable => ({ value: variable.id, label: variable.name }))} /><span className="muted small">{variables.length} variables · incluye eventos no detectados</span></div>
      <FlagModelComparison variable={selected} demo={conversation.demo} />
    </> : <p className="model-review-empty">Cuando exista una respuesta comparable, verás aquí la decisión y la evidencia de cada modelo. La ausencia de una revisión no significa que no haya flags.</p>}
  </section>;
}
