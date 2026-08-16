import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

class MockEventSource {
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
  close = vi.fn()
}

Object.defineProperty(globalThis, 'EventSource', { value: MockEventSource, writable: true })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

