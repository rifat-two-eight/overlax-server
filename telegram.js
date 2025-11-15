// telegram.js
require("dotenv").config();
const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN missing in .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const CHAT_IDS_FILE = path.join(__dirname, 'chatIds.json');

console.log('Telegram Bot Token:', BOT_TOKEN ? 'OK' : 'MISSING');
console.log('chatIds.json path:', CHAT_IDS_FILE);

// Create file if not exists
if (!fs.existsSync(CHAT_IDS_FILE)) {
  fs.writeFileSync(CHAT_IDS_FILE, '[]', 'utf8');
  console.log('Created chatIds.json');
}

// LOAD & SAVE HELPERS
const loadChatIds = () => {
  try {
    const data = fs.readFileSync(CHAT_IDS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('loadChatIds error:', err.message);
    return [];
  }
};

const saveChatIds = (data) => {
  try {
    fs.writeFileSync(CHAT_IDS_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log('Saved chatIds:', data);
  } catch (err) {
    console.error('saveChatIds error:', err.message);
  }
};

// /start command — CONNECT
bot.start(async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const uid = ctx.payload?.trim();

  console.log('[BOT /start] chatId:', chatId, 'uid:', uid || 'null');

  const chatIds = loadChatIds();
  const existing = chatIds.find(c => c.chatId === chatId);

  if (existing) {
    if (uid && existing.uid !== uid) {
      existing.uid = uid;
      saveChatIds(chatIds);
      await ctx.reply("Updated! You're connected.");
    }
    return;
  }

  // NEW USER
  chatIds.push({ chatId, uid: uid || "TEMP_NO_UID" });
  saveChatIds(chatIds);
  await ctx.reply("Connected! Use app to link.");
});

// /stop command — DISCONNECT (OUTSIDE bot.start!)
bot.command('stop', (ctx) => {
  const chatId = ctx.chat.id.toString();
  console.log('[BOT /stop] chatId:', chatId);

  const chatIds = loadChatIds();
  const oldCount = chatIds.length;

  const filtered = chatIds.filter(c => c.chatId !== chatId);

  if (oldCount === filtered.length) {
    ctx.reply("You weren't connected.");
    return;
  }

  saveChatIds(filtered);
  ctx.reply('Notifications stopped. Use /start to reconnect.');
  console.log('[BOT /stop] Removed → chatIds.json:', filtered);
});

// Test command
bot.command('test', (ctx) => {
  ctx.reply('Bot is ALIVE!').catch(console.error);
});

module.exports = { bot };