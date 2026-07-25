use alloy_primitives::{Address, B256, Bytes, U256};
use alloy_provider::{Provider, RootProvider};
use alloy_rpc_client::ClientBuilder;
use alloy_transport_ws::WsConnect;
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::ErrorKind;
use tokio::sync::watch;
use url::Url;

const LIQUIDITY_BOOK_PATH: &str = "liquidity_book.json";

pub struct Config {
    pub rpc_url: Url,
    pub chain_id: u64,
    pub aqua_router_address: Address,
    pub aqua_router_creation_block: u64,
    pub stable_amm_app_address: Address,
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
        let stable_amm_app_address = std::env::var("STABLE_AMM_APP_ADDRESS")
            .context("STABLE_AMM_APP_ADDRESS must be set")?
            .parse::<Address>()
            .context("STABLE_AMM_APP_ADDRESS must be a valid address")?;

        Ok(Self {
            rpc_url,
            chain_id,
            aqua_router_address,
            aqua_router_creation_block,
            stable_amm_app_address,
        })
    }
}

#[derive(Deserialize, Serialize)]
pub struct LiquidityBook {
    pub last_processed_block: u64,
    pub makers: HashMap<Address, Maker>,
}

#[derive(Deserialize, Serialize)]
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
    pub stable_amm_app_address: Address,
    pub liquidity_book: LiquidityBook,
}

impl Backend {
    pub fn new(config: Config) -> Result<Self> {
        let mut ws_url = config.rpc_url.clone();
        let scheme = match ws_url.scheme() {
            "http" => "ws",
            "https" => "wss",
            _ => bail!("RPC_URL must use http or https to derive a WebSocket URL"),
        };
        ws_url
            .set_scheme(scheme)
            .map_err(|_| anyhow!("failed to derive WebSocket URL from RPC_URL"))?;
        let http_provider = RootProvider::new_http(config.rpc_url);
        let liquidity_book = match LiquidityBook::load() {
            Ok(Some(liquidity_book)) => liquidity_book,
            Ok(None) => LiquidityBook {
                last_processed_block: config.aqua_router_creation_block,
                makers: HashMap::new(),
            },
            Err(error) => {
                eprintln!("failed to load liquidity book: {error:#}");
                LiquidityBook {
                    last_processed_block: config.aqua_router_creation_block,
                    makers: HashMap::new(),
                }
            }
        };
        let (head_sender, head_receiver) = watch::channel(liquidity_book.last_processed_block);
        tokio::spawn(listen_for_heads(ws_url, head_sender));

        Ok(Self {
            http_provider,
            head_receiver,
            aqua_router_address: config.aqua_router_address,
            stable_amm_app_address: config.stable_amm_app_address,
            liquidity_book,
        })
    }
}

async fn listen_for_heads(ws_url: Url, head_sender: watch::Sender<u64>) {
    let ws_provider: RootProvider = match ClientBuilder::default()
        .ws(WsConnect::new(ws_url.as_str()).with_max_retries(u32::MAX))
        .await
    {
        Ok(client) => RootProvider::new(client),
        Err(error) => {
            eprintln!("failed to connect WebSocket provider: {error:#}");
            return;
        }
    };
    let mut subscription = match ws_provider.subscribe_blocks().await {
        Ok(subscription) => subscription,
        Err(error) => {
            eprintln!("failed to subscribe to new block heads: {error:#}");
            return;
        }
    };

    while let Ok(header) = subscription.recv().await {
        head_sender.send_replace(header.number);
    }

    eprintln!("new block head subscription ended");
}

#[tokio::main]
async fn main() {
    let config = match Config::load() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("failed to load configuration: {error:#}");
            std::process::exit(1);
        }
    };

    let _backend = match Backend::new(config) {
        Ok(backend) => backend,
        Err(error) => {
            eprintln!("failed to create backend: {error:#}");
            std::process::exit(1);
        }
    };

    println!("sealevel backend");
}
