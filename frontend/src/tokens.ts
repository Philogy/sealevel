export type SeaLevelToken = {
  address: `0x${string}`
  symbol: string
  name: string
  logo: string
  decimals: number
  currency: 'USD' | 'EUR'
}

export const sepoliaTokens: SeaLevelToken[] = [
  {
    address: '0x51C716e283E2844105BafBC75Ce828AfE533D2D0',
    symbol: 'USDC',
    name: 'USD Coin',
    logo: 'https://coin-images.coingecko.com/coins/images/6319/small/USDC.png?1769615602',
    decimals: 6,
    currency: 'USD',
  },
  {
    address: '0xE13cEc2872Ee61dB91C0b61cca2A14d211d080F8',
    symbol: 'USDT',
    name: 'Tether USD',
    logo: 'https://coin-images.coingecko.com/coins/images/325/small/Tether.png?1696501661',
    decimals: 6,
    currency: 'USD',
  },
  {
    address: '0xFAfC6437beF175baa51728465E62E0fa8b2f9940',
    symbol: 'USDS',
    name: 'USDS Stablecoin',
    logo: 'https://coin-images.coingecko.com/coins/images/39926/small/usds.webp?1726666683',
    decimals: 18,
    currency: 'USD',
  },
  {
    address: '0x308a8149F500990c8F8646AEFa779E7CEF3042a0',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    logo: 'https://coin-images.coingecko.com/coins/images/9956/small/Badge_Dai.png?1696509996',
    decimals: 18,
    currency: 'USD',
  },
  {
    address: '0xE96250B9d576AAFd37ca2e3BAfD25ebf2dC02f43',
    symbol: 'EURC',
    name: 'EURC',
    logo: 'https://cdn.prod.website-files.com/67116d0daddc92483c812e88/67116d0daddc92483c813390_Coin-3.avif',
    decimals: 6,
    currency: 'EUR',
  },
  {
    address: '0x1926Dc0bBBEae374d051C68Ab127730662764B05',
    symbol: 'EURe',
    name: 'Monerium EURe',
    logo: 'https://monerium.com/eure/assets/iban/eur.svg',
    decimals: 18,
    currency: 'EUR',
  },
]
