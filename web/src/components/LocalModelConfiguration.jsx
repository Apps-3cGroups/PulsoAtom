import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Form, Select, Switch, Tag } from 'antd';
import { CloudServerOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { useApi } from '../hooks';
import { createGatewayDiscovery } from '../services/gatewayDiscovery';
import { editableLocalProfiles, localProfileIds, onlyDisablingLocalProfiles, saveLocalConfiguration } from '../services/localModels';
import { ErrorState, LoadingState } from './common';

export default function LocalModelConfiguration({ demo, isAdmin, running, onSaved }) {
  const request = useApi(demo ? null : '/models/local-configuration');
  return <section className="local-configuration-panel" aria-labelledby="local-models-title">
    <div className="local-configuration-heading"><div><span className="eyebrow">CONFIGURACIÓN DEL MOTOR</span><h2 id="local-models-title"><CloudServerOutlined /> Modelos locales</h2><p>Configura Clef y Gemma y elige los modelos publicados por tu Gateway.</p></div><Tag>{demo ? 'Demostración' : 'Solo administración'}</Tag></div>
    {demo ? <Alert type="info" showIcon message="El Gateway real no se consulta en la demostración" description="Puedes probar la política y las muestras sintéticas más abajo. La configuración de Clef y Gemma está disponible en el entorno real." />
      : request.error ? <ErrorState error={request.error} retry={request.reload} />
        : !request.data ? <LoadingState />
          : <ConfigurationForm key={request.data.version} data={request.data} isAdmin={isAdmin} running={running} onReload={request.reload} onSaved={() => { request.reload(); onSaved(); }} />}
  </section>;
}

function ConfigurationForm({ data, isAdmin, running, onReload, onSaved }) {
  const profiles = localProfileIds.map(id => data.profiles.find(profile => profile.id === id));
  const initialProfiles = editableLocalProfiles(data.profiles).map(profile => ({ ...profile, toolKey: profile.toolKey || undefined, model: profile.model || undefined }));
  const [form] = Form.useForm();
  const draft = Form.useWatch('profiles', form) || editableLocalProfiles(data.profiles);
  const [catalog, setCatalog] = useState({ tools: null, toolsStatus: 'idle', toolsError: null, models: {} });
  const discovery = useMemo(() => createGatewayDiscovery({ onChange: setCatalog }), []);
  const { tools, toolsError: discoveryError } = catalog;
  const discovering = catalog.toolsStatus === 'loading';
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false), [saved, setSaved] = useState(false);
  const { message } = App.useApp();
  const canDiscover = isAdmin && data.gatewayConfigured && !running;
  const selectedTools = JSON.stringify(draft.map(profile => profile.toolKey || ''));
  useEffect(() => {
    if (!canDiscover) return;
    discovery.start();
    void discovery.refresh();
    return () => discovery.stop();
  }, [canDiscover, discovery]);
  useEffect(() => { discovery.select(JSON.parse(selectedTools)); }, [discovery, selectedTools]);
  const needsReload = ['VERSION_CONFLICT', 'LOCAL_SAVE_UNCONFIRMED'].includes(error?.code);
  const onlyDisabling = onlyDisablingLocalProfiles(editableLocalProfiles(data.profiles), editableLocalProfiles(draft));
  const submit = async values => {
    if (busy || running || saved || needsReload) return;
    setBusy(true); setError(null);
    try {
      const result = await saveLocalConfiguration(editableLocalProfiles(values.profiles), data.version);
      setSaved(true); setDirty(false);
      message.success(result.policyReady ? 'Configuración guardada. Clef y Gemma listos para la prueba a demanda; programación diaria pausada.' : 'Configuración guardada. La evaluación y la programación diaria permanecen pausadas hasta habilitar ambos modelos.');
      onSaved();
    } catch (caught) { setError(caught); }
    finally { setBusy(false); }
  };
  const locked = !isAdmin || busy || saved || running || needsReload;
  return <>
    <div className="gateway-discovery-bar"><div><Tag color={tools ? 'green' : 'default'}>{discovering ? 'Consultando catálogo' : tools ? 'Catálogo consultado' : 'Catálogo por consultar'}</Tag><span>{data.gatewayConfigured ? 'Las herramientas y sus modelos se cargan automáticamente. Puedes actualizar el catálogo cuando lo necesites.' : 'Falta configurar la conexión al Gateway en el servidor.'}</span></div><Button icon={<ReloadOutlined />} onClick={() => discovery.refresh()} loading={discovering} disabled={locked || !data.gatewayConfigured}>Consultar Gateway</Button></div>
    {!data.gatewayConfigured && <Alert type="warning" showIcon message="Falta configurar el Gateway" description="DevOps debe completar la conexión y credencial en el backend. No se solicitan claves en esta pantalla." />}
    {discoveryError && <Alert type="error" showIcon message="No pudimos consultar el Gateway" description={discoveryError.message} />}
    {discovering && <LoadingState />}
    {tools?.length === 0 && <Alert type="info" showIcon message="El Gateway no publicó herramientas disponibles" />}
    {error && <Alert type="error" showIcon message={error.code === 'VERSION_CONFLICT' ? 'La configuración cambió en otra sesión' : 'No se pudo confirmar la configuración'} description={error.message} action={needsReload && <Button onClick={onReload}>Recargar configuración</Button>} />}
    {running && <Alert type="info" showIcon message="Hay una evaluación en curso" description="La configuración se podrá cambiar cuando termine la ejecución." />}
    <Form form={form} layout="vertical" initialValues={{ profiles: initialProfiles }} onFinish={submit} onValuesChange={() => { setDirty(true); if (!needsReload) setError(null); }} disabled={locked}>
      <div className="local-profile-list">{profiles.map((profile, index) => {
        const value = draft[index] || profile;
        const label = profile.id === 'clef-local' ? 'Clef' : 'Gemma';
        const choices = tools?.map(tool => ({ value: tool.key, label: `${tool.key}${tool.status === 'active' ? '' : ' · No activa'}`, disabled: tool.status !== 'active' })) || [];
        if (value.toolKey && !choices.some(choice => choice.value === value.toolKey)) choices.push({ value: value.toolKey, label: `${value.toolKey} · Guardada`, disabled: true });
        const modelRequest = catalog.models[value.toolKey];
        const loadingModels = modelRequest?.status === 'loading';
        const modelError = modelRequest?.error;
        const availableModels = modelRequest?.status === 'ready' ? modelRequest.items : null;
        const modelOptions = (availableModels || []).map(model => ({ value: model, label: model }));
        if (value.model && !modelOptions.some(option => option.value === value.model)) modelOptions.push({ value: value.model, label: `${value.model} · Guardado`, disabled: true });
        return <article className="local-profile-editor" key={profile.id} aria-label={`Configuración de ${label}`}>
          <div className="local-profile-heading"><div><h3>{label}</h3><Tag color={profile.enabled ? 'green' : 'default'}>{profile.enabled ? 'Habilitado' : 'Inactivo'} · guardado</Tag></div><Form.Item name={['profiles', index, 'enabled']} valuePropName="checked"><Switch aria-label={`Habilitar ${label}`} checkedChildren="Habilitado" unCheckedChildren="Inactivo" /></Form.Item></div>
          <Form.Item name={['profiles', index, 'id']} hidden><input /></Form.Item>
          <div className="local-profile-fields">
            <Form.Item name={['profiles', index, 'toolKey']} label={`Herramienta de ${label}`} rules={[{ required: true, message: 'Consulta el Gateway y selecciona una herramienta.' }]}><Select aria-label={`Herramienta de ${label}`} placeholder={discovering ? 'Cargando herramientas…' : 'Selecciona una herramienta'} options={choices} disabled={locked || !tools || discovering} onChange={() => { form.setFieldValue(['profiles', index, 'model'], undefined); }} /></Form.Item>
            <div><Form.Item name={['profiles', index, 'model']} label={`Modelo de ${label}`} rules={[{ required: true, message: 'Selecciona un modelo publicado por esta herramienta.' }]}><Select aria-label={`Modelo de ${label}`} showSearch optionFilterProp="label" placeholder={!value.toolKey ? 'Selecciona primero una herramienta' : discovering || loadingModels ? 'Cargando modelos…' : modelError ? 'No se pudo cargar la lista' : availableModels?.length === 0 ? 'Sin modelos publicados' : 'Selecciona un modelo publicado'} options={modelOptions} loading={loadingModels || (discovering && !!value.toolKey)} disabled={locked || !canDiscover || !availableModels?.length || discovering || loadingModels} /></Form.Item>{!value.toolKey && <span className="small muted">Selecciona primero una herramienta para ver sus modelos.</span>}</div>
            <Form.Item name={['profiles', index, 'responseFormat']} label="Formato de respuesta" rules={[{ required: true }]}><Select aria-label={`Formato de respuesta de ${label}`} options={[{ value: 'json_schema', label: 'JSON Schema · estructura estricta' }, { value: 'json_object', label: 'JSON · estructura validada por Pulso' }]} /></Form.Item>
          </div>
          {loadingModels && <LoadingState />}
          {modelError && <Alert type="error" showIcon message={`No pudimos consultar los modelos de ${label}`} description={modelError.message} action={<Button onClick={() => discovery.retry(value.toolKey)} disabled={locked || !canDiscover}>Reintentar modelos de {label}</Button>} />}
          {availableModels?.length === 0 && <Alert type="info" showIcon message="Esta herramienta no publicó modelos" description="Actualiza la lista o selecciona otra herramienta." action={<Button onClick={() => discovery.retry(value.toolKey)} disabled={locked || !canDiscover}>Actualizar modelos de {label}</Button>} />}
        </article>;
      })}</div>
      <div className="local-config-save"><div><strong>{dirty ? 'Cambios sin guardar' : data.policyReady ? 'Configuración guardada' : 'Completa la configuración para comenzar'}</strong><p>Guardar establece Clef y Gemma como doble revisión y pausa la programación diaria para la prueba inicial. No ejecuta evaluaciones.</p></div><div><Button onClick={() => { form.resetFields(); setDirty(false); setError(null); }} disabled={locked || !dirty || needsReload}>Descartar cambios</Button><Button type="primary" icon={<SaveOutlined />} htmlType="submit" loading={busy} disabled={locked || needsReload || (!data.gatewayConfigured && !onlyDisabling) || (!dirty && data.policyReady)}>Guardar modelos locales</Button></div></div>
    </Form>
  </>;
}
