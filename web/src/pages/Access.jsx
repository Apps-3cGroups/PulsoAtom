import { useState } from 'react';
import { Alert, App, Button, Form, Input, Popconfirm, Select, Table, Tag } from 'antd';
import { SearchOutlined, UserAddOutlined } from '@ant-design/icons';
import { api } from '../services/api';
import { useApi, usePortal } from '../hooks';
import { EmptyState, ErrorState, LoadingState, PageHeading, tableLoading } from '../components/common';

const roles = [{ value: 'supervisor', label: 'Supervisor' }, { value: 'admin', label: 'Administrador' }];

export default function Access() {
  const { user, bootstrap } = usePortal();
  const request = useApi('/access/grants');
  const [found, setFound] = useState(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);
  const [role, setRole] = useState('supervisor');
  const { message } = App.useApp();
  if (user.role !== 'admin' || bootstrap.mode !== 'real') return <ErrorState error={{ message: 'Esta sección requiere acceso administrativo en modo real.' }} />;
  if (request.loading && !request.data) return <LoadingState />;
  if (request.error) return <ErrorState error={request.error} retry={request.reload} />;
  const lookup = async ({ username }) => {
    setSearching(true); setError(null); setFound(null);
    try { const result = await api('/access/lookup', { method: 'POST', body: { username } }); setFound(result.user); setRole(request.data.items.find(item => item.externalId === result.user.id)?.role || 'supervisor'); }
    catch (caught) { setError(caught); } finally { setSearching(false); }
  };
  const grant = async () => {
    setSaving('new'); setError(null);
    try {
      await api('/access/grants', { method: 'POST', body: { externalId: found.id, role } });
      message.success('Acceso guardado.'); setFound(null); request.reload();
    } catch (caught) { setError(caught); } finally { setSaving(null); }
  };
  const update = async (item, changes) => {
    setSaving(item.id); setError(null);
    try { await api(`/access/grants/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: changes }); message.success('Acceso actualizado.'); request.reload(); }
    catch (caught) { setError(caught); } finally { setSaving(null); }
  };
  return <div>
    <PageHeading eyebrow="ADMINISTRACIÓN" title="Accesos a Pulso" description="Usa las credenciales de Somos3C y asigna aquí los permisos de Pulso." />
    {error && <Alert type="error" showIcon message={error.message} style={{ marginBottom: 16 }} />}
    <section className="evaluation-card access-create">
      <h2>Agregar acceso</h2>
      <p>Busca el correo exacto de Somos3C. Su contraseña no se guarda en Pulso.</p>
      <Form layout="inline" onFinish={lookup} className="access-lookup">
        <Form.Item name="username" rules={[{ required: true, type: 'email', message: 'Indica un correo válido.' }]}><Input placeholder="Correo de Somos3C" aria-label="Correo de Somos3C" maxLength={254} /></Form.Item>
        <Button htmlType="submit" icon={<SearchOutlined />} loading={searching}>Buscar</Button>
      </Form>
      {found && <div className="access-found"><div><b>{found.name}</b><span>{found.username} · {found.active ? 'Activo en Somos3C' : 'Inactivo en Somos3C'}</span>{found.changeRequired && <Tag color="orange">Debe cambiar su clave en Somos3C</Tag>}{found.blocked && <Tag color="red">Cuenta bloqueada en Somos3C</Tag>}</div><Select aria-label="Rol en Pulso" value={role} onChange={setRole} options={roles} style={{ width: 160 }} /><Button type="primary" icon={<UserAddOutlined />} loading={saving === 'new'} disabled={!found.active || found.blocked} onClick={grant}>{request.data.items.some(item => item.externalId === found.id) ? 'Actualizar acceso' : 'Dar acceso'}</Button></div>}
    </section>
    <section className="table-panel"><div className="table-panel-head"><h2>Usuarios con acceso</h2><span className="muted small">{request.data.items.length} registros</span></div>
      <Table loading={tableLoading(request.loading)} rowKey="id" dataSource={request.data.items} pagination={{ pageSize: 10 }} columns={[
        { title: 'Usuario', dataIndex: 'name' },
        { title: 'Rol', render: (_, item) => <Select aria-label={`Rol de ${item.name}`} value={item.role} options={roles} disabled={saving === item.id || item.id === user.id} onChange={value => update(item, { role: value })} style={{ width: 160 }} /> },
        { title: 'Estado', render: (_, item) => <Tag color={item.active ? 'green' : 'default'}>{item.active ? 'Activo' : 'Inactivo'}</Tag> },
        { title: 'Acceso', render: (_, item) => item.active ? <Popconfirm title="¿Inactivar este acceso?" description={`${item.name} dejará de entrar a Pulso.`} okText="Inactivar" cancelText="Cancelar" onConfirm={() => update(item, { active: false })}><Button size="small" danger disabled={item.id === user.id || saving === item.id}>Inactivar</Button></Popconfirm> : <Button size="small" disabled={saving === item.id} onClick={() => update(item, { active: true })}>Activar</Button> },
      ]} locale={{ emptyText: request.loading ? null : <EmptyState title="Sin accesos asignados" description="Busca un usuario de Somos3C para darle acceso a Pulso." /> }} />
    </section>
  </div>;
}
