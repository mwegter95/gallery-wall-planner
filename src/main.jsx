import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { hydrateTokenFromParent } from './utils/embedAuth.js'
import { TOKEN_KEY } from './utils/api.js'

/* Recover the login token from the first-party parent shell if Safari evicted
 * this iframe's third-party storage — keeps the user signed in for the token's
 * full 7-day life instead of getting logged out every day or two. */
hydrateTokenFromParent(TOKEN_KEY)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
