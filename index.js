// server/index.js
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");
const axios = require("axios");
require("dotenv").config();
const cron = require("node-cron");
const { oauth2Client } = require("./utils/auth");
const admin = require("./utils/firebaseAdmin");

const app = express();
const PORT = process.env.PORT || 5000;

// GLOBAL FOR IN-MEMORY NOTIFIED TASKS
global.notifiedTasks = global.notifiedTasks || [];

// MIDDLEWARE
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// UPLOADS FOLDER
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
    cb(null, safeName);
  }
});
const upload = multer({ storage });
app.use("/uploads", express.static(uploadsDir));

// MONGODB CONNECTION
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let dbInstance = null;

async function connectDB() {
  try {
    await client.connect();
    dbInstance = client.db("overlax");
    app.locals.db = dbInstance;
    console.log("MongoDB Connected Successfully");

    await seedDefaultCategories();

    // START TELEGRAM BOT AFTER DB IS READY
    try {
      const { bot } = require("./telegram");
      bot.telegram.getMe()
        .then(me => {
          console.log(`Bot @${me.username} authenticated`);
          bot.launch();
          console.log("Telegram Bot LIVE & Listening");
        })
        .catch(err => {
          console.error("Telegram Bot Token Invalid:", err.message);
        });
    } catch (err) {
      console.error("Telegram Bot Init Failed:", err.message);
    }

  } catch (err) {
    console.error("MongoDB Connection Failed:", err);
    // Do not exit, keep server alive
  }
}

// COLLECTION HELPERS
const users = () => app.locals.db?.collection("users");
const tasks = () => app.locals.db?.collection("tasks");
const categories = () => app.locals.db?.collection("categories");

// CHAT IDS HELPER
const getChatIds = () => {
  const CHAT_IDS_FILE = path.join(__dirname, "chatIds.json");
  try {
    if (fs.existsSync(CHAT_IDS_FILE)) {
      const data = fs.readFileSync(CHAT_IDS_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("getChatIds error:", err.message);
  }
  return [];
};

// TOKEN VERIFY MIDDLEWARE
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "No token" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("Token Error:", err.message);
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ROUTES
const userRoutes = require("./routes/user");
const aiRoutes = require("./routes/ai");
app.use("/api/user", userRoutes);
app.use("/api/ai", aiRoutes);

app.get("/", (req, res) =>
  res.json({ message: "Overlax API Running", time: new Date().toISOString() })
);

// TELEGRAM NOTIFICATION
const sendTelegramNotification = async (task, taskUid) => {
  const chatIds = getChatIds();
  const userChatIds = chatIds.filter(c => c.uid === taskUid).map(c => c.chatId);
  if (userChatIds.length === 0) return;

  const message = `REMINDER: "${task.title}"\nCategory: ${task.category}\nDue: ${new Date(task.deadline).toLocaleString()}`;

  for (const chatId of userChatIds) {
    try {
      await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: message,
      });
    } catch (err) {
      console.error("Telegram send failed:", err.response?.data || err.message);
    }
  }
};

// CRON JOB
cron.schedule("* * * * *", async () => {
  if (!dbInstance) return console.log("DB not ready, skipping cron tick");

  try {
    console.log("Cron tick at", new Date().toISOString());
    const now = new Date();
    const twoMinsLater = new Date(now.getTime() + 2 * 60 * 1000);
    const allUsers = await users().find({}).toArray();

    for (const user of allUsers) {
      const userTasks = await tasks().find({ uid: user.uid }).toArray();
      for (const task of userTasks) {
        const deadline = new Date(task.deadline);
        const taskId = task._id.toString();

        if (
          deadline > now &&
          deadline <= twoMinsLater &&
          !global.notifiedTasks.includes(taskId)
        ) {
          await sendTelegramNotification(task, user.uid);
          global.notifiedTasks.push(taskId);
        }
      }
    }
  } catch (err) {
    console.error("Cron error:", err.message, err.stack);
  }
});

// TELEGRAM STATUS CHECK
app.get("/api/telegram/status/:uid", (req, res) => {
  const { uid } = req.params;
  const chatIds = getChatIds();
  const connected = chatIds.some(c => c.uid === uid);
  res.json({ connected });
});

// SEED DEFAULT CATEGORIES
async function seedDefaultCategories() {
  const defaults = [
    { name: "Academic", icon: "book" },
    { name: "Personal", icon: "user" },
    { name: "Work", icon: "briefcase" },
  ];
  for (const cat of defaults) {
    await categories()?.updateOne(
      { name: cat.name },
      { $setOnInsert: cat },
      { upsert: true }
    );
  }
}

// GOOGLE CALENDAR HELPERS
async function createGoogleEvent(uid, task) {
  const user = await users()?.findOne({ uid });
  if (!user?.googleTokens) return;

  oauth2Client.setCredentials(user.googleTokens);
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  let deadline = task.deadline;
  if (!deadline.includes("T")) deadline += "T09:00:00";
  const start = new Date(deadline);
  if (isNaN(start)) return;
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const event = {
    summary: task.title,
    description: `Category: ${task.category}\nOverlax Task ID: ${task._id}\nFile: ${task.file?.originalName || "None"}`,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  };

  try {
    const res = await calendar.events.insert({ calendarId: "primary", resource: event });
    await tasks()?.updateOne({ _id: task._id }, { $set: { googleEventId: res.data.id } });
  } catch (err) {
    console.error("Google Create Failed:", err.response?.data || err.message);
  }
}

// START SERVER FIRST, THEN CONNECT DB
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server LIVE on port ${PORT}`);
  connectDB();
});

// Graceful shutdown
process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
