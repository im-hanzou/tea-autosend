const { ethers } = require("ethers");
const fs = require("fs");
const readline = require("readline");
const path = require("path");
const chalk = require("chalk");

const TEA_RPC_URL = "https://tea-sepolia.g.alchemy.com/public";
const ADDRESSES_FILE = path.join(__dirname, "address.txt");
const CURRENT_LINE_FILE = path.join(__dirname, "current_line.txt");
const AMOUNT_TO_SEND = "0.01";
const ADDRESSES_TO_SELECT = 200;
const INTERVAL_HOURS = 24;

const BATCH_SIZE = 20;
const DELAY_BETWEEN_TXS_MS = 2000;
const DELAY_BETWEEN_BATCHES_MS = 30000;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 10000;

let currentLineIndex = 0;
let provider;
let totalAddressLines = 0;

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
    const entries = fileContent
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && line.includes(","));
    
    const parsedEntries = entries.map(entry => {
      const [username, address] = entry.split(",");
      return { username: username.trim(), address: address.trim() };
    }).filter(entry => entry.address && entry.address.startsWith("0x") && entry.address.length === 42);
    
    if (parsedEntries.length === 0) {
      console.error(chalk.bgRed.white(" ERROR ") + " No valid address entries found in address.txt");
      process.exit(1);
    }
    
    totalAddressLines = parsedEntries.length;
    return parsedEntries;
  } catch (error) {
    console.error(chalk.bgRed.white(" ERROR ") + ` Error reading addresses file: ${error.message}`);
    process.exit(1);
  }
}

function selectSequentialAddresses(addressEntries, count, walletAddress, startIndex) {
  const filteredEntries = addressEntries.filter(entry => entry.address.toLowerCase() !== walletAddress.toLowerCase());
  
  if (filteredEntries.length === 0) {
    console.error(chalk.bgRed.white(" ERROR ") + " No valid addresses to send to after filtering out your own address");
    process.exit(1);
  }
  
  const selected = [];
  let currentIndex = startIndex % filteredEntries.length;
  
  for (let i = 0; i < count; i++) {
    selected.push(filteredEntries[currentIndex]);
    currentIndex = (currentIndex + 1) % filteredEntries.length;
    if (currentIndex === startIndex % filteredEntries.length && i < count - 1) {
      console.log(chalk.yellow(`⚠️  Reached end of address list, starting over from the beginning.`));
    }
  }
  
  currentLineIndex = currentIndex;
  
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

async function processInBatches(addressEntries, wallet) {
  const totalBatches = Math.ceil(addressEntries.length / BATCH_SIZE);
  console.log(chalk.blue(`\n📦 Processing ${addressEntries.length} addresses in ${totalBatches} batches of ${BATCH_SIZE}`));
  
  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const startIdx = batchIdx * BATCH_SIZE;
    const endIdx = Math.min(startIdx + BATCH_SIZE, addressEntries.length);
    const batchEntries = addressEntries.slice(startIdx, endIdx);
    
    console.log(chalk.bgCyan.black(`\n 🚀 Processing Batch ${batchIdx + 1}/${totalBatches} `));
    
    await sendTeaBatch(wallet, batchEntries, startIdx);
    
    if (batchIdx < totalBatches - 1) {
      console.log(chalk.magenta(`\n😴 Cooling down for ${DELAY_BETWEEN_BATCHES_MS/1000} seconds before next batch...`));
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }
  }
}

async function sendTeaBatch(wallet, addressEntries, startIdx) {
  for (let i = 0; i < addressEntries.length; i++) {
    const globalIndex = startIdx + i;
    const { username, address } = addressEntries[i];
    
    try {
      const originalStartIndex = currentLineIndex - addressEntries.length;
      const addressLineNumber = (originalStartIndex + globalIndex + 1) % totalAddressLines;
      const displayLineNumber = addressLineNumber === 0 ? totalAddressLines : addressLineNumber;
      
      console.log(
        chalk.cyan(`[${displayLineNumber}/${totalAddressLines}]`) + 
        chalk.white(` Sending ${chalk.yellowBright(AMOUNT_TO_SEND)} TEA to `) + 
        chalk.blue(`${username}`) + 
        chalk.white(" at ") +
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
      
      if (i < addressEntries.length - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_TXS_MS));
      }
    } catch (error) {
      console.error(
        chalk.bgRed.white(" FAILED ") + 
        chalk.red(` Could not send to ${username} (${address}): ${error.message}`)
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

function saveCurrentLineIndex() {
  try {
    fs.writeFileSync(CURRENT_LINE_FILE, currentLineIndex.toString(), "utf8");
    console.log(chalk.gray(`📝 Saved current line (${currentLineIndex}) to ${CURRENT_LINE_FILE}`));
  } catch (error) {
    console.warn(chalk.yellow(`⚠️ Could not save current line: ${error.message}`));
  }
}

function loadCurrentLineIndex() {
  try {
    if (fs.existsSync(CURRENT_LINE_FILE)) {
      const savedIndex = parseInt(fs.readFileSync(CURRENT_LINE_FILE, "utf8").trim());
      if (!isNaN(savedIndex)) {
        currentLineIndex = savedIndex;
        return savedIndex;
      }
    }
  } catch (error) {
    console.warn(chalk.yellow(`⚠️ Could not load current lines: ${error.message}`));
  }
  return 0;
}

async function scheduledRun(privateKey) {
  provider = new ethers.JsonRpcProvider(TEA_RPC_URL);
  const newWallet = new ethers.Wallet(privateKey, provider);
  
  console.log(chalk.bgYellow.black(`\n ⏱️  ${new Date().toLocaleString()} `) + chalk.yellow(` Starting scheduled run`));
  
  const refreshedAddressEntries = readAddressesFromFile();
  console.log(chalk.white("📍 Continuing from line: ") + chalk.yellowBright(currentLineIndex));
  
  const newSelectedEntries = selectSequentialAddresses(refreshedAddressEntries, ADDRESSES_TO_SELECT, newWallet.address, currentLineIndex);
  
  const hasEnoughBalance = await checkWalletBalance(newWallet, newSelectedEntries.length);
  if (!hasEnoughBalance) {
    console.log(chalk.red(`❌ Insufficient balance for scheduled run! Please claim faucet!. Will try again in 1 minute`));
    setTimeout(() => scheduledRun(privateKey), 60000);
    return;
  }
  
  console.log(chalk.white(`Selected ${chalk.greenBright(newSelectedEntries.length)} addresses for sending:`));
  
  newSelectedEntries.slice(0, 10).forEach((entry, i) => 
    console.log(chalk.gray(`${i+1}.`) + chalk.blue(` ${entry.username}`) + chalk.gray(` (${entry.address})`))
  );
  if (newSelectedEntries.length > 10) {
    console.log(chalk.gray(`... and ${newSelectedEntries.length - 10} more addresses`));
  }
  
  await processInBatches(newSelectedEntries, newWallet);
  
  saveCurrentLineIndex();
  
  console.log(chalk.bgGreen.black("\n ✅ COMPLETE ") + chalk.green(` All transfers completed at ${new Date().toLocaleString()}`));
  
  const nextRunTime = new Date(Date.now() + INTERVAL_HOURS * 60 * 60 * 1000).toLocaleString();
  console.log(chalk.blue(`\n⏭️  Next run scheduled for ${chalk.bold(nextRunTime)}`));
  
  setTimeout(() => scheduledRun(privateKey), INTERVAL_HOURS * 60 * 60 * 1000);
}

async function main() {
  try {
    console.log(chalk.cyan(`
╔═══════════════════════════════════════════════╗
║        sepolia.app.tea.xyz - AutoTXs          ║
║     Github: https://github.com/im-hanzou      ║
╚═══════════════════════════════════════════════╝
`));
    
    const startIndex = loadCurrentLineIndex();
    console.log(chalk.white("📍 Starting from line: ") + chalk.yellowBright(startIndex));
    
    const privateKey = await getPrivateKey();
    
    if (!privateKey || privateKey.length < 64) {
      console.error(chalk.bgRed.white(" ERROR ") + " Invalid private key format. Please provide a valid Ethereum private key.");
      process.exit(1);
    }
    
    provider = new ethers.JsonRpcProvider(TEA_RPC_URL);
    const wallet = new ethers.Wallet(privateKey, provider);
    const walletAddress = wallet.address;
    
    console.log(chalk.white("\n🔑 Wallet address: ") + chalk.greenBright(walletAddress));
    
    const allAddressEntries = readAddressesFromFile();
    console.log(
      chalk.white("📋 Loaded ") + 
      chalk.greenBright(allAddressEntries.length) + 
      chalk.white(" address entries from address.txt")
    );
    
    console.log(chalk.bgCyan.black("\n 🚀 INITIAL RUN "));
    const selectedEntries = selectSequentialAddresses(allAddressEntries, ADDRESSES_TO_SELECT, walletAddress, startIndex);
    console.log(
      chalk.white(`Selected ${chalk.greenBright(selectedEntries.length)} addresses for sending:`)
    );
    
    const hasEnoughBalance = await checkWalletBalance(wallet, selectedEntries.length);
    if (!hasEnoughBalance) {
        console.log(chalk.red(`❌ Insufficient balance! Please claim faucet!. Will try again in 1 minute`));
        setTimeout(() => scheduledRun(privateKey), 60000);
        return;
    }
    
    selectedEntries.slice(0, 10).forEach((entry, i) => 
      console.log(chalk.gray(`${i+1}.`) + chalk.blue(` ${entry.username}`) + chalk.gray(` (${entry.address})`))
    );
    if (selectedEntries.length > 10) {
      console.log(chalk.gray(`... and ${selectedEntries.length - 10} more addresses`));
    }
    
    await processInBatches(selectedEntries, wallet);
    
    saveCurrentLineIndex();
    
    console.log(
      chalk.bgGreen.black("\n ✅ COMPLETE ") + 
      chalk.green(` All transfers completed at ${new Date().toLocaleString()}`)
    );
    
    console.log(
      chalk.bgMagenta.white(`\n ⏰ Scheduling next run in ${INTERVAL_HOURS} hours `)
    );
    
    const nextRunTime = new Date(Date.now() + INTERVAL_HOURS * 60 * 60 * 1000).toLocaleString();
    console.log(chalk.blue(`\n⏭️  Next run scheduled for ${chalk.bold(nextRunTime)}`));
    
    setTimeout(() => scheduledRun(privateKey), INTERVAL_HOURS * 60 * 60 * 1000);
    
    console.log(
      chalk.bgBlue.white("\n 🔄 RUNNING ") + 
      chalk.blue(` Script is now running and will send to ${chalk.bold(ADDRESSES_TO_SELECT)} sequential addresses every ${chalk.bold(INTERVAL_HOURS)} hours`)
    );
    
    process.on('uncaughtException', (error) => {
      console.error(chalk.bgRed.white(" UNCAUGHT EXCEPTION ") + chalk.red(` ${error.message}`));
      setTimeout(() => scheduledRun(privateKey), 60000);
    });
    
    process.on('unhandledRejection', (reason) => {
      console.error(chalk.bgRed.white(" UNHANDLED REJECTION ") + chalk.red(` ${reason}`));
      setTimeout(() => scheduledRun(privateKey), 60000);
    });
    
  } catch (error) {
    console.error(
      chalk.bgRed.white("\n ❌ FATAL ERROR ") + 
      chalk.red(` ${error.message}`)
    );
    process.exit(1);
  }
}

main();
