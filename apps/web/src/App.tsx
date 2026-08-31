import { lazy, Suspense } from 'react';
import LandingPage from './LandingPage';

const OverviewPage = lazy(() => import('./Overview'));

function App() {
  const path = window.location.pathname.replace(/\/+$/u, '');
  if (path === '/overview') {
    return (
      <Suspense fallback={<div className="overview-route-loading" role="status">Opening your runs…</div>}>
        <OverviewPage />
      </Suspense>
    );
  }
  return <LandingPage />;
}

export default App;
