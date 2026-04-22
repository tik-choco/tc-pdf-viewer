import { render } from 'preact';
import { App } from './App.jsx';
import 'katex/dist/katex.min.css';
import './index.css';

// Register PWA service worker
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
    import('virtual:pwa-register').then(({ registerSW }) => {
        registerSW({ immediate: true });
    });
}

render(<App />, document.getElementById('app'));
