const { ethers } = require("ethers");
const fs = require("fs");
const readline = require("readline");
const path = require("path");
const chalk = require("chalk");

const TEA_RPC_URL = "https://tea-sepolia.g.alchemy.com/public";
const ADDRESSES_FILE = path.join(__dirname, "address.txt");
const AMOUNT_TO_SEND = "0.01";
const ADDRESSES_TO_SELECT = 200;
const INTERVAL_HOURS = 24;

const BATCH_SIZE = 20;
const DELAY_BETWEEN_TXS_MS = 2000;
const DELAY_BETWEEN_BATCHES_MS = 30000;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 10000;

let provider;

function getPrivateKey() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(chalk.cyan("Enter your private key: "), (answer) => {
      rl.close();
      let key = answer.trim();
      
      if (!key.startsWith("0x")) {
        key = "0x" + key;
      }
      
      resolve(key);
    });
  });
}

function readAddressesFromFile() {
  try {
    const fileContent = fs.readFileSync(ADDRESSES_FILE, "utf8");
    const addresses = fileContent
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && line.startsWith("0x") && line.length === 42);
    
    if (addresses.length === 0) {
      console.error(chalk.bgRed.white(" ERROR ") + " No valid addresses found in address.txt");
      process.exit(1);
    }
    
    return addresses;
  } catch (error) {
    console.error(chalk.bgRed.white(" ERROR ") + ` Error reading addresses file: ${error.message}`);
    process.exit(1);
  }
}

function selectRandomAddresses(addresses, count) {
  if (addresses.length <= count) {
    console.log(chalk.yellow(`⚠️  Not enough addresses in file. Using all ${addresses.length} available addresses.`));
    return [...addresses];
  }

  const selected = [];
  const addressesCopy = [...addresses];
  
  for (let i = 0; i < count; i++) {
    const randomIndex = Math.floor(Math.random() * addressesCopy.length);
    selected.push(addressesCopy[randomIndex]);
    addressesCopy.splice(randomIndex, 1);
  }
  
  return selected;
}

async function retryOperation(operation, maxRetries = MAX_RETRIES) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      console.log(chalk.yellow(`\n⚠️ Error on attempt ${attempt + 1}/${maxRetries}: ${error.message}`));
      
      if (error.message.includes("capacity exceeded") || 
          error.message.includes("rate limit") || 
          error.message.includes("too many requests")) {
        if (attempt < maxRetries - 1) {
          console.log(chalk.yellow(`Retrying in ${RETRY_DELAY_MS/1000} seconds...`));
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
      } else {
        throw error;
      }
    }
  }
  
  throw lastError;
}

async function processInBatches(addresses, wallet) {
  const totalBatches = Math.ceil(addresses.length / BATCH_SIZE);
  console.log(chalk.blue(`\n📦 Processing ${addresses.length} addresses in ${totalBatches} batches of ${BATCH_SIZE}`));
  
  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const startIdx = batchIdx * BATCH_SIZE;
    const endIdx = Math.min(startIdx + BATCH_SIZE, addresses.length);
    const batchAddresses = addresses.slice(startIdx, endIdx);
    
    console.log(chalk.bgCyan.black(`\n 🚀 Processing Batch ${batchIdx + 1}/${totalBatches} `));
    
    await sendTeaBatch(wallet, batchAddresses, startIdx);
    
    if (batchIdx < totalBatches - 1) {
      console.log(chalk.magenta(`\n😴 Cooling down for ${DELAY_BETWEEN_BATCHES_MS/1000} seconds before next batch...`));
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }
  }
}

async function sendTeaBatch(wallet, addresses, startIdx) {
  for (let i = 0; i < addresses.length; i++) {
    const globalIndex = startIdx + i;
    const address = addresses[i];
    
    try {
      console.log(
        chalk.cyan(`[${globalIndex + 1}/${ADDRESSES_TO_SELECT}]`) + 
        chalk.white(` Sending ${chalk.yellowBright(AMOUNT_TO_SEND)} TEA to `) + 
        chalk.green(address) + chalk.white("...")
      );
      
      await retryOperation(async () => {
        const tx = await wallet.sendTransaction({
          to: address,
          value: ethers.parseEther(AMOUNT_TO_SEND),
        });
        
        console.log(chalk.gray("⛓️  Transaction sent: ") + chalk.magenta(tx.hash));
        const receipt = await tx.wait();
        console.log(
          chalk.green("✅ Transaction confirmed in block ") + 
          chalk.whiteBright.bold(receipt.blockNumber)
        );
      });
      
      if (i < addresses.length - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_TXS_MS));
      }
    } catch (error) {
      console.error(
        chalk.bgRed.white(" FAILED ") + 
        chalk.red(` Could not send to ${address}: ${error.message}`)
      );
    }
  }
}

async function checkWalletBalance(wallet, numberOfAddresses) {
  try {
    return await retryOperation(async () => {
      const balance = await provider.getBalance(wallet.address);
      const balanceInTea = ethers.formatEther(balance);
      console.log(
        chalk.white("💰 Current wallet balance: ") + 
        chalk.yellowBright(balanceInTea) + 
        chalk.yellow(" TEA")
      );
      
      const minRequired = ethers.parseEther(AMOUNT_TO_SEND) * BigInt(numberOfAddresses);
      
      if (balance < minRequired) {
        console.error(
          chalk.bgRed.white(" LOW BALANCE ") + 
          chalk.red(` Insufficient balance for sending to ${numberOfAddresses} addresses. Need at least ${ethers.formatEther(minRequired)} TEA (excluding gas).`)
        );
        return false;
      }
      
      return true;
    });
  } catch (error) {
    console.error(chalk.bgRed.white(" ERROR ") + ` Failed to check balance: ${error.message}`);
    return false;
  }
}

async function main() {
  try {
    console.log(chalk.bgYellow.black("\n =========== IM-Hanzou | TEA Autosend Daily =========== \n"));
    
    const privateKey = await getPrivateKey();
    
    if (!privateKey || privateKey.length < 64) {
      console.error(chalk.bgRed.white(" ERROR ") + " Invalid private key format. Please provide a valid Ethereum private key.");
      process.exit(1);
    }
    
    provider = new ethers.JsonRpcProvider(TEA_RPC_URL);
    const wallet = new ethers.Wallet(privateKey, provider);
    const walletAddress = wallet.address;
    
    console.log(chalk.white("\n🔑 Wallet address: ") + chalk.greenBright(walletAddress));
    
    const hasEnoughBalance = await checkWalletBalance(wallet, ADDRESSES_TO_SELECT);
    if (!hasEnoughBalance) {
      process.exit(1);
    }
    
    const allAddresses = readAddressesFromFile();
    console.log(
      chalk.white("📋 Loaded ") + 
      chalk.greenBright(allAddresses.length) + 
      chalk.white(" addresses from address.txt")
    );
    
    console.log(chalk.bgCyan.black("\n 🚀 INITIAL RUN "));
    const selectedAddresses = selectRandomAddresses(allAddresses, ADDRESSES_TO_SELECT);
    console.log(
      chalk.white(`Selected ${chalk.greenBright(selectedAddresses.length)} addresses for sending:`)
    );
    
    selectedAddresses.slice(0, 10).forEach((addr, i) => 
      console.log(chalk.gray(`${i+1}.`) + chalk.green(` ${addr}`))
    );
    if (selectedAddresses.length > 10) {
      console.log(chalk.gray(`... and ${selectedAddresses.length - 10} more addresses`));
    }
    
    await processInBatches(selectedAddresses, wallet);
    
    console.log(
      chalk.bgGreen.black("\n ✅ COMPLETE ") + 
      chalk.green(` All transfers completed at ${new Date().toLocaleString()}`)
    );
    
    console.log(
      chalk.bgMagenta.white(`\n ⏰ Scheduling next run in ${INTERVAL_HOURS} hours `)
    );
    
    setInterval(async () => {
      try {
        console.log(
          chalk.bgYellow.black(`\n ⏱️  ${new Date().toLocaleString()} `) + 
          chalk.yellow(` Time for scheduled run`)
        );
        
        provider = new ethers.JsonRpcProvider(TEA_RPC_URL);
        const newWallet = new ethers.Wallet(privateKey, provider);
        
        const hasEnoughBalance = await checkWalletBalance(newWallet, ADDRESSES_TO_SELECT);
        if (!hasEnoughBalance) {
          return;
        }
        
        const newSelectedAddresses = selectRandomAddresses(allAddresses, ADDRESSES_TO_SELECT);
        console.log(
          chalk.white(`Selected ${chalk.greenBright(newSelectedAddresses.length)} addresses for sending:`)
        );
        
        newSelectedAddresses.slice(0, 10).forEach((addr, i) => 
          console.log(chalk.gray(`${i+1}.`) + chalk.green(` ${addr}`))
        );
        if (newSelectedAddresses.length > 10) {
          console.log(chalk.gray(`... and ${newSelectedAddresses.length - 10} more addresses`));
        }
        
        await processInBatches(newSelectedAddresses, newWallet);
        
        console.log(
          chalk.bgGreen.black("\n ✅ COMPLETE ") + 
          chalk.green(` All transfers completed at ${new Date().toLocaleString()}`)
        );
        
        const nextRunTime = new Date(Date.now() + INTERVAL_HOURS * 60 * 60 * 1000).toLocaleString();
        console.log(
          chalk.blue(`\n⏭️  Next run scheduled for ${chalk.bold(nextRunTime)}`)
        );
      } catch (error) {
        console.error(
          chalk.bgRed.white(" ERROR ") + 
          chalk.red(` Error in scheduled run: ${error.message}`)
        );
      }
    }, INTERVAL_HOURS * 60 * 60 * 1000);
    
    console.log(
      chalk.bgBlue.white("\n 🔄 RUNNING ") + 
      chalk.blue(` Script is now running and will send to ${chalk.bold(ADDRESSES_TO_SELECT)} random addresses every ${chalk.bold(INTERVAL_HOURS)} hours`)
    );
    
  } catch (error) {
    console.error(
      chalk.bgRed.white("\n ❌ FATAL ERROR ") + 
      chalk.red(` ${error.message}`)
    );
    process.exit(1);
  }
}

main();
