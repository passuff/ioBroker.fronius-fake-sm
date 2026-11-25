import React from 'react';
import { createRoot } from 'react-dom/client';

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(
        <React.StrictMode>
            <div>fronius-fake-sm admin (build target only)</div>
        </React.StrictMode>,
    );
}
