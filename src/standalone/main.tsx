/**
 * Standalone entry point: mount the SPA into the static shell in
 * `public/index.html`. The host serves `public/` at `<mount>/ui/`, so all
 * asset references in the shell are relative.
 */
import { createRoot } from 'react-dom/client'
import { App } from './app.tsx'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Missing #root element in public/index.html')
}

createRoot(container).render(<App />)
