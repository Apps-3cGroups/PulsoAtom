import { useState } from 'react';
import { App, Alert, Form, Input, Modal, Select } from 'antd';
import { api } from '../services/api';
import { dateText, timeText } from './common';
export { canReviewVariable, nextReviewAction } from '../services/reviewPolicy';

export const reviewReasons = {
  falso_positivo: 'Falso positivo',
  evidencia_mal_interpretada: 'Evidencia mal interpretada',
  falta_contexto: 'Falta de contexto',
  omision_del_modelo: 'Omisión del modelo',
  otro: 'Otro motivo',
  validacion_humana: 'Validación humana del checklist',
};
export const reviewActions = { refutar: 'Refutar flag', levantar: 'Levantar flag', deshacer: 'Deshacer revisión' };
const actorName = actor => ({ cliente: 'Cliente', humano: 'Asistente de venta', bot: 'Bot', sistema: 'Sistema' }[actor] || actor);

export default function ReviewModal({ conversation, editing, onClose, onSaved }) {
  // A different message/variable is a new review draft. Remount the form so an
  // earlier selection, comment or error cannot be submitted for the new target.
  const key = JSON.stringify([conversation.id, conversation.evaluation?.id, editing.variable.id, editing.action, editing.messageId ?? null]);
  return <ReviewForm key={key} conversation={conversation} editing={editing} onClose={onClose} onSaved={onSaved} />;
}

function ReviewForm({ conversation, editing, onClose, onSaved }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const { message } = App.useApp();
  const { variable, action } = editing;
  const initialMessageId = action === 'levantar' && conversation.messages.some(m => m.id === editing.messageId) ? editing.messageId : undefined;
  const selectedMessageId = Form.useWatch('messageId', form);
  const selectedMessage = action === 'levantar' ? conversation.messages.find(m => m.id === selectedMessageId) : null;
  const submit = async () => {
    let values; try { values = await form.validateFields(); } catch { return; }
    setSaving(true); setError(null);
    try {
      const last = conversation.reviews.filter(r => r.variableId === variable.id).at(-1);
      await api(`/conversations/${encodeURIComponent(conversation.id)}/reviews`, { method: 'POST', body: { ...values, variableId: variable.id, evaluationId: conversation.evaluation.id, expectedReviewId: last?.id || null, expectedVerdictId: variable.verdict?.id || null, action } });
      message.success(conversation.demo ? 'Revisión guardada en la demostración.' : 'Revisión guardada.'); onSaved();
    } catch (reason) { setError(reason); } finally { setSaving(false); }
  };
  return <Modal open title={reviewActions[action]} zIndex={1100} onCancel={() => { if (!saving) onClose(); }} onOk={submit} confirmLoading={saving} okText="Guardar revisión" cancelText="Cancelar" cancelButtonProps={{ disabled: saving }} maskClosable={!saving} width={620}>
    <div className="modal-intro"><b>{variable.name}</b><p>{action === 'deshacer' ? 'El resultado volverá al valor original del sistema. El historial conservará ambas acciones.' : action === 'levantar' ? 'Revisa el mensaje que demuestra el evento y explica tu criterio.' : 'Explica por qué la evidencia no sustenta este flag.'}</p></div>
    {error && <Alert showIcon type="error" message={error.message} />}
    <Form form={form} layout="vertical" initialValues={{ reason: action === 'levantar' ? 'omision_del_modelo' : action === 'refutar' ? 'falso_positivo' : 'otro', messageId: initialMessageId }}>
      <Form.Item name="reason" label="Motivo" rules={[{ required: true, message: 'Selecciona un motivo.' }]}><Select options={Object.entries(reviewReasons).filter(([key]) => key !== 'validacion_humana').map(([value, label]) => ({ value, label }))} /></Form.Item>
      {action === 'levantar' && <>
        <Form.Item name="messageId" label="Mensaje de evidencia" rules={[{ required: true, message: 'Selecciona el mensaje que demuestra el evento.' }]}><Select showSearch optionFilterProp="label" options={conversation.messages.map(m => ({ value: m.id, label: `${actorName(m.actor)} · ${m.text}` }))} optionRender={option => <span style={{ whiteSpace: 'normal' }}>{option.label}</span>} /></Form.Item>
        {selectedMessage && <div className="evidence-quote review-evidence-preview" role="note" aria-label="Mensaje seleccionado como evidencia" style={{ marginBottom: 20 }}>
          <div className="evidence-meta"><b>{actorName(selectedMessage.actor)}</b><span>{Number.isFinite(Date.parse(selectedMessage.timestamp)) ? `${dateText(selectedMessage.timestamp)} · ${timeText(selectedMessage.timestamp)}` : 'Fecha no disponible'}</span></div>
          <p style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflowY: 'auto' }}>{selectedMessage.text}</p>
        </div>}
      </>}
      <Form.Item name="comment" label="Comentario" rules={[{ required: true, min: 5, max: 2000, whitespace: true, message: 'Describe el motivo con al menos 5 caracteres.' }]}><Input.TextArea rows={3} maxLength={2000} showCount placeholder="Describe lo que observaste en la conversación." /></Form.Item>
    </Form>
  </Modal>;
}
