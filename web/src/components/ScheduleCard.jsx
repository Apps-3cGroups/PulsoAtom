import { useEffect, useState } from 'react';
import { App, Alert, Button, Form, Input, Select, Switch, Tag } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import { saveSchedule, verifySchedule, scheduleValues, sameSchedule } from '../services/schedule.js';

export default function ScheduleCard({ data, isAdmin, onSaved }) {
  const [form] = Form.useForm();
  const [saved, setSaved] = useState(data.settings);
  const [draft, setDraft] = useState(() => scheduleValues(data.settings));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [pending, setPending] = useState(null);
  const { message } = App.useApp();
  const ready = data.mode === 'real' && data.status.ready;
  const dirty = !sameSchedule(draft, saved);

  useEffect(() => {
    if (data.settings.version <= saved.version || saving || pending) return;
    setSaved(data.settings);
    if (!dirty) {
      const values = scheduleValues(data.settings);
      setDraft(values); form.setFieldsValue(values);
    } else setNotice({ type: 'warning', message: 'La programación cambió en el servidor. Revisa tus cambios antes de guardarlos.' });
  }, [data.settings, saved.version, dirty, saving, pending, form]);

  const finish = (result, attempt) => {
    if (result.status === 'unknown') {
      setPending(attempt);
      setNotice({ type: 'warning', message: 'No pudimos confirmar si se guardó.', description: 'Tus cambios siguen aquí. Comprueba el estado guardado al recuperar la conexión; no es necesario enviarlos otra vez.' });
      return;
    }
    setPending(null);
    setSaved(result.settings);
    if (result.status === 'confirmed') {
      const values = scheduleValues(result.settings);
      setDraft(values); form.setFieldsValue(values); setNotice(null);
      message.success(result.verified ? 'Programación verificada en el servidor.' : values.dailyEnabled ? 'Evaluación diaria activada.' : 'Configuración diaria guardada.');
      onSaved();
    } else setNotice({ type: 'warning', message: result.status === 'conflict' ? 'La programación cambió en el servidor. Revisa tus cambios antes de guardarlos.' : 'El cambio todavía no aparece guardado. Conservamos tus cambios para que puedas reintentar.' });
  };
  const save = async values => {
    if (saving || pending || !dirty) return;
    const attempt = { values: scheduleValues(values), version: saved.version };
    setSaving(true); setNotice(null);
    try { finish(await saveSchedule(attempt.values, attempt.version), attempt); }
    catch (error) { setNotice({ type: 'error', message: error.message }); }
    finally { setSaving(false); }
  };
  const verify = async () => {
    setSaving(true);
    try { finish(await verifySchedule(pending.values, pending.version), pending); }
    catch (error) { setNotice({ type: 'error', message: error.message }); }
    finally { setSaving(false); }
  };
  return <section className="evaluation-card">
    <div className="evaluation-icon"><ClockCircleOutlined /></div>
    <h2>Evaluación diaria</h2>
    <p>Procesa hasta 100 conversaciones nuevas y pendientes cada día, después de la carga de Atom.</p>
    {notice && <Alert {...notice} showIcon />}
    <Form form={form} layout="vertical" onFinish={save} initialValues={scheduleValues(data.settings)}
      onValuesChange={(_, values) => setDraft(scheduleValues(values))} disabled={!isAdmin || saving || !!pending}>
      <div className="schedule-toggle">
        <div><b>Programación diaria</b><span aria-live="polite">{pending ? 'Último estado confirmado' : 'Estado guardado'}: {saved.dailyEnabled ? `activa · ${saved.dailyTime} · ${saved.timezone.replace('America/', '').replaceAll('_', ' ')}` : 'inactiva'}</span>
          {(dirty || pending) && <Tag className="schedule-draft-tag">{pending ? 'Guardado por confirmar' : draft.dailyEnabled !== saved.dailyEnabled ? draft.dailyEnabled ? 'Activación sin guardar' : 'Desactivación sin guardar' : 'Horario sin guardar'}</Tag>}
        </div>
        <Form.Item name="dailyEnabled" valuePropName="checked" noStyle><Switch disabled={!ready || !isAdmin || saving || !!pending} aria-label="Activar evaluación diaria" /></Form.Item>
      </div>
      <div className="form-two-columns">
        <Form.Item name="dailyTime" label="Hora de inicio" rules={[{ required: true, pattern: /^([01]\d|2[0-3]):[0-5]\d$/, message: 'Selecciona una hora válida.' }]}><Input type="time" aria-label="Hora de evaluación diaria" /></Form.Item>
        <Form.Item name="timezone" label="Zona horaria" rules={[{ required: true }]}><Select aria-label="Zona horaria de evaluación" options={['America/Tegucigalpa', 'America/Mexico_City', 'America/Guatemala', 'America/Costa_Rica', 'UTC'].map(value => ({ value, label: value.replace('America/', '').replaceAll('_', ' ') }))} /></Form.Item>
      </div>
      <div className="schedule-hint"><ClockCircleOutlined /><span>Al activar, el histórico anterior queda fuera de la programación. Los lotes a demanda pueden evaluarlo.</span></div>
      <div className="evaluation-card-bottom">{isAdmin ? pending
        ? <Button block onClick={verify} loading={saving} disabled={false}>Comprobar estado guardado</Button>
        : <Button htmlType="submit" block loading={saving} disabled={!dirty || saving}>Guardar programación</Button>
        : <Tag className="neutral-tag">Solo un administrador puede cambiar el horario</Tag>}
        <p>{dirty || pending ? 'El interruptor y el horario se aplican al guardar y confirmar el cambio.' : 'Las nuevas evaluaciones utilizarán el checklist habilitado.'}</p>
      </div>
    </Form>
  </section>;
}
