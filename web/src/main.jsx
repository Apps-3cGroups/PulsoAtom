import React from 'react';
import ReactDOM from 'react-dom/client';
import '@ant-design/v5-patch-for-react-19';
import { BrowserRouter } from 'react-router-dom';
import 'antd/dist/reset.css';
import App from './App';
import './styles.css';
import { basePath } from './config';

ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter basename={basePath}><App /></BrowserRouter></React.StrictMode>);
