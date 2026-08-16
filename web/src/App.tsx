import { useEffect, useState } from 'react';
import { Landing } from './Landing';
import { AppView } from './AppView';

/**
 * Hash routing rather than a router dependency. Two surfaces, one boundary —
 * react-router would be several hundred kilobytes to express a boolean.
 */
function currentRoute() {
  return window.location.hash === '#/app' ? 'app' : 'landing';
}

export function App() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

  if (route === 'app') {
    return <AppView onBack={() => { window.location.hash = ''; }} />;
  }
  return <Landing onLaunch={() => { window.location.hash = '#/app'; }} />;
}
