import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Escrow } from "../target/types/escrow";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { BN } from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";

describe("escrow", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.escrow as Program<Escrow>;
  const maker = anchor.web3.Keypair.generate();
  const taker = anchor.web3.Keypair.generate();

  let mintA: PublicKey;
  let mintB: PublicKey;
  let makerAtaA: PublicKey;
  let makerAtaB: PublicKey;
  let takerAtaA: PublicKey;
  let takerAtaB: PublicKey;
  let escrow: PublicKey;
  let vault: PublicKey;

  const seed = new BN(Math.floor(Math.random() * 1000000));
  const depositAmount = 50;
  const receiveAmount = 25;

  before(async () => {
    // Airdrop to maker and taker
    await provider.connection.requestAirdrop(
      maker.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.requestAirdrop(
      taker.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );

    // Create token mints
    mintA = await createMint(
      provider.connection,
      provider.wallet.payer, // payer
      provider.wallet.publicKey, // mint authority
      null, // freeze authority
      9 // decimals
    );

    mintB = await createMint(
      provider.connection,
      provider.wallet.payer, // payer
      provider.wallet.publicKey, // mint authority
      null, // freeze authority
      9 // decimals
    );

    // Create token accounts
    const makerAtaAAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mintA,
      maker.publicKey
    );
    makerAtaA = makerAtaAAccount.address;

    makerAtaB = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        mintB,
        maker.publicKey
      )
    ).address;

    takerAtaA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        mintA,
        taker.publicKey
      )
    ).address;

    const takerAtaBAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mintB,
      taker.publicKey
    );
    takerAtaB = takerAtaBAccount.address;

    // Mint tokens to maker and taker
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      mintA,
      makerAtaA,
      provider.wallet.publicKey,
      depositAmount
    );

    await mintTo(
      provider.connection,
      provider.wallet.payer,
      mintB,
      takerAtaB,
      provider.wallet.publicKey,
      receiveAmount
    );

    // Get PDA for escrow
    const [escrowAddress] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        maker.publicKey.toBuffer(),
        seed.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    escrow = escrowAddress;

    // Get PDA for vault
    vault = getAssociatedTokenAddressSync(
      mintA,
      escrow,
      true,
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
  });

  it("Make escrow", async () => {
    try {
      // Execute make transaction
      const tx = await program.methods
        .make(seed, new BN(receiveAmount), new BN(depositAmount))
        .accounts({
          maker: maker.publicKey,
          mintA,
          mintB,
          makerAtaA,
          escrow,
          vault,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([maker])
        .rpc();

      console.log("Make transaction signature", tx);

      // Check escrow state
      const escrowAccount = await program.account.escrow.fetch(escrow);
      assert.ok(
        escrowAccount.maker.equals(maker.publicKey),
        "Maker should match"
      );
      assert.ok(escrowAccount.mintA.equals(mintA), "Mint A should match");
      assert.ok(escrowAccount.mintB.equals(mintB), "Mint B should match");
      assert.ok(
        escrowAccount.receive.eq(new BN(receiveAmount)),
        "Receive amount should match"
      );

      // Check vault balance
      const vaultAccount = await getAccount(provider.connection, vault);
      assert.equal(
        Number(vaultAccount.amount),
        depositAmount,
        "Vault balance should be deposit amount"
      );

      // Check maker balance
      const makerAccount = await getAccount(provider.connection, makerAtaA);
      assert.equal(
        Number(makerAccount.amount),
        0,
        "Maker account should have no tokens left"
      );
    } catch (err) {
      console.error("Make error:", err);
      throw err;
    }
  });

  it("Take escrow", async () => {
    try {
      // Execute take transaction
      const tx = await program.methods
        .take()
        .accounts({
          taker: taker.publicKey,
          maker: maker.publicKey,
          mintA: mintA,
          mintB: mintB,
          makerAtaB,
          takerAtaA,
          takerAtaB,
          escrow,
          vault,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([taker])
        .rpc();

      console.log("Take transaction signature", tx);

      // Check balances after take
      const takerAccountA = await getAccount(provider.connection, takerAtaA);
      assert.equal(
        Number(takerAccountA.amount),
        depositAmount,
        "Taker should have received deposit amount"
      );

      const makerAccountB = await getAccount(provider.connection, makerAtaB);
      assert.equal(
        Number(makerAccountB.amount),
        receiveAmount,
        "Maker should have received requested amount"
      );

      // Verify escrow account is closed
      try {
        await program.account.escrow.fetch(escrow);
        assert.fail("Escrow account should be closed");
      } catch (err) {
        assert.include(
          err.message,
          "Account does not exist",
          "Error should be account not found"
        );
      }
    } catch (err) {
      console.error("Take error:", err);
      throw err;
    }
  });

  it("Make and refund escrow", async () => {
    // Create new escrow for refund test
    const newSeed = new BN(Math.floor(Math.random() * 1000000));

    // Mint new tokens to maker
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      mintA,
      makerAtaA,
      provider.wallet.publicKey,
      depositAmount
    );

    // Get new PDAs
    const [newEscrow] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        maker.publicKey.toBuffer(),
        newSeed.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const newVault = getAssociatedTokenAddressSync(
      mintA,
      newEscrow,
      true,
      anchor.utils.token.TOKEN_PROGRAM_ID
    );

    // Create new escrow
    await program.methods
      .make(newSeed, new BN(receiveAmount), new BN(depositAmount))
      .accounts({
        maker: maker.publicKey,
        mintA,
        mintB,
        makerAtaA,
        escrow: newEscrow,
        vault: newVault,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    // Get balance before refund
    const makerBalanceBefore = await getAccount(provider.connection, makerAtaA);

    // Execute refund
    try {
      const tx = await program.methods
        .refund()
        .accounts({
          maker: maker.publicKey,
          mintA,
          makerAtaA,
          escrow: newEscrow,
          vault: newVault,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([maker])
        .rpc();

      console.log("Refund transaction signature", tx);

      // Check maker balance after refund
      const makerAccountAfter = await getAccount(
        provider.connection,
        makerAtaA
      );
      assert.equal(
        Number(makerAccountAfter.amount),
        Number(makerBalanceBefore.amount) + depositAmount,
        "Maker should have received refund"
      );

      // Verify escrow account is closed
      try {
        await program.account.escrow.fetch(newEscrow);
        assert.fail("Escrow account should be closed after refund");
      } catch (err) {
        assert.include(
          err.message,
          "Account does not exist",
          "Error should be account not found"
        );
      }
    } catch (err) {
      console.error("Refund error:", err);
      throw err;
    }
  });
});
