import React from 'react';
import { createRoot } from 'react-dom/client';
import DemoShell from './demo/DemoShell.jsx';

const root = createRoot(document.getElementById('root'));
root.render(<DemoShell mode="webgpu" />);
