import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const SEPOLIA_CHAIN_ID = '0xaa36a7'

type MetaMaskProvider = {
  isMetaMask?: boolean
  request: <Result>(args: { method: string; params?: unknown[] }) => Promise<Result>
  on: (event: 'accountsChanged' | 'chainChanged', listener: (value: unknown) => void) => void
  removeListener: (event: 'accountsChanged' | 'chainChanged', listener: (value: unknown) => void) => void
}

declare global {
  interface Window {
    ethereum?: MetaMaskProvider
  }
}

function formatAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function App() {
  const [address, setAddress] = useState<string>()
  const [chainId, setChainId] = useState<string>()
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string>()
  const [isWalletMenuOpen, setIsWalletMenuOpen] = useState(false)
  const walletControlRef = useRef<HTMLDivElement>(null)
  const isOnSepolia = chainId?.toLowerCase() === SEPOLIA_CHAIN_ID

  useEffect(() => {
    const provider = window.ethereum
    if (!provider?.isMetaMask) return

    const syncWallet = async () => {
      try {
        const [accounts, currentChainId] = await Promise.all([
          provider.request<string[]>({ method: 'eth_accounts' }),
          provider.request<string>({ method: 'eth_chainId' }),
        ])

        setAddress(accounts[0])
        setChainId(currentChainId)
      } catch {
        setConnectionError('Unable to read your MetaMask connection.')
      }
    }

    const handleAccountsChanged = (accounts: unknown) => {
      setAddress(Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : undefined)
    }
    const handleChainChanged = (nextChainId: unknown) => {
      setChainId(typeof nextChainId === 'string' ? nextChainId : undefined)
    }

    provider.on('accountsChanged', handleAccountsChanged)
    provider.on('chainChanged', handleChainChanged)
    void syncWallet()

    return () => {
      provider.removeListener('accountsChanged', handleAccountsChanged)
      provider.removeListener('chainChanged', handleChainChanged)
    }
  }, [])

  useEffect(() => {
    if (!isWalletMenuOpen) return

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!walletControlRef.current?.contains(event.target as Node)) {
        setIsWalletMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsWalletMenuOpen(false)
    }

    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isWalletMenuOpen])

  const switchToSepolia = async () => {
    const provider = window.ethereum
    if (!provider?.isMetaMask) return

    setIsConnecting(true)
    setConnectionError(undefined)

    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: SEPOLIA_CHAIN_ID }],
      })
      setChainId(await provider.request<string>({ method: 'eth_chainId' }))
    } catch {
      setConnectionError('Switch to the Sepolia test network in MetaMask to continue.')
    } finally {
      setIsConnecting(false)
    }
  }

  const connectWallet = async () => {
    const provider = window.ethereum
    if (!provider?.isMetaMask) {
      setConnectionError('Install the MetaMask browser extension to connect.')
      return
    }

    setIsConnecting(true)
    setConnectionError(undefined)

    try {
      const accounts = await provider.request<string[]>({ method: 'eth_requestAccounts' })
      const currentChainId = await provider.request<string>({ method: 'eth_chainId' })
      setAddress(accounts[0])
      setChainId(currentChainId)

      if (currentChainId.toLowerCase() !== SEPOLIA_CHAIN_ID) {
        await switchToSepolia()
      }
    } catch {
      setConnectionError('MetaMask connection was cancelled or unavailable.')
    } finally {
      setIsConnecting(false)
    }
  }

  const handleWalletButtonClick = () => {
    if (address && isOnSepolia) {
      setIsWalletMenuOpen((isOpen) => !isOpen)
      return
    }

    if (address && !isOnSepolia) {
      void switchToSepolia()
      return
    }

    if (!address) void connectWallet()
  }

  const disconnectWallet = async () => {
    const provider = window.ethereum
    if (!provider?.isMetaMask) return

    setIsConnecting(true)
    setConnectionError(undefined)

    try {
      await provider.request({
        method: 'wallet_revokePermissions',
        params: [{ eth_accounts: {} }],
      })
      setAddress(undefined)
      setChainId(undefined)
      setIsWalletMenuOpen(false)
    } catch {
      setConnectionError('MetaMask did not disconnect this site. Try again from the extension.')
    } finally {
      setIsConnecting(false)
    }
  }

  const walletLabel = isConnecting
    ? 'Connecting...'
    : address
      ? isOnSepolia
        ? `Sepolia · ${formatAddress(address)}`
        : 'Switch to Sepolia'
      : 'Connect MetaMask'

  return (
    <main className="site-shell">
      <nav className="topbar" aria-label="Primary navigation">
        <a className="wordmark" href="/" aria-label="SeaLevel home">
          SEA<span>LEVEL</span>
        </a>
        <div className="wallet-control" ref={walletControlRef}>
          <button
            className={`wallet-button${address ? ' wallet-connected' : ''}${address && !isOnSepolia ? ' wallet-wrong-network' : ''}`}
            type="button"
            onClick={handleWalletButtonClick}
            disabled={isConnecting}
            aria-expanded={address && isOnSepolia ? isWalletMenuOpen : undefined}
            aria-haspopup={address && isOnSepolia ? 'menu' : undefined}
          >
            {address && <span className="connection-dot" />}
            {walletLabel}
          </button>
          {address && isOnSepolia && isWalletMenuOpen && (
            <div className="wallet-menu" role="menu">
              <div className="wallet-menu-account">
                <span>Connected account</span>
                <code>{address}</code>
              </div>
              <div className="wallet-menu-network">
                <span className="connection-dot" />
                Sepolia
              </div>
              <button className="wallet-menu-disconnect" type="button" role="menuitem" onClick={() => void disconnectWallet()}>
                Disconnect
              </button>
            </div>
          )}
          {connectionError && <p className="wallet-error" role="status">{connectionError}</p>}
        </div>
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
