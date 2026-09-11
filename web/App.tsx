import { Routes, Route, NavLink } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import OverviewPage from './pages/OverviewPage';
import NodesPage from './pages/NodesPage';
import GraphPage from './pages/GraphPage';

export default function App() {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b px-6 py-3">
        <span className="text-lg font-bold">NanoKG</span>
        <nav className="flex gap-2">
          {[
            { to: '/', label: '总览' },
            { to: '/nodes', label: '节点管理' },
          ].map((l) => (
            <Button key={l.to} asChild variant="ghost">
              <NavLink to={l.to} className={({ isActive }) => (isActive ? 'font-semibold' : '')}>
                {l.label}
              </NavLink>
            </Button>
          ))}
        </nav>
      </header>
      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/nodes" element={<NodesPage />} />
          <Route path="/graph/:nodeId" element={<GraphPage />} />
        </Routes>
      </main>
    </div>
  );
}
