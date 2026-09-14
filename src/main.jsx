import { MistBuildBanner } from "./components/MistBuildBanner.jsx";
import { render } from 'preact';
import { App } from './App.jsx';
import 'katex/dist/katex.min.css';
import '@tik-choco/mistai/ui.css';
import './index.css';
import { writeAppManifest } from './services/appManifest.js';
import { BUS_VERSION } from './services/sharedBus.js';

// Register PWA service worker
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
    import('virtual:pwa-register').then(({ registerSW }) => {
        registerSW({ immediate: true });
    });
}

render(<div class="mist-app-frame"><MistBuildBanner /><div class="mist-app-content"><App /></div></div>, document.getElementById('app'));

writeAppManifest({
    app: 'tc-pdf-viewer',
    busVersion: BUS_VERSION,
    publishes: ['ocr-markdown-index', 'folder-export'],
    consumes: ['pdf-viewer-inbox'],
    reads: [],
});
