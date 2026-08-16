import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

vi.mock('echarts-for-react/lib/core', () => ({ default: () => null }))

class MockEventSource {
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
  close = vi.fn()
}

Object.defineProperty(globalThis, 'EventSource', { value: MockEventSource, writable: true })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class {
  observe() {}
  unobserve() {}
  disconnect() {}
}, writable: true })
Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { configurable: true, value: 900 },
  offsetHeight: { configurable: true, value: 500 },
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})
