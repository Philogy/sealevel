use alloy_primitives::{Address, B256, Bytes, U256};
use std::collections::HashMap;

pub struct LiquidityBook {
    pub last_processed_block: u64,
    pub makers: HashMap<Address, Maker>,
}

pub struct Maker {
    pub accepted_strategies: HashMap<B256, Bytes>,
    pub tokens: HashMap<Address, HashMap<B256, U256>>,
}

fn main() {
    println!("sealevel backend");
}
