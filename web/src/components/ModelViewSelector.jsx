import { Button, Select, Tooltip } from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '../hooks';

export function useEvaluationView() {
  const [params] = useSearchParams();
  const modelProfileId = params.get('modelProfileId') || undefined;
  return { modelProfileId, modelQuery: modelProfileId ? `modelProfileId=${encodeURIComponent(modelProfileId)}` : '',
    withView: path => modelProfileId ? `${path}${path.includes('?') ? '&' : '?'}modelProfileId=${encodeURIComponent(modelProfileId)}` : path };
}
export default function ModelViewSelector({ compare = true }) {
  const request = useApi('/models');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const model = params.get('modelProfileId');
  return <div className="model-view-selector"><span className="control-label">VISTA</span>{request.error && <Tooltip title={request.error.message}><Button size="small" danger onClick={request.reload}>Reintentar modelos</Button></Tooltip>}<Tooltip title={model ? 'Respuestas originales de IA. Consultar no vuelve a ejecutar el modelo.' : 'Evaluación oficial con dictámenes humanos.'}>
    <Select aria-label="Vista de evaluaciones" value={model || 'operational'} loading={request.loading}
      onChange={value => { const next = new URLSearchParams(params); if (value === 'operational') next.delete('modelProfileId'); else next.set('modelProfileId', value); next.delete('page'); setParams(next); }}
      options={[{ value: 'operational', label: 'Operativa' }, { label: 'Resultados originales de IA', options: (request.data?.profiles || []).map(p => ({ value: p.viewId || p.id, label: `${p.label}${p.model ? ` · ${p.model}` : ''}` })) }]} />
  </Tooltip>{compare && <Button icon={<SwapOutlined />} onClick={() => navigate('/comparacion')}>Comparar</Button>}</div>;
}
