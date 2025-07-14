import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Escrow } from "../target/types/escrow";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
} from "@solana/web3.js";
import { assert } from "chai";
import { LiteSVM } from "litesvm";
import { readFileSync } from "fs";

describe("escrow", () => {
  let svm: LiteSVM;

  const payer = Keypair.generate();
  const maker = Keypair.generate();
  const taker = Keypair.generate();
  const mintA = Keypair.generate();
  const mintB = Keypair.generate();

  const seed = new BN(Math.floor(Math.random() * 1000000));
  const depositAmount = new BN(1_000_000); // 1 token with 6 decimals
  const receiveAmount = new BN(500_000); // 0.5 token with 6 decimals

  // Generate token accounts
  const makerAtaA = getAssociatedTokenAddressSync(
    mintA.publicKey,
    maker.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  const makerAtaB = getAssociatedTokenAddressSync(
    mintB.publicKey,
    maker.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  const takerAtaA = getAssociatedTokenAddressSync(
    mintA.publicKey,
    taker.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  const takerAtaB = getAssociatedTokenAddressSync(
    mintB.publicKey,
    taker.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );

  // Calculate PDAs
  const programId = new PublicKey(
    "AFsE5ZUWMy2rNDa6rvaYjBVwM93hdpcxKiamgi5dUt8b"
  );
  const [escrow] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("escrow"),
      maker.publicKey.toBuffer(),
      seed.toArrayLike(Buffer, "le", 8),
    ],
    programId
  );

  const vault = getAssociatedTokenAddressSync(
    mintA.publicKey,
    escrow,
    true,
    TOKEN_PROGRAM_ID
  );

  // Helper functions
  function sendTransaction(
    instructions: TransactionInstruction[],
    signers: Keypair[]
  ): string {
    const tx = new Transaction();
    instructions.forEach((ix) => tx.add(ix));

    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = payer.publicKey;

    const allSigners = [
      payer,
      ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)),
    ];
    tx.sign(...allSigners);

    const result = svm.sendTransaction(tx);
    console.log("Transaction result:", result);

    return "mock-signature";
  }

  async function getTokenBalance(ata: PublicKey): Promise<number> {
    const account = svm.getAccount(ata);
    if (!account) return 0;

    // Parse token account data (amount is at offset 64, 8 bytes little endian)
    const data = account.data;
    if (data.length < 72) return 0;

    const amount = Buffer.from(data.slice(64, 72)).readBigUInt64LE(0);
    return Number(amount);
  }

  function parseEscrowAccount(account: any): any {
    if (!account || account.data.length === 0) return null;

    const data = account.data;
    // Parse escrow account data based on the Rust struct
    // pub struct Escrow {
    //     pub seed: u64,        // 8 bytes
    //     pub maker: Pubkey,    // 32 bytes
    //     pub mint_a: Pubkey,   // 32 bytes
    //     pub mint_b: Pubkey,   // 32 bytes
    //     pub receive: u64,     // 8 bytes
    //     pub bump: u8,         // 1 byte
    // }

    if (data.length < 113) return null;

    const seed = Buffer.from(data.slice(8, 16)).readBigUInt64LE(0); // Skip discriminator (8 bytes)
    const maker = new PublicKey(data.slice(16, 48));
    const mintA = new PublicKey(data.slice(48, 80));
    const mintB = new PublicKey(data.slice(80, 112));
    const receive = Buffer.from(data.slice(112, 120)).readBigUInt64LE(0);
    const bump = data[120];

    return {
      seed: Number(seed),
      maker: maker.toBase58(),
      mintA: mintA.toBase58(),
      mintB: mintB.toBase58(),
      receive: Number(receive),
      bump,
    };
  }

  function logAccountBalances(
    description: string,
    accounts: { [key: string]: PublicKey }
  ) {
    console.log(`\n=== ${description} ===`);
    Object.entries(accounts).forEach(async ([name, pubkey]) => {
      const balance = await getTokenBalance(pubkey);
      console.log(`${name}: ${balance} tokens`);
    });
  }

  function logEscrowData(description: string, escrowPubkey: PublicKey) {
    console.log(`\n=== ${description} ===`);
    const account = svm.getAccount(escrowPubkey);
    if (!account) {
      console.log("Escrow account does not exist");
      return;
    }

    const escrowData = parseEscrowAccount(account);
    if (!escrowData) {
      console.log("Escrow account is closed or invalid");
      console.log("Account owner:", account.owner.toBase58());
      console.log("Account lamports:", account.lamports);
      console.log("Account data length:", account.data.length);
      return;
    }

    console.log("Escrow data:");
    console.log("  Seed:", escrowData.seed);
    console.log("  Maker:", escrowData.maker);
    console.log("  Mint A:", escrowData.mintA);
    console.log("  Mint B:", escrowData.mintB);
    console.log("  Receive amount:", escrowData.receive);
    console.log("  Bump:", escrowData.bump);
  }

  before(async () => {
    // Initialize LiteSVM
    svm = new LiteSVM();

    // Load the escrow program
    const programPath = "./target/deploy/escrow.so";
    const programBuffer = readFileSync(programPath);
    svm.addProgram(programId, programBuffer);

    // Airdrop SOL to accounts
    svm.airdrop(payer.publicKey, BigInt(10 * LAMPORTS_PER_SOL));
    svm.airdrop(maker.publicKey, BigInt(10 * LAMPORTS_PER_SOL));
    svm.airdrop(taker.publicKey, BigInt(10 * LAMPORTS_PER_SOL));

    // Setup mints and token accounts
    setupTokens();
  });

  function setupTokens() {
    const lamports = 1461600; // Fixed amount for mint account rent

    const instructions: TransactionInstruction[] = [];

    // Create mint accounts
    instructions.push(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintA.publicKey,
        lamports,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintB.publicKey,
        lamports,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      })
    );

    // Initialize mints
    instructions.push(
      createInitializeMint2Instruction(
        mintA.publicKey,
        6, // decimals
        maker.publicKey, // mint authority
        null, // freeze authority
        TOKEN_PROGRAM_ID
      ),
      createInitializeMint2Instruction(
        mintB.publicKey,
        6, // decimals
        taker.publicKey, // mint authority
        null, // freeze authority
        TOKEN_PROGRAM_ID
      )
    );

    // Create associated token accounts
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        makerAtaA,
        maker.publicKey,
        mintA.publicKey,
        TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        takerAtaB,
        taker.publicKey,
        mintB.publicKey,
        TOKEN_PROGRAM_ID
      )
    );

    // Mint tokens
    instructions.push(
      createMintToInstruction(
        mintA.publicKey,
        makerAtaA,
        maker.publicKey,
        depositAmount.toNumber(),
        [],
        TOKEN_PROGRAM_ID
      ),
      createMintToInstruction(
        mintB.publicKey,
        takerAtaB,
        taker.publicKey,
        receiveAmount.toNumber(),
        [],
        TOKEN_PROGRAM_ID
      )
    );

    sendTransaction(instructions, [mintA, mintB, maker, taker]);
  }

  it("Make escrow", async () => {
    console.log("\n🚀 Starting Make Escrow Test");

    // Log initial balances
    console.log("\n=== Initial Balances ===");
    const makerBalanceInitial = await getTokenBalance(makerAtaA);
    const vaultBalanceInitial = await getTokenBalance(vault);
    console.log(`Maker ATA A: ${makerBalanceInitial} tokens`);
    console.log(`Vault: ${vaultBalanceInitial} tokens`);

    // Check if escrow account exists before
    console.log("\n=== Before Make ===");
    const escrowBefore = svm.getAccount(escrow);
    console.log("Escrow account exists before:", !!escrowBefore);

    // Create mock provider
    const provider = {
      connection: {
        getAccountInfo: async (pubkey: PublicKey) => {
          const account = svm.getAccount(pubkey);
          return account
            ? {
                executable: account.executable,
                owner: account.owner,
                lamports: account.lamports,
                data: Buffer.from(account.data),
                rentEpoch: account.rentEpoch,
              }
            : null;
        },
      },
      wallet: new anchor.Wallet(maker),
    } as any;

    // Create the program instance
    const program = new Program<Escrow>(
      JSON.parse(readFileSync("./target/idl/escrow.json", "utf8")),
      provider
    );

    // Build make instruction with partial accounts and let Anchor resolve the rest
    const ix = await program.methods
      .make(seed, receiveAmount, depositAmount)
      .accountsPartial({
        maker: maker.publicKey,
        mintA: mintA.publicKey,
        mintB: mintB.publicKey,
        escrow: escrow,
        vault: vault,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const result = sendTransaction([ix], [maker]);
    console.log("Make transaction result:", result);

    // Log data after make
    logEscrowData("After Make - Escrow Account Data", escrow);

    console.log("\n=== After Make - Token Balances ===");
    const makerBalanceAfter = await getTokenBalance(makerAtaA);
    const vaultBalanceAfter = await getTokenBalance(vault);
    console.log(
      `Maker ATA A: ${makerBalanceAfter} tokens (change: ${
        makerBalanceAfter - makerBalanceInitial
      })`
    );
    console.log(
      `Vault: ${vaultBalanceAfter} tokens (change: ${
        vaultBalanceAfter - vaultBalanceInitial
      })`
    );

    // Check escrow state
    const escrowAccount = svm.getAccount(escrow);
    assert.ok(escrowAccount, "Escrow account should exist");
    assert.equal(
      escrowAccount.owner.toBase58(),
      programId.toBase58(),
      "Escrow should be owned by program"
    );

    // Check vault balance
    const vaultBalance = await getTokenBalance(vault);
    assert.equal(
      vaultBalance,
      depositAmount.toNumber(),
      "Vault balance should be deposit amount"
    );

    // Check maker balance (should be 0 after depositing)
    const makerBalance = await getTokenBalance(makerAtaA);
    assert.equal(makerBalance, 0, "Maker account should have no tokens left");

    console.log("✅ Make escrow test completed successfully");
  });

  it("Take escrow", async () => {
    console.log("\n🔄 Starting Take Escrow Test");

    // Log balances before take
    console.log("\n=== Before Take - Token Balances ===");
    const takerBalanceABefore = await getTokenBalance(takerAtaA);
    const takerBalanceBBefore = await getTokenBalance(takerAtaB);
    const makerBalanceBBefore = await getTokenBalance(makerAtaB);
    const vaultBalanceBefore = await getTokenBalance(vault);
    console.log(`Taker ATA A: ${takerBalanceABefore} tokens`);
    console.log(`Taker ATA B: ${takerBalanceBBefore} tokens`);
    console.log(`Maker ATA B: ${makerBalanceBBefore} tokens`);
    console.log(`Vault: ${vaultBalanceBefore} tokens`);

    // Log escrow data before take
    logEscrowData("Before Take - Escrow Account Data", escrow);

    const provider = {
      connection: {
        getAccountInfo: async (pubkey: PublicKey) => {
          const account = svm.getAccount(pubkey);
          return account
            ? {
                executable: account.executable,
                owner: account.owner,
                lamports: account.lamports,
                data: Buffer.from(account.data),
                rentEpoch: account.rentEpoch,
              }
            : null;
        },
      },
      wallet: new anchor.Wallet(taker),
    } as any;

    const program = new Program<Escrow>(
      JSON.parse(readFileSync("./target/idl/escrow.json", "utf8")),
      provider
    );

    // Create maker's ATA for mint B if it doesn't exist
    const createMakerAtaBIx = createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      makerAtaB,
      maker.publicKey,
      mintB.publicKey,
      TOKEN_PROGRAM_ID
    );
    sendTransaction([createMakerAtaBIx], []);

    // Create taker's ATA for mint A if it doesn't exist
    const createTakerAtaAIx = createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      takerAtaA,
      taker.publicKey,
      mintA.publicKey,
      TOKEN_PROGRAM_ID
    );
    sendTransaction([createTakerAtaAIx], []);

    // Build take instruction with partial accounts
    const ix = await program.methods
      .take()
      .accountsPartial({
        taker: taker.publicKey,
        maker: maker.publicKey,
        mintA: mintA.publicKey,
        mintB: mintB.publicKey,
        escrow: escrow,
        vault: vault,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const result = sendTransaction([ix], [taker]);
    console.log("Take transaction result:", result);

    // Log data after take
    logEscrowData("After Take - Escrow Account Data", escrow);

    console.log("\n=== After Take - Token Balances ===");
    const takerBalanceAAfter = await getTokenBalance(takerAtaA);
    const takerBalanceBAfter = await getTokenBalance(takerAtaB);
    const makerBalanceBAfter = await getTokenBalance(makerAtaB);
    const vaultBalanceAfter = await getTokenBalance(vault);
    console.log(
      `Taker ATA A: ${takerBalanceAAfter} tokens (change: ${
        takerBalanceAAfter - takerBalanceABefore
      })`
    );
    console.log(
      `Taker ATA B: ${takerBalanceBAfter} tokens (change: ${
        takerBalanceBAfter - takerBalanceBBefore
      })`
    );
    console.log(
      `Maker ATA B: ${makerBalanceBAfter} tokens (change: ${
        makerBalanceBAfter - makerBalanceBBefore
      })`
    );
    console.log(
      `Vault: ${vaultBalanceAfter} tokens (change: ${
        vaultBalanceAfter - vaultBalanceBefore
      })`
    );

    // Check balances after take
    const takerBalanceA = await getTokenBalance(takerAtaA);
    assert.equal(
      takerBalanceA,
      depositAmount.toNumber(),
      "Taker should have received deposit amount"
    );

    const makerBalanceB = await getTokenBalance(makerAtaB);
    assert.equal(
      makerBalanceB,
      receiveAmount.toNumber(),
      "Maker should have received requested amount"
    );

    // Verify escrow account is closed
    const escrowAccountAfter = svm.getAccount(escrow);
    console.log("Escrow account after take:", escrowAccountAfter);
    // Check if account is closed by examining owner or data
    const isClosed =
      !escrowAccountAfter ||
      escrowAccountAfter.owner.equals(SystemProgram.programId) ||
      escrowAccountAfter.data.length === 0;
    assert.ok(isClosed, "Escrow account should be closed");

    console.log("✅ Take escrow test completed successfully");
  });

  it("Make and refund escrow", async () => {
    console.log("\n↩️ Starting Make and Refund Escrow Test");

    // Create new escrow for refund test
    const newSeed = new BN(Math.floor(Math.random() * 1000000));
    const newMaker = Keypair.generate();
    const newMintA = Keypair.generate();
    const newMintB = Keypair.generate();

    // Airdrop to new maker
    svm.airdrop(newMaker.publicKey, BigInt(10 * LAMPORTS_PER_SOL));

    // Create new maker's ATA
    const newMakerAtaA = getAssociatedTokenAddressSync(
      newMintA.publicKey,
      newMaker.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );

    // Setup new tokens
    const lamports = 1461600;
    const setupInstructions: TransactionInstruction[] = [];

    setupInstructions.push(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: newMintA.publicKey,
        lamports,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: newMintB.publicKey,
        lamports,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        newMintA.publicKey,
        6,
        newMaker.publicKey,
        null,
        TOKEN_PROGRAM_ID
      ),
      createInitializeMint2Instruction(
        newMintB.publicKey,
        6,
        payer.publicKey,
        null,
        TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        newMakerAtaA,
        newMaker.publicKey,
        newMintA.publicKey,
        TOKEN_PROGRAM_ID
      ),
      createMintToInstruction(
        newMintA.publicKey,
        newMakerAtaA,
        newMaker.publicKey,
        depositAmount.toNumber(),
        [],
        TOKEN_PROGRAM_ID
      )
    );

    sendTransaction(setupInstructions, [newMintA, newMintB, newMaker]);

    // Get new PDAs
    const [newEscrow] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        newMaker.publicKey.toBuffer(),
        newSeed.toArrayLike(Buffer, "le", 8),
      ],
      programId
    );

    const newVault = getAssociatedTokenAddressSync(
      newMintA.publicKey,
      newEscrow,
      true,
      TOKEN_PROGRAM_ID
    );

    console.log("\n=== Initial Setup for Refund Test ===");
    const makerBalanceInitial = await getTokenBalance(newMakerAtaA);
    console.log(`New Maker ATA A: ${makerBalanceInitial} tokens`);

    const provider = {
      connection: {
        getAccountInfo: async (pubkey: PublicKey) => {
          const account = svm.getAccount(pubkey);
          return account
            ? {
                executable: account.executable,
                owner: account.owner,
                lamports: account.lamports,
                data: Buffer.from(account.data),
                rentEpoch: account.rentEpoch,
              }
            : null;
        },
      },
      wallet: new anchor.Wallet(newMaker),
    } as any;

    const program = new Program<Escrow>(
      JSON.parse(readFileSync("./target/idl/escrow.json", "utf8")),
      provider
    );

    // Create new escrow
    const makeIx = await program.methods
      .make(newSeed, receiveAmount, depositAmount)
      .accountsPartial({
        maker: newMaker.publicKey,
        mintA: newMintA.publicKey,
        mintB: newMintB.publicKey,
        escrow: newEscrow,
        vault: newVault,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    sendTransaction([makeIx], [newMaker]);

    // Log data after make
    logEscrowData("After Make (Refund Test) - Escrow Account Data", newEscrow);

    console.log("\n=== After Make (Refund Test) - Token Balances ===");
    const makerBalanceAfterMake = await getTokenBalance(newMakerAtaA);
    const vaultBalanceAfterMake = await getTokenBalance(newVault);
    console.log(
      `New Maker ATA A: ${makerBalanceAfterMake} tokens (change: ${
        makerBalanceAfterMake - makerBalanceInitial
      })`
    );
    console.log(`New Vault: ${vaultBalanceAfterMake} tokens`);

    // Get balance before refund
    const makerBalanceBefore = await getTokenBalance(newMakerAtaA);

    // Execute refund
    console.log("\n=== Executing Refund ===");
    const refundIx = await program.methods
      .refund()
      .accountsPartial({
        maker: newMaker.publicKey,
        mintA: newMintA.publicKey,
        escrow: newEscrow,
        vault: newVault,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const result = sendTransaction([refundIx], [newMaker]);
    console.log("Refund transaction result:", result);

    // Log data after refund
    logEscrowData("After Refund - Escrow Account Data", newEscrow);

    console.log("\n=== After Refund - Token Balances ===");
    const makerBalanceAfter = await getTokenBalance(newMakerAtaA);
    const vaultBalanceAfter = await getTokenBalance(newVault);
    console.log(
      `New Maker ATA A: ${makerBalanceAfter} tokens (change: ${
        makerBalanceAfter - makerBalanceBefore
      })`
    );
    console.log(
      `New Vault: ${vaultBalanceAfter} tokens (change: ${
        vaultBalanceAfter - vaultBalanceAfterMake
      })`
    );

    // Check maker balance after refund
    assert.equal(
      makerBalanceAfter,
      makerBalanceBefore + depositAmount.toNumber(),
      "Maker should have received refund"
    );

    // Verify escrow account is closed
    const escrowAccountAfter = svm.getAccount(newEscrow);
    console.log("Escrow account after refund:", escrowAccountAfter);
    // Check if account is closed by examining owner or data
    const isClosed =
      !escrowAccountAfter ||
      escrowAccountAfter.owner.equals(SystemProgram.programId) ||
      escrowAccountAfter.data.length === 0;
    assert.ok(isClosed, "Escrow account should be closed after refund");

    console.log("✅ Make and refund escrow test completed successfully");
  });
});
