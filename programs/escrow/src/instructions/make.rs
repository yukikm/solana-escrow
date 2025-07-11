use anchor_lang::prelude::*;

use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

// crate is wrap modules.
use crate::Escrow;

#[derive(Accounts)]
// instruction seed is used to create a unique escrow account for each transaction
#[instruction(seed: u64)]
pub struct Make<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    // mint::token_program is used to verify that the mint accounts are owned by the SPL Token program
    // forgery token accounts are not possible
    #[account(
        mint::token_program = token_program,
    )]
    // it verifies program ownership and deserializes the underlying data into a Rust type
    // We can use the InterfaceAccount wrapper with the Mint or TokenAccount types from the anchor_spl::token_interface crate we mentioned.
    pub mint_a: InterfaceAccount<'info, Mint>,
    #[account(
        mint::token_program = token_program,
    )]
    pub mint_b: InterfaceAccount<'info, Mint>,

    // if you want to create ata, you use associated_token::constraints
    // existing ATA is used, so it is not init
    #[account(
        mut,
        associated_token::mint = mint_a, // mint account
        associated_token::authority = maker, // Sets the authority (owner) of the token account who has permission to transfer or burn tokens.
        associated_token::token_program = token_program,
    )]
    pub maker_ata_a: InterfaceAccount<'info, TokenAccount>,
    // https://www.anchor-lang.com/docs/tokens/basics/create-token-account#associated_token-constraints
    #[account(
        init,
        payer = maker,
        seeds = [b"escrow", maker.key().as_ref(), seed.to_le_bytes().as_ref()],
        space = 8 + Escrow::INIT_SPACE,
        bump,
    )]
    pub escrow: Account<'info, Escrow>,

    // vault is escrow's token account. escrow account holds the tokens deposited by the maker
    #[account(
        init,
        payer = maker,
        associated_token::mint = mint_a,
        associated_token::authority = escrow,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> Make<'info> {
    pub fn init_escrow(&mut self, seed: u64, receive: u64, bumps: &MakeBumps) -> Result<()> {
        // set_innter is used to set the inner data of the escrow account
        self.escrow.set_inner(Escrow {
            seed,
            maker: self.maker.key(),
            mint_a: self.mint_a.key(),
            mint_b: self.mint_b.key(),
            receive,
            bump: bumps.escrow,
        });
        Ok(())
    }

    pub fn deposit(&mut self, deposit: u64) -> Result<()> {
        // Transfer is deprecated, use transfer_checked instead in token 2022
        let transfer_accounts = TransferChecked {
            from: self.maker_ata_a.to_account_info(),
            mint: self.mint_a.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.maker.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(self.token_program.to_account_info(), transfer_accounts);
        transfer_checked(cpi_ctx, deposit, self.mint_a.decimals)?;
        Ok(())
    }
}
