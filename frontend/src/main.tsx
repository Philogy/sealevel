import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

function App() {
  return (
    <main className="site-shell">
      <nav className="topbar" aria-label="Primary navigation">
        <a className="wordmark" href="/" aria-label="SeaLevel home">
          SEA<span>LEVEL</span>
        </a>
        <button className="wallet-button" type="button">
          Connect Wallet
        </button>
      </nav>

      <section className="hero" aria-labelledby="hero-title">
        <p className="eyebrow">Built on 1inch Aqua <span>·</span> Powered by Plank</p>
        <h1 id="hero-title">STABLECOIN SWAPS &amp; LIQUIDITY.</h1>

        <div className="actions">
          <button className="action action-primary" type="button">
            Trader Dashboard
          </button>
          <button className="action action-secondary" type="button">
            LP Dashboard
          </button>
        </div>
      </section>

      <div className="sea-level" aria-hidden="true">
        <div className="level-label">SEA LEVEL</div>
        <svg className="level-wave" viewBox="0 0 1440 48" preserveAspectRatio="none">
          <path d="M0 27C105 11 202 12 310 26s207 15 319 0 204-14 312 1 203 15 311 0 192-14 288-4" />
          <circle className="level-orb" cx="980" cy="32" r="4" />
        </svg>
      </div>

      <div className="depth depth-one" aria-hidden="true" />
      <div className="depth depth-two" aria-hidden="true" />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
