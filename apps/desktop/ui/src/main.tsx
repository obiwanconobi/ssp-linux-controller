import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/kit.css';
import './styles/ampSkins.css';
import './styles/app.css';

const showFatal = (message: string) => {
  const root = document.getElementById('root');
  if (!root) return;
  const pre = document.createElement('pre');
  pre.style.cssText =
    'position:fixed;inset:0;z-index:9999;margin:0;padding:24px;background:#12110f;color:#d56757;font:12px/1.5 monospace;white-space:pre-wrap;overflow:auto';
  pre.textContent = `StompStation failed to start\n\n${message}`;
  root.replaceChildren(pre);
};

window.addEventListener('error', (event) => {
  showFatal(`${event.message}\n${event.error?.stack ?? ''}`);
});
window.addEventListener('unhandledrejection', (event) => {
  showFatal(`Unhandled rejection: ${String(event.reason)}\n${event.reason?.stack ?? ''}`);
});

try {
  document.getElementById('boot')?.remove();

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (error) {
  showFatal(error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
}
