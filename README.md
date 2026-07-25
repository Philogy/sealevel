# SeaLevel - Earn Stablecoin Yield Without Leaving Your Wallet

The premise of _SeaLevel_ is that most users don't really care about the
difference between major stablecoins denominating the same fiat currency.
For example to most users 1 USDC is fungible with USDT, USDS or DAI.

SeaLevel builds on [1inch Aqua](https://github.com/1inch/aqua) to allow users to
provide the stablecoins in their wallets for others to trade against.

## Core Contracts
For contracts we have:

- [`SeaLevel.plk`](./contracts/src/SeaLevel.plk) - The main Aqua app that
  interfaces between Aqua and traders
- [`aqua.plk`](./contracts/src/aqua.plk) - A thin library that allows
  `SeaLevel.plk` to talk to the main Aqua contract via the Solidity ABI
 
They are written in [Plank](https://plankevm.org) our new smart contract
language for the EVM. You may notice some parts are quite low-level as the
language is in development.

For this hackathon we used a custom fork of our compiler and standard library to
fill in the gaps of some basic features our compiler was missing. To reproduce
(prerequisites are Rust's `cargo` toolchain and `just`):

```bash
git clone git@github.com:plankevm/plank-monorepo.git
cd plank-monorepo && git checkout feat/methods
cd plankc && just link-dev-local # Builds the compiler and sets up a local installation
# Add `~/.plank/bin` to $PATH
cd sealevel/contracts # Go back to the sealevel/contracts sub-directory
just build # Build the SeaLevel contracts using the `plank` compiler
```
