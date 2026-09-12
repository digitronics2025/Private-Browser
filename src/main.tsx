import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installLocalBridgePreview } from './preview-bridge';
import './styles.css';
import { installPreviewApi } from './preview-api';

installPreviewApi();

installLocalBridgePreview();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
