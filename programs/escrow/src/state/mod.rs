use anchor_lang::prelude::*;

#[account]
// Implements a Space trait on the given struct or enum.
#[derive(InitSpace)]
// https://docs.rs/anchor-lang/latest/anchor_lang/prelude/derive.InitSpace.html
pub struct Escrow {
    pub seed: u64,
    pub maker: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub receive: u64,
    pub bump: u8,
}

// SPL Token
// Mint Account: Creating token is executed by creating a mint account. Mint account create token to user token account.
// if you want to find information about token, you can find it in mint account.
// Token Account: User's token account. User can hold token in this account. Have at least one token account for each type of token you own.
