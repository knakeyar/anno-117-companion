import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useLiveTelemetry } from './api'
import { AppShell } from './components/AppShell'
import { LoadingState } from './components/Common'

const CommandCenterPage = lazy(() => import('./pages/CommandCenter').then((module) => ({ default: module.CommandCenterPage })))
const TradePage = lazy(() => import('./pages/Trade').then((module) => ({ default: module.TradePage })))
const ProductionPage = lazy(() => import('./pages/Production').then((module) => ({ default: module.ProductionPage })))
const AreasPage = lazy(() => import('./pages/Areas').then((module) => ({ default: module.AreasPage })))
const AreaDetailPage = lazy(() => import('./pages/Areas').then((module) => ({ default: module.AreaDetailPage })))
const SettingsPage = lazy(() => import('./pages/Settings').then((module) => ({ default: module.SettingsPage })))

export function App() {
  useLiveTelemetry()
  return (
    <AppShell>
      <Suspense fallback={<LoadingState />}>
        <Routes>
          <Route path="/" element={<CommandCenterPage />} />
          <Route path="/trade" element={<TradePage />} />
          <Route path="/production" element={<ProductionPage />} />
          <Route path="/areas" element={<AreasPage />} />
          <Route path="/areas/:areaPk" element={<AreaDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  )
}
