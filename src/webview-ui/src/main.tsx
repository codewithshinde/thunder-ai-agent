/// <reference types="vite/client" />

import { createRoot } from 'react-dom/client';
import { AGENT_FULL_NAME } from '../../shared/brand';
import { App } from './App';
import './styles/global.css';

document.title = AGENT_FULL_NAME;

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
