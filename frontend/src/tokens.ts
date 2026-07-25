export type SeaLevelToken = {
  address: `0x${string}`
  symbol: string
  name: string
  decimals: number
  currency: 'USD' | 'EUR'
}

export const sepoliaTokens: SeaLevelToken[] = [
  {
    address: '0x308a8149F500990c8F8646AEFa779E7CEF3042a0',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    currency: 'USD',
  },
  {
    address: '0x51C716e283E2844105BafBC75Ce828AfE533D2D0',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    currency: 'USD',
  },
  {
    address: '0xE13cEc2872Ee61dB91C0b61cca2A14d211d080F8',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    currency: 'USD',
  },
  {
    address: '0xFAfC6437beF175baa51728465E62E0fa8b2f9940',
    symbol: 'USDS',
    name: 'USDS Stablecoin',
    decimals: 18,
    currency: 'USD',
  },
  {
    address: '0xE96250B9d576AAFd37ca2e3BAfD25ebf2dC02f43',
    symbol: 'EURC',
    name: 'EURC',
    decimals: 6,
    currency: 'EUR',
  },
  {
    address: '0x1926Dc0bBBEae374d051C68Ab127730662764B05',
    symbol: 'EURe',
    name: 'Monerium EURe',
    decimals: 18,
    currency: 'EUR',
  },
]
