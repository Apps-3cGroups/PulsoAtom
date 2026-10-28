import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { App as AntApp, Avatar, Button, ConfigProvider, Dropdown, Form, Input, Alert, theme as antTheme } from 'antd';
import esES from 'antd/locale/es_ES';
import { ArrowRightOutlined, LogoutOutlined, UserOutlined, DownOutlined, SafetyCertificateOutlined, EyeOutlined } from '@ant-design/icons';
import { api } from './services/api';
import { PortalContext, useApi } from './hooks';
import { Brand, ErrorState, LoadingState, dateText, setDisplayTimezone } from './components/common';
import PortalRoutes from './routes';

function Login({ meta, onLogin }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const enter = async (role, values) => {
    setBusy(role || 'login'); setError(null);
    try { const result = await api(role ? '/auth/demo' : '/auth/login', { method: 'POST', body: role ? { role } : values }); onLogin(result.user); }
    catch (error) { setError(error); } finally { setBusy(null); }
  };
  return <div className="login-page"><div className="login-brand"><Brand /><span className="eyebrow">CALIDAD DE ATENCIÓN</span></div><main className="login-grid"><section className="login-intro"><div className="eyebrow"><span className="status-dot" /> HISTÓRICO DE CONVERSACIONES</div><h1>Escucha lo que<br />cada conversación<br /><em>te está diciendo.</em></h1><p>Encuentra lo que requiere atención, revisa la evidencia y convierte cada interacción en una oportunidad de mejora.</p><div className="login-art" aria-hidden="true">{Array.from({ length: 7 }, (_, row) => <div key={row}>{Array.from({ length: 19 - row }, (_, column) => <i key={column} className={(row * 19 + column) % 13 === 0 ? 'red' : (row + column) % 17 === 0 ? 'purple' : ''} />)}</div>)}</div><div className="login-foot">Una conversación a la vez. Una visión de todo.</div></section><section className="login-card"><div className="eyebrow">BIENVENIDO A PULSO</div><h2>{meta.mode === 'demo' ? 'Explora el portal' : 'Inicia sesión'}</h2><p>{meta.mode === 'demo' ? 'Recorre las pantallas y prueba el checklist con conversaciones de ejemplo.' : 'Accede al histórico y a tus herramientas de revisión.'}</p>{error && <Alert type="error" showIcon message={error.message} />}{meta.mode === 'demo' ? <><div className="demo-label"><span />Modo de demostración</div><button className="role-card" disabled={!!busy} onClick={() => enter('admin')}><span className="role-icon"><SafetyCertificateOutlined /></span><span><b>Administrador</b><small>Catálogo, configuración y revisiones</small></span>{busy === 'admin' ? '…' : <ArrowRightOutlined />}</button><button className="role-card" disabled={!!busy} onClick={() => enter('supervisor')}><span className="role-icon"><EyeOutlined /></span><span><b>Supervisor</b><small>Conversaciones, evidencia y flags</small></span>{busy === 'supervisor' ? '…' : <ArrowRightOutlined />}</button><div className="login-note">Datos sintéticos. Las modificaciones se guardan únicamente en la demostración local.</div></> : <Form layout="vertical" onFinish={values => enter(null, values)}>{meta.authMode === 'somos3c' ? <Form.Item name="username" label="Usuario de Somos3C" rules={[{ required: true, message: 'Ingresa tu usuario.' }]}><Input autoComplete="username" maxLength={80} /></Form.Item> : meta.authMode === 'somos3c-email' ? <Form.Item name="username" label="Correo de Somos3C" rules={[{ required: true, type: 'email', message: 'Ingresa un correo válido.' }]}><Input autoComplete="username" maxLength={254} /></Form.Item> : <Form.Item name="email" label="Correo electrónico" rules={[{ required: true, type: 'email', message: 'Ingresa un correo válido.' }]}><Input autoComplete="username" /></Form.Item>}<Form.Item name="password" label="Contraseña" rules={[{ required: true, message: 'Ingresa tu contraseña.' }]}><Input.Password autoComplete="current-password" /></Form.Item><Button type="primary" htmlType="submit" size="large" block loading={!!busy}>Entrar a Pulso</Button></Form>}<div className="login-card-bottom">SUPERVISIÓN REGIONAL {meta.mode === 'demo' && <span>MX · GT · SV · HN · NI · CR</span>}</div></section></main><footer className="login-copyright">Pulso <span>Una mejor atención empieza por escuchar.</span></footer></div>;
}
function Portal({ user, onLogout }) {
  const bootstrapRequest = useApi('/bootstrap');
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = AntApp.useApp();
  const bootstrap = bootstrapRequest.data;
  setDisplayTimezone(bootstrap?.timezone);
  const logout = async () => { try { await api('/auth/logout', { method: 'POST', body: {} }); onLogout(); navigate('/'); } catch (error) { message.error(error.message); } };
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }, [location.pathname]);
  const links = [['/', 'Resumen'], ['/historico', 'Histórico'], ['/conversacion', 'Conversación'], ['/busqueda', 'Búsqueda'], ['/catalogo', 'Catálogo'], ['/evaluaciones', 'Evaluaciones'], ...(user.role === 'admin' && bootstrap?.mode === 'real' ? [['/accesos', 'Accesos']] : [])];
  return <div className={`app-shell ${location.pathname === '/' ? 'summary-shell' : ''}`}><header className="topbar"><NavLink to="/" aria-label="Pulso, ir al resumen"><Brand /></NavLink><nav aria-label="Navegación principal">{links.map(([path, label]) => <NavLink key={path} to={path} end={path === '/'}>{label}</NavLink>)}</nav><div className="topbar-right"><span className="historical-status"><span className="status-dot" /> Histórico</span><Dropdown menu={{ items: [{ key: 'role', label: user.role === 'admin' ? 'Administrador · Todos los países' : 'Supervisor · Todos los países', disabled: true }, { type: 'divider' }, { key: 'logout', label: 'Cerrar sesión', icon: <LogoutOutlined />, onClick: logout }] }} trigger={['click']}><Button type="text" className="user-button" aria-label="Menú de usuario"><Avatar size={27} icon={<UserOutlined />} /><span>{user.role === 'admin' ? 'Administrador' : 'Supervisor'}</span><DownOutlined /></Button></Dropdown></div></header>{bootstrap?.mode === 'demo' && <div className="demo-banner"><span className="demo-pill">DEMO</span><span>Conversaciones de ejemplo. Los cambios se guardan solo en esta demostración.</span><span className="demo-banner-date">Última carga: {dateText(bootstrap.metadata.lastLoadedAt)}</span></div>}<main className="workspace">{bootstrapRequest.error ? <ErrorState error={bootstrapRequest.error} retry={bootstrapRequest.reload} /> : !bootstrap ? <LoadingState /> : <PortalContext.Provider value={{ user, bootstrap, refreshBootstrap: bootstrapRequest.reload }}><PortalRoutes /></PortalContext.Provider>}</main><footer className="app-footer"><span>PULSO <span className="footer-divider">/</span> Supervisión regional</span><span>{bootstrap?.mode === 'demo' ? 'DEMO · ' : ''}Sin conexión en tiempo real <span className="footer-divider">·</span> {bootstrap?.timezone || 'America/Tegucigalpa'}</span></footer></div>;
}
export default function App() {
  const [user, setUser] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => { document.documentElement.dataset.theme = 'light'; }, []);
  useEffect(() => {
    let cancelled = false; setLoading(true); setError(null);
    Promise.all([api('/meta'), api('/auth/me').catch(error => { if (error.status === 401) return { user: null }; throw error; })]).then(([meta, session]) => { if (!cancelled) { setMeta(meta); setUser(session.user); } }).catch(error => { if (!cancelled) setError(error); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [retry]);
  useEffect(() => { const handler = () => setUser(null); window.addEventListener('pulso:unauthorized', handler); return () => window.removeEventListener('pulso:unauthorized', handler); }, []);
  return <ConfigProvider locale={esES} theme={{ algorithm: antTheme.defaultAlgorithm, token: { colorPrimary: '#167963', colorPrimaryHover: '#0d6653', colorPrimaryActive: '#095642', colorInfo: '#167963', colorBgBase: '#f3f5f1', colorTextBase: '#19251f', colorTextDisabled: '#5d7062', colorBgContainerDisabled: '#eef1ec', borderRadius: 8, fontFamily: '"Instrument Sans", "Avenir Next", "Segoe UI", sans-serif', fontSize: 13, controlHeight: 36 }, components: { Table: { headerBg: '#eaf0e9', rowHoverBg: '#eef4ed' }, Button: { primaryShadow: 'none' } } }}><AntApp>{loading ? <div className="boot-loading"><Brand /><LoadingState /></div> : error ? <div className="boot-loading"><Brand /><ErrorState error={error} retry={() => setRetry(n => n + 1)} /></div> : user ? <Portal user={user} onLogout={() => setUser(null)} /> : <Login meta={meta} onLogin={setUser} />}</AntApp></ConfigProvider>;
}
