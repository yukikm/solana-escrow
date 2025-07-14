#![allow(unexpected_cfgs)]
#![allow(deprecated)]
pub mod constants; // constants.rs
pub mod error; // error.rs
pub mod instructions; // instructions/*
pub mod state; // state/*

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("AFsE5ZUWMy2rNDa6rvaYjBVwM93hdpcxKiamgi5dUt8b");

#[program]
pub mod escrow {

    use super::*;

    pub fn make(ctx: Context<Make>, seed: u64, receive: u64, deposit: u64) -> Result<()> {
        ctx.accounts.init_escrow(seed, receive, &ctx.bumps)?;
        ctx.accounts.deposit(deposit)?;

        Ok(())
    }

    pub fn take(ctx: Context<Take>) -> Result<()> {
        ctx.accounts.deposit()?;
        ctx.accounts.withdraw_and_close_vault()?;

        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        ctx.accounts.refund_and_close_vault()?;
        Ok(())
    }
}

// maker - token A -> vault and want to receive token B
// taker - token B -> maker and withdraw token A deposited by maker from vault
// taker should know the maker's public key to take the escrow
