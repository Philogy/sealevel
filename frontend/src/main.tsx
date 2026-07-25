import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { sepoliaTokens, type SeaLevelToken } from './tokens'
import './styles.css'

const SEPOLIA_CHAIN_ID = '0xaa36a7'

type Screen = 'home' | 'trader' | 'lp' | 'addLiquidity'
type TokenField = 'pay' | 'receive'

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

function formatTokenAmount(amount: bigint, decimals: number) {
  const divisor = 10n ** BigInt(decimals)
  const whole = amount / divisor
  const fraction = amount % divisor
  const wholeText = whole.toLocaleString('en-US')

  if (fraction === 0n) return wholeText

  const fractionText = fraction
    .toString()
    .padStart(decimals, '0')
    .slice(0, 6)
    .replace(/0+$/, '')
  return `${wholeText}.${fractionText}`
}

function balanceOfCallData(account: string) {
  return `0x70a08231${account.slice(2).padStart(64, '0')}`
}

function parseTokenAmount(input: string, decimals: number) {
  if (!/^\d*(\.\d*)?$/.test(input) || input === '' || input === '.') return

  const [whole = '0', fraction = ''] = input.split('.')
  if (fraction.length > decimals) return

  const divisor = 10n ** BigInt(decimals)
  const wholeAmount = BigInt(whole || '0') * divisor
  const fractionAmount = BigInt((fraction || '0').padEnd(decimals, '0'))
  return wholeAmount + fractionAmount
}

function quoteAtNinetyNinePercent(amount: bigint, inputDecimals: number, outputDecimals: number) {
  const normalizedAmount = inputDecimals >= outputDecimals
    ? amount / 10n ** BigInt(inputDecimals - outputDecimals)
    : amount * 10n ** BigInt(outputDecimals - inputDecimals)
  return normalizedAmount * 99n / 100n
}

function screenFromPath(pathname: string): Screen {
  if (pathname === '/trader') return 'trader'
  if (pathname === '/lp/add') return 'addLiquidity'
  if (pathname === '/lp') return 'lp'
  return 'home'
}

function pathForScreen(screen: Screen) {
  if (screen === 'trader') return '/trader'
  if (screen === 'addLiquidity') return '/lp/add'
  if (screen === 'lp') return '/lp'
  return '/'
}

function App() {
  const [screen, setScreen] = useState<Screen>(() => screenFromPath(window.location.pathname))
  const [address, setAddress] = useState<string>()
  const [chainId, setChainId] = useState<string>()
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string>()
  const [isWalletMenuOpen, setIsWalletMenuOpen] = useState(false)
  const [payToken, setPayToken] = useState<SeaLevelToken>()
  const [receiveToken, setReceiveToken] = useState<SeaLevelToken>()
  const [payAmount, setPayAmount] = useState('')
  const [payBalance, setPayBalance] = useState<bigint>()
  const [quoteAmount, setQuoteAmount] = useState<bigint>()
  const [liquidityCurrency, setLiquidityCurrency] = useState<SeaLevelToken['currency']>('USD')
  const [providedTokens, setProvidedTokens] = useState<SeaLevelToken[]>([])
  const [acceptedTokenAddresses, setAcceptedTokenAddresses] = useState<string[]>([])
  const [feePercent, setFeePercent] = useState('')
  const [activeTokenMenu, setActiveTokenMenu] = useState<TokenField>()
  const walletControlRef = useRef<HTMLDivElement>(null)
  const tokenMenuRef = useRef<HTMLDivElement>(null)
  const isOnSepolia = chainId?.toLowerCase() === SEPOLIA_CHAIN_ID

  const navigate = (nextScreen: Screen) => {
    const nextPath = pathForScreen(nextScreen)
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, '', nextPath)
    }
    setScreen(nextScreen)
  }

  useEffect(() => {
    const handlePopState = () => setScreen(screenFromPath(window.location.pathname))
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

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

  useEffect(() => {
    if (!activeTokenMenu) return

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!tokenMenuRef.current?.contains(event.target as Node)) {
        setActiveTokenMenu(undefined)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveTokenMenu(undefined)
    }

    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [activeTokenMenu])

  useEffect(() => {
    const provider = window.ethereum
    if (!provider?.isMetaMask || !address || !isOnSepolia || !payToken) {
      setPayBalance(undefined)
      return
    }

    let current = true
    const loadBalance = async () => {
      try {
        const result = await provider.request<string>({
          method: 'eth_call',
          params: [{ to: payToken.address, data: balanceOfCallData(address) }, 'latest'],
        })
        if (current) setPayBalance(BigInt(result))
      } catch {
        if (current) setPayBalance(undefined)
      }
    }

    void loadBalance()
    return () => {
      current = false
    }
  }, [address, isOnSepolia, payToken])

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
  const selectedToken = activeTokenMenu === 'pay' ? payToken : receiveToken
  const otherToken = activeTokenMenu === 'pay' ? receiveToken : payToken
  const availableTokens = otherToken
    ? sepoliaTokens.filter((token) => token.currency === otherToken.currency && token.address !== otherToken.address)
    : sepoliaTokens

  const selectToken = (field: TokenField, token: SeaLevelToken) => {
    if (field === 'pay') {
      setPayToken(token)
      setPayAmount('')
    } else {
      setReceiveToken(token)
    }
    setQuoteAmount(undefined)
    setActiveTokenMenu(undefined)
  }

  const switchTokens = () => {
    if (!payToken || !receiveToken) return
    setPayToken(receiveToken)
    setReceiveToken(payToken)
    setPayAmount('')
    setQuoteAmount(undefined)
  }

  const requestQuote = () => {
    if (!payToken || !receiveToken) return

    const inputAmount = parseTokenAmount(payAmount, payToken.decimals)
    if (!inputAmount || inputAmount <= 0n) return

    setQuoteAmount(quoteAtNinetyNinePercent(inputAmount, payToken.decimals, receiveToken.decimals))
  }

  const parsedPayAmount = payToken ? parseTokenAmount(payAmount, payToken.decimals) : undefined
  const canRequestQuote = Boolean(payToken && receiveToken && parsedPayAmount && parsedPayAmount > 0n)
  const liquidityTokens = sepoliaTokens.filter((token) => token.currency === liquidityCurrency)
  const hasValidFee = /^\d+(\.\d{1,2})?$/.test(feePercent) && Number(feePercent) <= 655.35

  const selectLiquidityCurrency = (currency: SeaLevelToken['currency']) => {
    setLiquidityCurrency(currency)
    setProvidedTokens([])
    setAcceptedTokenAddresses([])
  }

  const toggleProvidedToken = (token: SeaLevelToken) => {
    const isProvided = providedTokens.some((providedToken) => providedToken.address === token.address)
    setProvidedTokens((tokens) => isProvided
      ? tokens.filter((providedToken) => providedToken.address !== token.address)
      : [...tokens, token])
    if (!isProvided) {
      setAcceptedTokenAddresses((addresses) => addresses.includes(token.address) ? addresses : [...addresses, token.address])
    }
  }

  const toggleAcceptedToken = (token: SeaLevelToken) => {
    const isProvided = providedTokens.some((providedToken) => providedToken.address === token.address)
    if (isProvided) return

    setAcceptedTokenAddresses((addresses) => addresses.includes(token.address)
      ? addresses.filter((address) => address !== token.address)
      : [...addresses, token.address])
  }

  return (
    <main className="site-shell">
      <nav className={`topbar${screen !== 'home' ? ' topbar-dashboard' : ''}`} aria-label="Primary navigation">
        <a
          className="wordmark"
          href="/"
          aria-label="SeaLevel home"
          onClick={(event) => {
            event.preventDefault()
            navigate('home')
          }}
        >
          SEA<span>LEVEL</span>
        </a>
        {screen !== 'home' && (
          <div className="dashboard-tabs" aria-label="Dashboard navigation">
            <button
              className={`dashboard-tab${screen === 'trader' ? ' dashboard-tab-active' : ''}`}
              type="button"
              onClick={() => navigate('trader')}
              aria-current={screen === 'trader' ? 'page' : undefined}
            >
              Trader Dashboard
            </button>
            <button
              className={`dashboard-tab${screen === 'lp' || screen === 'addLiquidity' ? ' dashboard-tab-active' : ''}`}
              type="button"
              onClick={() => navigate('lp')}
              aria-current={screen === 'lp' || screen === 'addLiquidity' ? 'page' : undefined}
            >
              LP Dashboard
            </button>
          </div>
        )}
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

      {screen === 'home' ? (
        <section className="hero" aria-labelledby="hero-title">
          <p className="eyebrow">Built on 1inch Aqua <span>·</span> Powered by Plank</p>
          <h1 id="hero-title">STABLECOIN SWAPS &amp; LIQUIDITY.</h1>

          <div className="actions">
            <button className="action action-primary" type="button" onClick={() => navigate('trader')}>
              Trader Dashboard
            </button>
            <button className="action action-secondary" type="button" onClick={() => navigate('lp')}>
              LP Dashboard
            </button>
          </div>
        </section>
      ) : screen === 'trader' ? (
        <section className="trader-dashboard" aria-label="Trader dashboard">
          <div className="trader-workspace">
            <section className="swap-panel" aria-label="Swap request">
              <div className="swap-field">
                <span>You pay</span>
                <div className="swap-field-row">
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    placeholder="0.00"
                    aria-label="Amount to pay"
                    value={payAmount}
                    onChange={(event) => {
                      setPayAmount(event.target.value)
                      setQuoteAmount(undefined)
                    }}
                  />
                  <div className="token-selector" ref={activeTokenMenu === 'pay' ? tokenMenuRef : undefined}>
                    <button
                      className="token-button"
                      type="button"
                      onClick={() => setActiveTokenMenu((field) => field === 'pay' ? undefined : 'pay')}
                      aria-expanded={activeTokenMenu === 'pay'}
                      aria-haspopup="listbox"
                    >
                      {payToken ? (
                        <>
                          <img className="token-icon" src={payToken.logo} alt="" />
                          {payToken.symbol}
                        </>
                      ) : 'Select token'}
                    </button>
                    {activeTokenMenu === 'pay' && (
                      <div className="token-menu" role="listbox" aria-label="Select token to pay">
                        {availableTokens.map((token) => (
                          <button
                            className="token-option"
                            key={token.address}
                            type="button"
                            role="option"
                            aria-selected={selectedToken?.address === token.address}
                            onClick={() => selectToken('pay', token)}
                          >
                            <img className="token-icon" src={token.logo} alt="" />
                            <span className="token-option-symbol">{token.symbol}</span>
                            <span className="token-option-name">{token.name}</span>
                            <span className="token-option-currency">{token.currency}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {payToken && payBalance !== undefined && (
                  <div className="balance-row">
                    <span>Balance: {formatTokenAmount(payBalance, payToken.decimals)} {payToken.symbol}</span>
                  </div>
                )}
              </div>

              <button className="switch-tokens" type="button" aria-label="Switch selected tokens" onClick={switchTokens}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 2v11M4 9l4 4 4-4" />
                </svg>
              </button>

              <div className="swap-field">
                <span>You receive</span>
                <div className="swap-field-row">
                  <output className={`quote-output${quoteAmount !== undefined ? ' quote-output-filled' : ''}`} aria-label="Quoted amount to receive">
                    {quoteAmount !== undefined && receiveToken ? formatTokenAmount(quoteAmount, receiveToken.decimals) : ''}
                  </output>
                  <div className="token-selector" ref={activeTokenMenu === 'receive' ? tokenMenuRef : undefined}>
                    <button
                      className="token-button"
                      type="button"
                      onClick={() => setActiveTokenMenu((field) => field === 'receive' ? undefined : 'receive')}
                      aria-expanded={activeTokenMenu === 'receive'}
                      aria-haspopup="listbox"
                    >
                      {receiveToken ? (
                        <>
                          <img className="token-icon" src={receiveToken.logo} alt="" />
                          {receiveToken.symbol}
                        </>
                      ) : 'Select token'}
                    </button>
                    {activeTokenMenu === 'receive' && (
                      <div className="token-menu" role="listbox" aria-label="Select token to receive">
                        {availableTokens.map((token) => (
                          <button
                            className="token-option"
                            key={token.address}
                            type="button"
                            role="option"
                            aria-selected={selectedToken?.address === token.address}
                            onClick={() => selectToken('receive', token)}
                          >
                            <img className="token-icon" src={token.logo} alt="" />
                            <span className="token-option-symbol">{token.symbol}</span>
                            <span className="token-option-name">{token.name}</span>
                            <span className="token-option-currency">{token.currency}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <button
                className={`quote-button${quoteAmount !== undefined ? ' swap-button' : ''}`}
                type="button"
                onClick={quoteAmount === undefined ? requestQuote : undefined}
                disabled={!canRequestQuote}
              >
                {quoteAmount === undefined ? 'Get quote' : 'Swap'}
              </button>
            </section>
          </div>
        </section>
      ) : screen === 'lp' ? (
        <section className="lp-dashboard" aria-labelledby="liquidity-title">
          <div className="lp-page-header">
            <h1 id="liquidity-title">Active Liquidity</h1>
          </div>
          <div className="empty-liquidity">
            <div className="empty-liquidity-mark" aria-hidden="true" />
            <p>No active liquidity</p>
            <button type="button" onClick={() => navigate('addLiquidity')}>Add your first position</button>
          </div>
        </section>
      ) : (
        <section className="add-liquidity" aria-labelledby="add-liquidity-title">
          <div className="lp-page-header">
            <h1 id="add-liquidity-title">Add Liquidity</h1>
          </div>
          <div className="liquidity-form">
            <section className="liquidity-group" aria-labelledby="liquidity-group-title">
              <span id="liquidity-group-title">Liquidity group</span>
              <div className="liquidity-group-options">
                {(['USD', 'EUR'] as const).map((currency) => (
                  <button
                    className={`liquidity-group-button${liquidityCurrency === currency ? ' liquidity-group-button-active' : ''}`}
                    type="button"
                    key={currency}
                    onClick={() => selectLiquidityCurrency(currency)}
                    aria-pressed={liquidityCurrency === currency}
                  >
                    {currency}
                  </button>
                ))}
              </div>
            </section>

            <section className="liquidity-fee">
              <label>
                <span>Trading fee</span>
                <div>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="Enter fee"
                    aria-label="Trading fee as a percentage"
                    value={feePercent}
                    onChange={(event) => {
                      const nextValue = event.target.value
                      if (/^\d*(\.\d{0,2})?$/.test(nextValue)) setFeePercent(nextValue)
                    }}
                  />
                  <span>%</span>
                </div>
              </label>
            </section>

            <div className="liquidity-lists">
              <section className="liquidity-list" aria-labelledby="provide-title">
                <div className="liquidity-list-heading">
                  <h2 id="provide-title">Tokens you provide</h2>
                  <span>Token approval required</span>
                </div>
                {liquidityTokens.map((token) => {
                  const isProvided = providedTokens.some((providedToken) => providedToken.address === token.address)
                  return (
                    <div className={`liquidity-token-row${isProvided ? ' liquidity-token-row-active' : ''}`} key={token.address}>
                      <button type="button" onClick={() => toggleProvidedToken(token)} aria-pressed={isProvided}>
                        <img className="token-icon" src={token.logo} alt="" />
                        <span>{token.symbol}</span>
                        <small>{token.name}</small>
                      </button>
                      {isProvided && <input type="text" inputMode="decimal" placeholder="0.00" aria-label={`${token.symbol} liquidity amount`} />}
                    </div>
                  )
                })}
              </section>

              <section className="liquidity-list" aria-labelledby="accept-title">
                <div className="liquidity-list-heading">
                  <h2 id="accept-title">Tokens you accept</h2>
                  <span>No token approval required</span>
                </div>
                {liquidityTokens.map((token) => {
                  const isProvided = providedTokens.some((providedToken) => providedToken.address === token.address)
                  const isAccepted = acceptedTokenAddresses.includes(token.address)
                  return (
                    <button
                      className={`accept-token-row${isAccepted ? ' accept-token-row-active' : ''}`}
                      type="button"
                      key={token.address}
                      onClick={() => toggleAcceptedToken(token)}
                      aria-pressed={isAccepted}
                      disabled={isProvided}
                    >
                      <span className="accept-indicator" aria-hidden="true" />
                      <img className="token-icon" src={token.logo} alt="" />
                      <span>{token.symbol}</span>
                      {isProvided && <small>Included with liquidity</small>}
                    </button>
                  )
                })}
              </section>
            </div>

            <button className="review-liquidity-button" type="button" disabled={providedTokens.length === 0 || !hasValidFee}>
              Review approvals
            </button>
          </div>
        </section>
      )}

      {screen === 'home' && (
        <div className="sea-level" aria-hidden="true">
          <div className="level-label">SEA LEVEL</div>
          <svg className="level-wave" viewBox="0 0 1440 48" preserveAspectRatio="none">
            <path d="M0 27C105 11 202 12 310 26s207 15 319 0 204-14 312 1 203 15 311 0 192-14 288-4" />
            <circle className="level-orb" cx="980" cy="32" r="4" />
          </svg>
        </div>
      )}

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
