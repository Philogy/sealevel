import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { encodeFunctionData } from 'viem'
import { sepoliaTokens, type SeaLevelToken } from './tokens'
import './styles.css'

const SEPOLIA_CHAIN_ID = '0xaa36a7'
const AQUA_ROUTER_ADDRESS = '0x0A1ff91C2f5e29B1f0910c96aE50F30F1C09EF82' as const
const SEA_LEVEL_APP_ADDRESS = '0x1fbA4c91c08FbbB1e8E6A0057cde2ee87B25822A' as const
const MAX_UINT256 = (1n << 256n) - 1n

const aquaAbi = [
  {
    type: 'function',
    name: 'ship',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'app', type: 'address' },
      { name: 'strategy', type: 'bytes' },
      { name: 'tokens', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    outputs: [{ name: 'strategyHash', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'dock',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'app', type: 'address' },
      { name: 'strategyHash', type: 'bytes32' },
      { name: 'tokens', type: 'address[]' },
    ],
    outputs: [],
  },
] as const

type Screen = 'home' | 'trader' | 'lp' | 'addLiquidity'
type TokenField = 'pay' | 'receive'

type RawMaker = {
  accepted_strategies: Record<string, string>
  tokens: Record<string, Record<string, string>>
}

type MakerResponse = {
  last_processed_block: number
  maker: RawMaker | null
}

type ActivePosition = {
  strategyHash: string
  feeBps: number
  group: SeaLevelToken['currency'] | 'Mixed'
  tokenAddresses: string[]
  tokens: Array<{ token: SeaLevelToken; virtualBalance: bigint }>
}

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

function allowanceCallData(owner: string, spender: string) {
  return `0xdd62ed3e${owner.slice(2).padStart(64, '0')}${spender.slice(2).padStart(64, '0')}`
}

function approveCallData(spender: string) {
  return `0x095ea7b3${spender.slice(2).padStart(64, '0')}${MAX_UINT256.toString(16)}`
}

async function waitForTransactionReceipt(provider: MetaMaskProvider, transactionHash: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const receipt = await provider.request<{ status?: string } | null>({
      method: 'eth_getTransactionReceipt',
      params: [transactionHash],
    })
    if (receipt) return receipt
    await new Promise((resolve) => window.setTimeout(resolve, 1_000))
  }

  throw new Error('Transaction confirmation timed out.')
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

function feePercentToBps(feePercent: string) {
  const [whole, fraction = ''] = feePercent.split('.')
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
}

function positionsFromMaker(maker: RawMaker): ActivePosition[] {
  const tokensByAddress = new Map(sepoliaTokens.map((token) => [token.address.toLowerCase(), token]))

  return Object.entries(maker.accepted_strategies).map(([strategyHash, strategy]) => {
    const tokenAddresses = Object.entries(maker.tokens).flatMap(([address, balances]) =>
      balances[strategyHash] !== undefined ? [address] : [])
    const tokens = tokenAddresses.flatMap((address) => {
      const token = tokensByAddress.get(address.toLowerCase())
      const rawBalance = maker.tokens[address][strategyHash]
      return token ? [{ token, virtualBalance: BigInt(rawBalance) }] : []
    })
    const currencies = new Set(tokens.map(({ token }) => token.currency))

    return {
      strategyHash,
      feeBps: Number(BigInt(strategy)),
      group: currencies.size === 1 ? tokens[0].token.currency : 'Mixed',
      tokenAddresses,
      tokens,
    }
  })
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
  const [providedAmounts, setProvidedAmounts] = useState<Record<string, string>>({})
  const [feePercent, setFeePercent] = useState('')
  const [isReviewingApprovals, setIsReviewingApprovals] = useState(false)
  const [allowances, setAllowances] = useState<Record<string, bigint>>({})
  const [approvingTokenAddress, setApprovingTokenAddress] = useState<string>()
  const [approvalError, setApprovalError] = useState<string>()
  const [isShippingLiquidity, setIsShippingLiquidity] = useState(false)
  const [shippingError, setShippingError] = useState<string>()
  const [shippingSucceeded, setShippingSucceeded] = useState(false)
  const [activePositions, setActivePositions] = useState<ActivePosition[]>([])
  const [positionAllowances, setPositionAllowances] = useState<Record<string, bigint>>({})
  const [positionAllowancesError, setPositionAllowancesError] = useState<string>()
  const [isLoadingPositions, setIsLoadingPositions] = useState(false)
  const [positionsError, setPositionsError] = useState<string>()
  const [dockConfirmation, setDockConfirmation] = useState<string>()
  const [dockingStrategyHash, setDockingStrategyHash] = useState<string>()
  const [dockError, setDockError] = useState<{ strategyHash: string; message: string }>()
  const [dockedStrategyHashes, setDockedStrategyHashes] = useState<string[]>([])
  const [positionsRefresh, setPositionsRefresh] = useState(0)
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
    setDockConfirmation(undefined)
    setDockingStrategyHash(undefined)
    setDockError(undefined)
    setDockedStrategyHashes([])
  }, [address])

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
    if (screen !== 'lp' || !provider?.isMetaMask || !address || !isOnSepolia) return

    const controller = new AbortController()
    let current = true
    const loadPositions = async () => {
      setIsLoadingPositions(true)
      setPositionsError(undefined)
      setPositionAllowances({})
      setPositionAllowancesError(undefined)
      let positions: ActivePosition[]
      try {
        const response = await fetch(`/api/makers/${address}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Maker request failed.')
        const payload = await response.json() as MakerResponse
        positions = payload.maker ? positionsFromMaker(payload.maker) : []
        setActivePositions(positions)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setPositionsError('Unable to load active liquidity: SeaLevel backend returned an error.')
        return
      }

      try {
        const tokens = [...new Map(positions
          .flatMap((position) => position.tokens.map(({ token }) => [token.address, token] as const)))
          .values()]
        const allowanceEntries = await Promise.all(tokens.map(async (token) => {
          const allowance = await provider.request<string>({
            method: 'eth_call',
            params: [{ to: token.address, data: allowanceCallData(address, AQUA_ROUTER_ADDRESS) }, 'latest'],
          })
          return [token.address, BigInt(allowance)] as const
        }))
        if (current) setPositionAllowances(Object.fromEntries(allowanceEntries))
      } catch (error) {
        if (current) setPositionAllowancesError('Unable to check token approvals.')
      } finally {
        if (!controller.signal.aborted) setIsLoadingPositions(false)
      }
    }

    void loadPositions()
    return () => {
      current = false
      controller.abort()
    }
  }, [address, isOnSepolia, positionsRefresh, screen])

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

  const invalidateApprovalReview = () => {
    setIsReviewingApprovals(false)
    setAllowances({})
    setApprovalError(undefined)
    setShippingError(undefined)
    setShippingSucceeded(false)
  }

  const selectLiquidityCurrency = (currency: SeaLevelToken['currency']) => {
    setLiquidityCurrency(currency)
    setProvidedTokens([])
    setAcceptedTokenAddresses([])
    setProvidedAmounts({})
    invalidateApprovalReview()
  }

  const toggleProvidedToken = (token: SeaLevelToken) => {
    invalidateApprovalReview()
    const isProvided = providedTokens.some((providedToken) => providedToken.address === token.address)
    setProvidedTokens((tokens) => isProvided
      ? tokens.filter((providedToken) => providedToken.address !== token.address)
      : [...tokens, token])
    if (isProvided) {
      setProvidedAmounts((amounts) => {
        const { [token.address]: _, ...remainingAmounts } = amounts
        return remainingAmounts
      })
    }
    if (!isProvided) {
      setAcceptedTokenAddresses((addresses) => addresses.includes(token.address) ? addresses : [...addresses, token.address])
    }
  }

  const toggleAcceptedToken = (token: SeaLevelToken) => {
    invalidateApprovalReview()
    const isProvided = providedTokens.some((providedToken) => providedToken.address === token.address)
    if (isProvided) return

    setAcceptedTokenAddresses((addresses) => addresses.includes(token.address)
      ? addresses.filter((address) => address !== token.address)
      : [...addresses, token.address])
  }

  const loadAllowances = async () => {
    const provider = window.ethereum
    if (!provider?.isMetaMask || !address || !isOnSepolia) return

    const tokenAllowances = await Promise.all(providedTokens.map(async (token) => {
      const result = await provider.request<string>({
        method: 'eth_call',
        params: [{ to: token.address, data: allowanceCallData(address, AQUA_ROUTER_ADDRESS) }, 'latest'],
      })
      return [token.address, BigInt(result)] as const
    }))
    setAllowances(Object.fromEntries(tokenAllowances))
  }

  const openApprovalReview = async () => {
    if (!address) {
      await connectWallet()
      return
    }
    if (!isOnSepolia) {
      await switchToSepolia()
      return
    }

    setApprovalError(undefined)
    setIsReviewingApprovals(true)
    try {
      await loadAllowances()
    } catch {
      setApprovalError('Unable to read token approvals from MetaMask.')
    }
  }

  const approveToken = async (token: SeaLevelToken) => {
    const provider = window.ethereum
    if (!provider?.isMetaMask || !address || !isOnSepolia) return

    setApprovingTokenAddress(token.address)
    setApprovalError(undefined)
    try {
      const transactionHash = await provider.request<string>({
        method: 'eth_sendTransaction',
        params: [{
          from: address,
          to: token.address,
          data: approveCallData(AQUA_ROUTER_ADDRESS),
        }],
      })
      const receipt = await waitForTransactionReceipt(provider, transactionHash)
      if (receipt.status !== '0x1') throw new Error('Approval transaction failed.')
      await loadAllowances()
    } catch {
      setApprovalError(`Unable to approve ${token.symbol}.`)
    } finally {
      setApprovingTokenAddress(undefined)
    }
  }

  const hasProvidedAmounts = providedTokens.length > 0 && providedTokens.every((token) => {
    const amount = parseTokenAmount(providedAmounts[token.address] ?? '', token.decimals)
    return amount !== undefined && amount > 0n
  })
  const activeLiquidityTokens = liquidityTokens.filter((token) => acceptedTokenAddresses.includes(token.address))
  const allProvidedTokensApproved = isReviewingApprovals && providedTokens.every((token) => (allowances[token.address] ?? 0n) > 0n)
  const visibleActivePositions = activePositions.filter((position) => !dockedStrategyHashes.includes(position.strategyHash))

  const shipLiquidity = async () => {
    const provider = window.ethereum
    if (!provider?.isMetaMask || !address || !isOnSepolia || !allProvidedTokensApproved) return

    const amounts = activeLiquidityTokens.map((token) => {
      const amount = parseTokenAmount(providedAmounts[token.address] ?? '', token.decimals)
      return amount ?? 0n
    })
    const strategy = `0x${feePercentToBps(feePercent).toString(16).padStart(64, '0')}` as `0x${string}`
    const data = encodeFunctionData({
      abi: aquaAbi,
      functionName: 'ship',
      args: [SEA_LEVEL_APP_ADDRESS, strategy, activeLiquidityTokens.map((token) => token.address), amounts],
    })

    setIsShippingLiquidity(true)
    setShippingError(undefined)
    try {
      const transactionHash = await provider.request<string>({
        method: 'eth_sendTransaction',
        params: [{ from: address, to: AQUA_ROUTER_ADDRESS, data }],
      })
      const receipt = await waitForTransactionReceipt(provider, transactionHash)
      if (receipt.status !== '0x1') throw new Error('Ship transaction failed.')
      setShippingSucceeded(true)
    } catch {
      setShippingError('Unable to ship liquidity.')
    } finally {
      setIsShippingLiquidity(false)
    }
  }

  const dockLiquidity = async (position: ActivePosition) => {
    const provider = window.ethereum
    if (!provider?.isMetaMask || !address || !isOnSepolia || position.tokenAddresses.length === 0) return

    const data = encodeFunctionData({
      abi: aquaAbi,
      functionName: 'dock',
      args: [
        SEA_LEVEL_APP_ADDRESS,
        position.strategyHash as `0x${string}`,
        position.tokenAddresses as `0x${string}`[],
      ],
    })

    setDockingStrategyHash(position.strategyHash)
    setDockError(undefined)
    try {
      const transactionHash = await provider.request<string>({
        method: 'eth_sendTransaction',
        params: [{ from: address, to: AQUA_ROUTER_ADDRESS, data }],
      })
      const receipt = await waitForTransactionReceipt(provider, transactionHash)
      if (receipt.status !== '0x1') throw new Error('Dock transaction failed.')
      setDockedStrategyHashes((hashes) => [...hashes, position.strategyHash])
      setDockConfirmation(undefined)
      setPositionsRefresh((refresh) => refresh + 1)
    } catch {
      setDockError({ strategyHash: position.strategyHash, message: 'Unable to dock liquidity.' })
    } finally {
      setDockingStrategyHash(undefined)
    }
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
            {visibleActivePositions.length > 0 && (
              <button className="add-liquidity-button" type="button" onClick={() => navigate('addLiquidity')}>
                Add Liquidity
              </button>
            )}
          </div>
          {isLoadingPositions ? (
            <div className="empty-liquidity">
              <div className="empty-liquidity-mark" aria-hidden="true" />
              <p>Loading active liquidity</p>
            </div>
          ) : positionsError ? (
            <div className="empty-liquidity">
              <div className="empty-liquidity-mark" aria-hidden="true" />
              <p>{positionsError}</p>
            </div>
          ) : visibleActivePositions.length === 0 ? (
            <div className="empty-liquidity">
              <div className="empty-liquidity-mark" aria-hidden="true" />
              <p>No active liquidity</p>
              <button type="button" onClick={() => navigate('addLiquidity')}>Add your first position</button>
            </div>
          ) : (
            <div className="positions-list">
              {visibleActivePositions.map((position) => {
                const providedTokens = position.tokens.filter(({ token }) => (positionAllowances[token.address] ?? 0n) > 0n)
                const acceptedTokens = position.tokens.filter(({ token }) => (positionAllowances[token.address] ?? 0n) === 0n)
                const isConfirmingDock = dockConfirmation === position.strategyHash
                const isDocking = dockingStrategyHash === position.strategyHash

                return (
                  <article className="position-card" key={position.strategyHash}>
                    <div className="position-card-heading">
                      <div>
                        <h2>{position.group} liquidity</h2>
                        <span>Fee {formatTokenAmount(BigInt(position.feeBps), 2)}%</span>
                      </div>
                      {isConfirmingDock ? (
                        <div className="dock-confirmation">
                          {!isDocking && (
                            <button
                              className="dock-cancel-button"
                              type="button"
                              onClick={() => setDockConfirmation(undefined)}
                            >
                              Cancel
                            </button>
                          )}
                          <button
                            className="dock-confirm-button"
                            type="button"
                            onClick={() => void dockLiquidity(position)}
                            disabled={isDocking}
                          >
                            {isDocking ? 'Docking...' : 'Confirm dock'}
                          </button>
                        </div>
                      ) : (
                        <div className="position-card-action">
                          <span className="position-status">Active</span>
                          <button
                            className="dock-liquidity-button"
                            type="button"
                            onClick={() => setDockConfirmation(position.strategyHash)}
                            disabled={position.tokenAddresses.length === 0}
                          >
                            Dock
                          </button>
                        </div>
                      )}
                    </div>
                    {positionAllowancesError ? (
                      <p className="position-role-error" role="status">{positionAllowancesError}</p>
                    ) : (
                      <div className="position-token-list">
                        <section className="position-token-group" aria-label="Provided tokens">
                          <h3>Provided tokens</h3>
                          {providedTokens.map(({ token, virtualBalance }) => (
                            <div className="position-token-row" key={token.address}>
                              <img className="token-icon" src={token.logo} alt="" />
                              <span>{token.symbol}</span>
                              <strong>{formatTokenAmount(virtualBalance, token.decimals)}</strong>
                            </div>
                          ))}
                        </section>
                        {acceptedTokens.length > 0 && (
                          <section className="position-token-group" aria-label="Accepted tokens">
                            <h3>Accepted tokens</h3>
                            {acceptedTokens.map(({ token, virtualBalance }) => (
                              <div className="position-token-row" key={token.address}>
                                <img className="token-icon" src={token.logo} alt="" />
                                <span>{token.symbol}</span>
                                <strong>{formatTokenAmount(virtualBalance, token.decimals)}</strong>
                              </div>
                            ))}
                          </section>
                        )}
                      </div>
                    )}
                    {dockError?.strategyHash === position.strategyHash && (
                      <p className="position-role-error" role="status">{dockError.message}</p>
                    )}
                  </article>
                )
              })}
            </div>
          )}
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
                      if (/^\d*(\.\d{0,2})?$/.test(nextValue)) {
                        setFeePercent(nextValue)
                        invalidateApprovalReview()
                      }
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
                      {isProvided && (
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="0.00"
                          aria-label={`${token.symbol} liquidity amount`}
                          value={providedAmounts[token.address] ?? ''}
                          onChange={(event) => {
                            setProvidedAmounts((amounts) => ({
                              ...amounts,
                              [token.address]: event.target.value,
                            }))
                            invalidateApprovalReview()
                          }}
                        />
                      )}
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

            <button
              className="review-liquidity-button"
              type="button"
              onClick={() => void openApprovalReview()}
              disabled={!hasProvidedAmounts || !hasValidFee}
            >
              Review approvals
            </button>
            {isReviewingApprovals && (
              <section className="approval-review" aria-labelledby="approval-review-title">
                <div className="approval-review-heading">
                  <h2 id="approval-review-title">Approval review</h2>
                </div>
                {providedTokens.map((token) => {
                  const allowance = allowances[token.address]
                  const isApproved = allowance !== undefined && allowance > 0n
                  const isApproving = approvingTokenAddress === token.address
                  return (
                    <div className="approval-token-row" key={token.address}>
                      <img className="token-icon" src={token.logo} alt="" />
                      <span>{token.symbol}</span>
                      <small>{isApproved ? 'Approved for Aqua' : 'Approval required'}</small>
                      <button
                        type="button"
                        onClick={() => void approveToken(token)}
                        disabled={isApproved || isApproving}
                      >
                        {isApproved ? 'Approved' : isApproving ? 'Approving...' : 'Approve'}
                      </button>
                    </div>
                  )
                })}
                {approvalError && <p className="approval-error" role="status">{approvalError}</p>}
                {allProvidedTokensApproved && !shippingSucceeded && (
                  <button className="ship-liquidity-button" type="button" onClick={() => void shipLiquidity()} disabled={isShippingLiquidity}>
                    {isShippingLiquidity ? 'Shipping liquidity...' : 'Ship liquidity'}
                  </button>
                )}
                {shippingError && <p className="approval-error" role="status">{shippingError}</p>}
                {shippingSucceeded && (
                  <div className="shipping-success" role="status">
                    <span>Liquidity shipped</span>
                    <button type="button" onClick={() => navigate('lp')}>View active liquidity</button>
                  </div>
                )}
              </section>
            )}
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
