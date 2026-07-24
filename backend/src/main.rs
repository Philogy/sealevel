use alloy_primitives::{Address, B256, Bytes, U256};
use anyhow::{Context, Result};
use std::collections::HashMap;
use url::Url;

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

pub struct LiquidityBook {
    pub last_processed_block: u64,
    pub makers: HashMap<Address, Maker>,
}

pub struct Maker {
    pub accepted_strategies: HashMap<B256, Bytes>,
    pub tokens: HashMap<Address, HashMap<B256, U256>>,
}

fn main() -> Result<()> {
    let _config = Config::load()?;
    println!("sealevel backend");
    Ok(())
}
