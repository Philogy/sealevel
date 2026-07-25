mod trader;

use alloy_primitives::{Address, B256, Bytes, U256};
use alloy_provider::{Provider, RootProvider};
use alloy_rpc_client::ClientBuilder;
use alloy_rpc_types_eth::{Filter, Log, TransactionInput, TransactionRequest};
use alloy_signer_local::PrivateKeySigner;
use alloy_sol_types::{SolCall, SolEvent, sol};
use alloy_transport_ws::WsConnect;
use anyhow::{Context, Result, anyhow, bail};
use axum::{
    Router,
    extract::{Path, State},
    response::Json,
    routing::get,
};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::ErrorKind;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use url::Url;

const LIQUIDITY_BOOK_PATH: &str = "liquidity_book.json";
const BLOCK_RANGE_SIZE: u64 = 10;
const MAX_REQUEST_ERRORS: u8 = 10;

sol! {
    event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy);
    event Docked(address maker, address app, bytes32 strategyHash);
    event Pulled(address maker, address app, bytes32 strategyHash, address token, uint256 amount);
    event Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount);

    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external
        view
        returns (uint248 balance, uint8 tokensCount);
}

pub struct Config {
    pub rpc_url: Url,
    pub chain_id: u64,
    pub aqua_router_address: Address,
    pub aqua_router_creation_block: u64,
    pub sealevel_app_address: Address,
}

impl Config {
    pub fn load() -> Result<Self> {
        dotenvy::dotenv().context("failed to load .env")?;

        let rpc_url = Url::parse(&std::env::var("RPC_URL").context("RPC_URL must be set")?)
            .context("RPC_URL must be a valid URL")?;

        let chain_id = std::env::var("CHAIN_ID")
            .context("CHAIN_ID must be set")?
            .parse::<u64>()
            .context("CHAIN_ID must be a u64")?;
        let aqua_router_address = std::env::var("AQUA_ROUTER_ADDRESS")
            .context("AQUA_ROUTER_ADDRESS must be set")?
            .parse::<Address>()
            .context("AQUA_ROUTER_ADDRESS must be a valid address")?;
        let aqua_router_creation_block = std::env::var("AQUA_ROUTER_CREATION_BLOCK")
            .context("AQUA_ROUTER_CREATION_BLOCK must be set")?
            .parse::<u64>()
            .context("AQUA_ROUTER_CREATION_BLOCK must be a u64")?;
        let sealevel_app_address = std::env::var("SEALEVEL_APP_ADDRESS")
            .context("SEALEVEL_APP_ADDRESS must be set")?
            .parse::<Address>()
            .context("SEALEVEL_APP_ADDRESS must be a valid address")?;

        Ok(Self {
            rpc_url,
            chain_id,
            aqua_router_address,
            aqua_router_creation_block,
            sealevel_app_address,
        })
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct LiquidityBook {
    pub last_processed_block: u64,
    pub makers: HashMap<Address, Maker>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Maker {
    pub accepted_strategies: HashMap<B256, Bytes>,
    pub tokens: HashMap<Address, HashMap<B256, U256>>,
}

impl LiquidityBook {
    pub fn load() -> Result<Option<Self>> {
        match std::fs::read(LIQUIDITY_BOOK_PATH) {
            Ok(contents) => serde_json::from_slice(&contents)
                .context("failed to parse liquidity_book.json")
                .map(Some),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error).context("failed to read liquidity_book.json"),
        }
    }

    pub fn backup(&self) -> Result<()> {
        let contents = serde_json::to_vec(self).context("failed to serialize liquidity book")?;
        std::fs::write(format!("{LIQUIDITY_BOOK_PATH}.tmp"), contents)
            .context("failed to write liquidity_book.json.tmp")?;
        std::fs::rename(format!("{LIQUIDITY_BOOK_PATH}.tmp"), LIQUIDITY_BOOK_PATH)
            .context("failed to replace liquidity_book.json")?;
        Ok(())
    }
}

pub struct Backend {
    pub http_provider: RootProvider,
    pub head_receiver: watch::Receiver<u64>,
    pub aqua_router_address: Address,
    pub sealevel_app_address: Address,
    pub liquidity_book: LiquidityBook,
    liquidity_book_sender: watch::Sender<Arc<LiquidityBook>>,
}

impl Backend {
    pub fn new(config: &Config) -> Result<Self> {
        let mut ws_url = config.rpc_url.clone();
        let scheme = match ws_url.scheme() {
            "http" => "ws",
            "https" => "wss",
            _ => bail!("RPC_URL must use http or https to derive a WebSocket URL"),
        };
        ws_url
            .set_scheme(scheme)
            .map_err(|_| anyhow!("failed to derive WebSocket URL from RPC_URL"))?;
        let http_provider = RootProvider::new_http(config.rpc_url.clone());
        let liquidity_book = match LiquidityBook::load() {
            Ok(Some(liquidity_book)) => liquidity_book,
            Ok(None) => LiquidityBook {
                last_processed_block: config.aqua_router_creation_block,
                makers: HashMap::new(),
            },
            Err(error) => {
                warn!("failed to load liquidity book: {error:#}");
                LiquidityBook {
                    last_processed_block: config.aqua_router_creation_block,
                    makers: HashMap::new(),
                }
            }
        };
        let (head_sender, head_receiver) = watch::channel(liquidity_book.last_processed_block);
        tokio::spawn(listen_for_heads(ws_url, head_sender));
        let (liquidity_book_sender, _) = watch::channel(Arc::new(liquidity_book.clone()));

        Ok(Self {
            http_provider,
            head_receiver,
            aqua_router_address: config.aqua_router_address,
            sealevel_app_address: config.sealevel_app_address,
            liquidity_book,
            liquidity_book_sender,
        })
    }

    pub async fn run(&mut self) -> Result<()> {
        let mut current_block = self
            .http_provider
            .get_block_number()
            .await
            .context("failed to get current block number")?;

        loop {
            if self.liquidity_book.last_processed_block == current_block {
                self.head_receiver
                    .changed()
                    .await
                    .context("new block head subscription stopped")?;
                current_block = *self.head_receiver.borrow_and_update();
            }

            let from_block = self.liquidity_book.last_processed_block + 1;
            let to_block =
                current_block.min(self.liquidity_book.last_processed_block + BLOCK_RANGE_SIZE);
            if from_block == to_block {
                info!("processing block {from_block}");
            } else {
                info!("processing blocks {from_block} through {to_block}");
            }
            let filter = Filter::new()
                .address(self.aqua_router_address)
                .from_block(from_block)
                .to_block(to_block)
                .event_signature(vec![
                    Shipped::SIGNATURE_HASH,
                    Docked::SIGNATURE_HASH,
                    Pulled::SIGNATURE_HASH,
                    Pushed::SIGNATURE_HASH,
                ]);
            let mut request_errors = 0;
            let logs = loop {
                match self.http_provider.get_logs(&filter).await {
                    Ok(logs) => break logs,
                    Err(error) => {
                        request_errors += 1;
                        warn!("error getting AquaRouter logs: {error:#}");
                        if request_errors == MAX_REQUEST_ERRORS {
                            return Err(error).context("too many errors getting AquaRouter logs");
                        }
                        tokio::time::sleep(Duration::from_secs(u64::from(request_errors))).await;
                    }
                }
            };
            tokio::time::sleep(Duration::from_millis(250)).await;

            for log in logs {
                self.process_log(log).await?;
            }

            self.liquidity_book.last_processed_block = to_block;
            self.liquidity_book_sender
                .send_replace(Arc::new(self.liquidity_book.clone()));
            if let Err(error) = self.liquidity_book.backup() {
                error!("failed to back up liquidity book: {error:#}");
            }
        }
    }

    async fn process_log(&mut self, log: Log) -> Result<()> {
        let Some(topic) = log.topic0() else {
            return Ok(());
        };

        match *topic {
            Shipped::SIGNATURE_HASH => {
                let event = log
                    .log_decode_validate::<Shipped>()
                    .context("failed to decode Shipped event")?
                    .inner
                    .data;
                if event.app != self.sealevel_app_address {
                    return Ok(());
                }

                let maker = self
                    .liquidity_book
                    .makers
                    .entry(event.maker)
                    .or_insert_with(|| Maker {
                        accepted_strategies: HashMap::new(),
                        tokens: HashMap::new(),
                    });
                maker
                    .accepted_strategies
                    .insert(event.strategyHash, event.strategy);
            }
            Docked::SIGNATURE_HASH => {
                let event = log
                    .log_decode_validate::<Docked>()
                    .context("failed to decode Docked event")?
                    .inner
                    .data;
                if event.app != self.sealevel_app_address {
                    return Ok(());
                }

                let Some(maker) = self.liquidity_book.makers.get_mut(&event.maker) else {
                    return Ok(());
                };
                if !maker.accepted_strategies.contains_key(&event.strategyHash) {
                    return Ok(());
                }
                let mut tokens = std::mem::take(&mut maker.tokens);

                let block_number = log
                    .block_number
                    .context("Docked event is missing block number")?;
                let mut docked_tokens = Vec::new();
                for (&token, strategies) in &tokens {
                    if !strategies.contains_key(&event.strategyHash) {
                        continue;
                    }
                    let call = rawBalancesCall {
                        maker: event.maker,
                        app: event.app,
                        strategyHash: event.strategyHash,
                        token,
                    };
                    let response = self
                        .http_provider
                        .call(
                            TransactionRequest::default()
                                .to(self.aqua_router_address)
                                .input(TransactionInput::both(call.abi_encode().into())),
                        )
                        .number(block_number)
                        .await
                        .context("failed to read AquaRouter raw balance")?;
                    let raw = rawBalancesCall::abi_decode_returns(&response)
                        .context("failed to decode AquaRouter raw balance")?;
                    if raw.tokensCount == u8::MAX {
                        docked_tokens.push(token);
                    }
                }

                for token in docked_tokens {
                    tokens
                        .get_mut(&token)
                        .expect("token was collected from maker")
                        .remove(&event.strategyHash);
                }
                tokens.retain(|_, strategies| !strategies.is_empty());

                let maker = self
                    .liquidity_book
                    .makers
                    .get_mut(&event.maker)
                    .expect("maker was checked before reading raw balances");
                if !tokens
                    .values()
                    .any(|strategies| strategies.contains_key(&event.strategyHash))
                {
                    maker.accepted_strategies.remove(&event.strategyHash);
                }
                maker.tokens = tokens;
                if maker.accepted_strategies.is_empty() && maker.tokens.is_empty() {
                    self.liquidity_book.makers.remove(&event.maker);
                }
            }
            Pulled::SIGNATURE_HASH => {
                let event = log
                    .log_decode_validate::<Pulled>()
                    .context("failed to decode Pulled event")?
                    .inner
                    .data;
                if event.app != self.sealevel_app_address {
                    return Ok(());
                }

                let maker = self
                    .liquidity_book
                    .makers
                    .get_mut(&event.maker)
                    .context("Pulled event references an unknown maker")?;
                let balance = maker
                    .tokens
                    .get_mut(&event.token)
                    .and_then(|balances| balances.get_mut(&event.strategyHash))
                    .context("Pulled event references an unknown token balance")?;
                *balance -= event.amount;
            }
            Pushed::SIGNATURE_HASH => {
                let event = log
                    .log_decode_validate::<Pushed>()
                    .context("failed to decode Pushed event")?
                    .inner
                    .data;
                if event.app != self.sealevel_app_address {
                    return Ok(());
                }

                let maker = self
                    .liquidity_book
                    .makers
                    .get_mut(&event.maker)
                    .context("Pushed event references an unknown maker")?;
                let balance = maker
                    .tokens
                    .entry(event.token)
                    .or_default()
                    .entry(event.strategyHash)
                    .or_default();
                *balance += event.amount;
            }
            _ => return Ok(()),
        }

        Ok(())
    }
}

async fn get_maker(
    State(liquidity_book): State<watch::Receiver<Arc<LiquidityBook>>>,
    Path(maker): Path<String>,
) -> Json<serde_json::Value> {
    let liquidity_book = liquidity_book.borrow();
    let maker = maker
        .parse::<Address>()
        .ok()
        .and_then(|maker| liquidity_book.makers.get(&maker))
        .cloned();

    Json(serde_json::json!({
        "last_processed_block": liquidity_book.last_processed_block,
        "maker": maker,
    }))
}

async fn run_http_server(liquidity_book: watch::Receiver<Arc<LiquidityBook>>) -> Result<()> {
    let app = Router::new()
        .route("/makers/{maker}", get(get_maker))
        .with_state(liquidity_book);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000")
        .await
        .context("failed to bind HTTP server")?;
    info!("HTTP server listening on 127.0.0.1:3000");
    axum::serve(listener, app)
        .await
        .context("HTTP server stopped")?;
    Ok(())
}

async fn listen_for_heads(ws_url: Url, head_sender: watch::Sender<u64>) {
    let ws_provider: RootProvider = match ClientBuilder::default()
        .ws(WsConnect::new(ws_url.as_str()).with_max_retries(u32::MAX))
        .await
    {
        Ok(client) => RootProvider::new(client),
        Err(error) => {
            error!("failed to connect WebSocket provider: {error:#}");
            return;
        }
    };
    let mut subscription = match ws_provider.subscribe_blocks().await {
        Ok(subscription) => subscription,
        Err(error) => {
            error!("failed to subscribe to new block heads: {error:#}");
            return;
        }
    };

    while let Ok(header) = subscription.recv().await {
        head_sender.send_replace(header.number);
    }

    error!("new block head subscription ended");
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("sealevel_backend=info,warn"),
    )
    .init();

    let config = match Config::load() {
        Ok(config) => config,
        Err(error) => {
            error!("failed to load configuration: {error:#}");
            std::process::exit(1);
        }
    };
    info!(
        "starting backend for chain {} with AquaRouter {} and Sealevel {}",
        config.chain_id, config.aqua_router_address, config.sealevel_app_address
    );

    let mut backend = match Backend::new(&config) {
        Ok(backend) => backend,
        Err(error) => {
            error!("failed to create backend: {error:#}");
            std::process::exit(1);
        }
    };
    let http_liquidity_book_receiver = backend.liquidity_book_sender.subscribe();
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let (start_trader, trade_interval_secs) = match arguments.as_slice() {
        [] => (false, None),
        [argument] if argument == "--trader" => (true, None),
        [argument, trade_interval_secs] if argument == "--trader" => {
            let trade_interval_secs = match trade_interval_secs.parse::<u32>() {
                Ok(trade_interval_secs) => trade_interval_secs,
                Err(error) => {
                    error!("TRADE_INTERVAL_SECS must be a u32: {error}");
                    std::process::exit(1);
                }
            };
            (true, Some(trade_interval_secs))
        }
        _ => {
            error!("usage: sealevel-backend [--trader [TRADE_INTERVAL_SECS]]");
            std::process::exit(1);
        }
    };
    if start_trader {
        let bot_private_key = match std::env::var("BOT_PRIVATE_KEY")
            .context("BOT_PRIVATE_KEY must be set")
            .and_then(|private_key| {
                private_key
                    .parse::<PrivateKeySigner>()
                    .context("BOT_PRIVATE_KEY must be a valid private key")
            }) {
            Ok(bot_private_key) => bot_private_key,
            Err(error) => {
                error!("failed to load trader configuration: {error:#}");
                std::process::exit(1);
            }
        };
        let trader_liquidity_book_receiver = backend.liquidity_book_sender.subscribe();
        let trader = trader::Trader::new(
            config.rpc_url.clone(),
            bot_private_key,
            config.chain_id,
            config.sealevel_app_address,
            trade_interval_secs,
            trader_liquidity_book_receiver,
        );
        tokio::spawn(async move {
            if let Err(error) = trader.run().await {
                error!("trader stopped: {error:#}");
            }
        });
        info!("trader started");
    }

    if let Err(error) =
        tokio::try_join!(backend.run(), run_http_server(http_liquidity_book_receiver))
    {
        error!("backend stopped: {error:#}");
        std::process::exit(1);
    }
}
