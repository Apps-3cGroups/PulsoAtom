import { lazy, Suspense } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { Button } from 'antd';
import { LoadingState } from './components/common';

const Summary = lazy(() => import('./pages/Summary'));
const Conversations = lazy(() => import('./pages/Conversations'));
const Conversation = lazy(() => import('./pages/Conversation'));
const Catalog = lazy(() => import('./pages/Catalog'));
const Evaluations = lazy(() => import('./pages/Evaluations'));
const Comparison = lazy(() => import('./pages/Comparison'));
const Validation = lazy(() => import('./pages/Validation'));
const Access = lazy(() => import('./pages/Access'));

export default function PortalRoutes() {
  const navigate = useNavigate();
  return <Suspense fallback={<LoadingState />}>
    <Routes>
      <Route path="/" element={<Summary />} />
      <Route path="/historico" element={<Conversations />} />
      <Route path="/busqueda" element={<Conversations search />} />
      <Route path="/conversacion" element={<Conversation />} />
      <Route path="/conversacion/:id" element={<Conversation />} />
      <Route path="/comparacion" element={<Comparison />} />
      <Route path="/comparacion/:sampleId/validar/:conversationId" element={<Validation />} />
      <Route path="/catalogo" element={<Catalog />} />
      <Route path="/evaluaciones" element={<Evaluations />} />
      <Route path="/accesos" element={<Access />} />
      <Route path="*" element={<div className="not-found">
        <h1>Esta página no existe</h1>
        <p>Vuelve al resumen para continuar.</p>
        <Button type="primary" onClick={() => navigate('/')}>Ir al resumen</Button>
      </div>} />
    </Routes>
  </Suspense>;
}
