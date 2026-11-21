import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installLocalBridgePreview } from './preview-bridge';
import './styles.css';
import './agent-styles.css';
import { installPreviewApi } from './preview-api';
import { AgentWorkspaceView } from './panels/AgentsPanel';

installPreviewApi();

installLocalBridgePreview();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {window.location.hash === '#agent-workspace' ? <AgentWorkspaceView /> : <App />}
  </React.StrictMode>,
);
