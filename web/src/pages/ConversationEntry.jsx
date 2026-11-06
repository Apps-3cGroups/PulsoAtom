import { Navigate } from 'react-router-dom';
import { Button } from 'antd';
import { useApi, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { EmptyState, ErrorState, LoadingState, PageHeading } from '../components/common';

export default function ConversationEntry() {
  const { lastConversationId } = usePortal();
  const query = queryString({ preferredId: lastConversationId });
  const path = `/conversation-entry${query ? `?${query}` : ''}`;
  const request = useApi(path);

  if (request.error) return <ErrorState error={request.error} retry={request.reload} />;
  if (request.loading || request.dataPath !== path || !request.data) return <LoadingState />;
  if (request.data.conversationId) return <Navigate replace to={`/conversacion/${encodeURIComponent(request.data.conversationId)}`} />;

  return <div>
    <PageHeading eyebrow="REVISIÓN CON EVIDENCIA" title="Conversaciones" description="Consulta los mensajes y los resultados del checklist." />
    <EmptyState title="Todavía no hay conversaciones disponibles" description="Aparecerán aquí cuando se reciban los datos de Atom." action={<Button onClick={request.reload}>Actualizar</Button>} />
  </div>;
}
