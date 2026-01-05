// telegram.js – UPDATED FOR MONGODB (2025 Ready)
require("dotenv").config();
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN missing in .env");
  // We don't exit here to prevent crashing the whole server if token is missing,
  // but the bot won't work.
}

let bot = null;

const launchBot = async (db) => {
  if (!BOT_TOKEN) return;

  bot = new Telegraf(BOT_TOKEN);
  const users = db.collection("users");

  console.log("🚀 Initializing Telegram Bot...");

  // /start command — CONNECT
  bot.start(async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const uid = ctx.payload?.trim(); // Payload comes from deep linking: t.me/bot?start=UID

    console.log("[BOT /start] chatId:", chatId, "uid:", uid || "null");

    if (!uid) {
      await ctx.reply(
        "👋 Welcome to Overlax!\n\nPlease use the 'Connect Telegram' button in the Overlax app to link your account."
      );
      return;
    }

    try {
      // Check if user exists with this UID
      const user = await users.findOne({ uid });

      if (!user) {
        await ctx.reply("❌ User not found. Please check your account ID.");
        return;
      }

      // Update user with telegramChatId
      await users.updateOne(
        { uid },
        { $set: { telegramChatId: chatId, telegramConnectedAt: new Date() } }
      );

      await ctx.reply("✅ Connected to Overlax! You will now receive reminders here.");
      console.log(`✅ Linked Telegram chatId ${chatId} to user ${uid}`);
    } catch (err) {
      console.error("Error in /start command:", err);
      await ctx.reply("❌ An error occurred while connecting. Please try again.");
    }
  });

  // /stop command — DISCONNECT
  bot.command("stop", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    console.log("[BOT /stop] chatId:", chatId);

    try {
      const result = await users.updateOne(
        { telegramChatId: chatId },
        { $unset: { telegramChatId: "", telegramConnectedAt: "" } }
      );

      if (result.modifiedCount > 0) {
        await ctx.reply("✅ Notifications stopped. You are disconnected.");
        console.log(`[BOT /stop] Removed chatId ${chatId} from database`);
      } else {
        await ctx.reply("❌ You weren't connected.");
      }
    } catch (err) {
      console.error("Error in /stop command:", err);
    }
  });

  // Test command
  bot.command("test", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    
    try {
      const user = await users.findOne({ telegramChatId: chatId });
      const isConnected = !!user;

      const message = `🤖 Bot is ALIVE!\n\nYour chatId: ${chatId}\nConnected to Overlax: ${
        isConnected ? "Yes ✅" : "No ❌"
      }${isConnected ? `\nUser UID: ${user.uid}` : ""}\n\nTry /start to connect!`;
      
      await ctx.reply(message);
    } catch (err) {
      console.error("Error in /test command:", err);
    }
  });

  // Launch Bot
  bot
    .launch({
      dropPendingUpdates: true,
    })
    .then(() => {
      console.log("✅ Telegram Bot LAUNCHED SUCCESSFULLY");
    })
    .catch((err) => {
      console.error("❌ Bot launch error:", err.message);
      if (err.code === 409) {
        console.log(
          "⚠️ 409 Conflict detected – another instance is running."
        );
      }
    });

  // Graceful Shutdown
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
};

module.exports = { launchBot };

