import { useEffect, useRef } from 'preact/hooks';
import { mountMistlibDiagnostics } from '../vendor/mistlibDiagnostics.ts';
import { mistDiagnostics } from '../lib/mistBuildInfo';
// Framework adapter only. Rendering and state live in the common module.
export function MistBuildBanner({ view = 'banner' }) {
  const host = useRef(null);
  useEffect(() => {
    if (host.current) return mountMistlibDiagnostics(host.current, mistDiagnostics, view);
  }, [view]);
  return <div ref={host} />;
}
