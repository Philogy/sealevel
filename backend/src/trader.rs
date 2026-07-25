use crate::LiquidityBook;
use alloy_primitives::{Address, Bytes, U256};
use alloy_provider::{DynProvider, Provider, ProviderBuilder};
use alloy_rpc_types_eth::{TransactionInput, TransactionRequest};
use alloy_signer::Signer;
use alloy_signer_local::PrivateKeySigner;
use alloy_sol_types::{SolCall, sol};
use anyhow::{Context, Result, bail};
use log::{info, warn};
use rand::{Rng, seq::IndexedRandom};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::watch;
use url::Url;

const BPS_BASE: u64 = 10_000;
const MAX_RANDOM_TRADE: u64 = 100;

sol! {
    function decimals() external view returns (uint8);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function swap(
        bytes strategy,
        uint256 tokenInIndex,
        uint256 tokenOutIndex,
        address maker,
        uint256 amountIn
    ) external;
}

pub struct Trader {
    provider: DynProvider,
    bot_address: Address,
    app_address: Address,
    trade_interval: Duration,
    liquidity_book: watch::Receiver<Arc<LiquidityBook>>,
    token_decimals: HashMap<Address, u8>,
}

impl Trader {
    pub fn new(
        rpc_url: Url,
        signer: PrivateKeySigner,
        chain_id: u64,
        app_address: Address,
        trade_interval: Duration,
        liquidity_book: watch::Receiver<Arc<LiquidityBook>>,
    ) -> Self {
        let signer = signer.with_chain_id(Some(chain_id));
        let bot_address = signer.address();
        let provider = ProviderBuilder::new()
            .wallet(signer)
            .connect_http(rpc_url)
            .erased();

        Self {
            provider,
            bot_address,
            app_address,
            trade_interval,
            liquidity_book,
            token_decimals: HashMap::new(),
        }
    }

    pub async fn run(mut self) -> Result<()> {
        let first_trade = tokio::time::Instant::now() + self.trade_interval;
        let mut ticker = tokio::time::interval_at(first_trade, self.trade_interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            if let Err(error) = self.trade_once().await {
                warn!("random trade failed: {error:#}");
            }
        }
    }

    async fn trade_once(&mut self) -> Result<()> {
        let selected_trade = {
            let liquidity_book = self.liquidity_book.borrow();
            select_trade(&liquidity_book)
        };
        let Some(mut trade) = selected_trade else {
            info!("random trade skipped: no eligible indexed LPs");
            return Ok(());
        };

        let input_decimals = self.decimals(trade.token_in).await?;
        let output_decimals = self.decimals(trade.token_out).await?;
        let Some((amount_in, amount_out)) = capped_amounts(
            trade.whole_token_amount,
            input_decimals,
            output_decimals,
            trade.fee_bps,
            trade.output_balance,
        ) else {
            info!(
                "random trade skipped: selected LP has insufficient output balance (maker={}, token={})",
                trade.maker, trade.token_out
            );
            return Ok(());
        };
        trade.amount_in = amount_in;

        self.ensure_allowance(trade.token_in, amount_in).await?;

        let call = swapCall {
            strategy: trade.strategy,
            tokenInIndex: U256::from(trade.token_in_index),
            tokenOutIndex: U256::from(trade.token_out_index),
            maker: trade.maker,
            amountIn: amount_in,
        };
        let receipt = self
            .provider
            .send_transaction(
                TransactionRequest::default()
                    .from(self.bot_address)
                    .to(self.app_address)
                    .input(TransactionInput::both(call.abi_encode().into())),
            )
            .await
            .context("failed to submit swap transaction")?
            .get_receipt()
            .await
            .context("failed waiting for swap receipt")?;
        if !receipt.status() {
            bail!("swap transaction reverted: {}", receipt.transaction_hash);
        }

        info!(
            "random trade confirmed: tx={} maker={} token_in={} token_out={} amount_in={} amount_out={}",
            receipt.transaction_hash,
            trade.maker,
            trade.token_in,
            trade.token_out,
            amount_in,
            amount_out
        );
        Ok(())
    }

    async fn decimals(&mut self, token: Address) -> Result<u8> {
        if let Some(&decimals) = self.token_decimals.get(&token) {
            return Ok(decimals);
        }

        let response = self
            .provider
            .call(
                TransactionRequest::default()
                    .to(token)
                    .input(TransactionInput::both(decimalsCall {}.abi_encode().into())),
            )
            .await
            .with_context(|| format!("failed to read decimals for token {token}"))?;
        let decimals = decimalsCall::abi_decode_returns(&response)
            .with_context(|| format!("failed to decode decimals for token {token}"))?;
        self.token_decimals.insert(token, decimals);
        Ok(decimals)
    }

    async fn ensure_allowance(&self, token: Address, amount: U256) -> Result<()> {
        let call = allowanceCall {
            owner: self.bot_address,
            spender: self.app_address,
        };
        let response = self
            .provider
            .call(
                TransactionRequest::default()
                    .to(token)
                    .input(TransactionInput::both(call.abi_encode().into())),
            )
            .await
            .with_context(|| format!("failed to read allowance for token {token}"))?;
        let allowance = allowanceCall::abi_decode_returns(&response)
            .with_context(|| format!("failed to decode allowance for token {token}"))?;
        if allowance >= amount {
            return Ok(());
        }

        // Some stablecoins require an existing allowance to be reset before it is increased.
        if !allowance.is_zero() {
            self.approve(token, U256::ZERO).await?;
        }
        self.approve(token, U256::MAX).await
    }

    async fn approve(&self, token: Address, amount: U256) -> Result<()> {
        let call = approveCall {
            spender: self.app_address,
            amount,
        };
        let receipt = self
            .provider
            .send_transaction(
                TransactionRequest::default()
                    .from(self.bot_address)
                    .to(token)
                    .input(TransactionInput::both(call.abi_encode().into())),
            )
            .await
            .with_context(|| format!("failed to submit approval for token {token}"))?
            .get_receipt()
            .await
            .with_context(|| format!("failed waiting for approval receipt for token {token}"))?;
        if !receipt.status() {
            bail!(
                "approval transaction reverted for token {token}: {}",
                receipt.transaction_hash
            );
        }
        Ok(())
    }
}

#[derive(Clone)]
struct IndexedPool {
    maker: Address,
    strategy: Bytes,
    fee_bps: u16,
    tokens: Vec<Address>,
    balances: Vec<U256>,
}

struct SelectedTrade {
    maker: Address,
    strategy: Bytes,
    fee_bps: u16,
    token_in: Address,
    token_out: Address,
    token_in_index: usize,
    token_out_index: usize,
    output_balance: U256,
    whole_token_amount: u64,
    amount_in: U256,
}

fn select_trade(liquidity_book: &LiquidityBook) -> Option<SelectedTrade> {
    let mut pools = Vec::new();
    for (&maker_address, maker) in &liquidity_book.makers {
        for (&strategy_hash, strategy) in &maker.accepted_strategies {
            let data = strategy.as_ref();
            if data.len() < 42 || (data.len() - 2) % 20 != 0 {
                continue;
            }

            let fee_bps = u16::from_be_bytes([data[0], data[1]]);
            if u64::from(fee_bps) >= BPS_BASE {
                continue;
            }
            let tokens: Vec<Address> = data[2..]
                .chunks_exact(20)
                .map(Address::from_slice)
                .collect();
            let balances: Vec<U256> = tokens
                .iter()
                .map(|token| {
                    maker
                        .tokens
                        .get(token)
                        .and_then(|strategies| strategies.get(&strategy_hash))
                        .copied()
                        .unwrap_or_default()
                })
                .collect();
            if balances.iter().all(U256::is_zero) {
                continue;
            }

            pools.push(IndexedPool {
                maker: maker_address,
                strategy: strategy.clone(),
                fee_bps,
                tokens,
                balances,
            });
        }
    }

    let mut rng = rand::rng();
    let pool = pools.choose(&mut rng)?.clone();
    let output_indices: Vec<usize> = pool
        .balances
        .iter()
        .enumerate()
        .filter_map(|(index, balance)| (!balance.is_zero()).then_some(index))
        .collect();
    let token_out_index = *output_indices.choose(&mut rng)?;
    let input_indices: Vec<usize> = (0..pool.tokens.len())
        .filter(|&index| index != token_out_index)
        .collect();
    let token_in_index = *input_indices.choose(&mut rng)?;
    let whole_token_amount = rng.random_range(1..=MAX_RANDOM_TRADE);

    Some(SelectedTrade {
        maker: pool.maker,
        strategy: pool.strategy,
        fee_bps: pool.fee_bps,
        token_in: pool.tokens[token_in_index],
        token_out: pool.tokens[token_out_index],
        token_in_index,
        token_out_index,
        output_balance: pool.balances[token_out_index],
        whole_token_amount,
        amount_in: U256::ZERO,
    })
}

fn capped_amounts(
    whole_token_amount: u64,
    input_decimals: u8,
    output_decimals: u8,
    fee_bps: u16,
    output_balance: U256,
) -> Option<(U256, U256)> {
    let input_unit = decimal_unit(input_decimals)?;
    let desired_input = input_unit.checked_mul(U256::from(whole_token_amount))?;
    let max_input = if input_decimals >= output_decimals {
        let conversion = decimal_unit(input_decimals - output_decimals)?;
        output_balance.checked_mul(conversion)?
    } else {
        let conversion = decimal_unit(output_decimals - input_decimals)?;
        output_balance / conversion
    };
    let amount_in = desired_input.min(max_input);
    if amount_in.is_zero() {
        return None;
    }

    let amount_out_no_fee = if input_decimals >= output_decimals {
        amount_in / decimal_unit(input_decimals - output_decimals)?
    } else {
        amount_in.checked_mul(decimal_unit(output_decimals - input_decimals)?)?
    };
    let fee_numerator = amount_out_no_fee.checked_mul(U256::from(fee_bps))?;
    let fee = fee_numerator.checked_add(U256::from(BPS_BASE - 1))? / U256::from(BPS_BASE);
    let amount_out = amount_out_no_fee.checked_sub(fee)?;
    if amount_out.is_zero() || amount_out > output_balance {
        return None;
    }

    Some((amount_in, amount_out))
}

fn decimal_unit(decimals: u8) -> Option<U256> {
    let mut unit = U256::from(1);
    for _ in 0..decimals {
        unit = unit.checked_mul(U256::from(10))?;
    }
    Some(unit)
}
