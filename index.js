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

// GLOBAL FOR IN-MEMORY NOTIFIED TASKS (cleared on restart – fine for reminders)
global.notifiedTasks = global.notifiedTasks || [];

// MIDDLEWARE
app.use(cors({
  origin: true, // Allow all in production; adjust if needed
  credentials: true
}));
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

    // START TELEGRAM BOT ONLY AFTER DB IS READY
    const { bot } = require("./telegram");
    bot.telegram.getMe()
      .then(me => {
        console.log(`Bot @${me.username} authenticated`);
        bot.launch();
        console.log("Telegram Bot LIVE & Listening");
      })
      .catch(err => {
        console.error("Invalid Telegram Bot Token:", err.message);
        process.exit(1);
      });

  } catch (err) {
    console.error("MongoDB Connection Failed:", err);
    process.exit(1);
  }
}

// COLLECTIONS (safe access)
const users = () => app.locals.db.collection("users");
const tasks = () => app.locals.db.collection("tasks");
const categories = () => app.locals.db.collection("categories");

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
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "No token" });

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

app.get("/", (req, res) => res.json({ message: "Overlax API Running", time: new Date().toISOString() }));

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

// FIXED CRON JOB – NO LOCALHOST, USES DB DIRECTLY
cron.schedule("* * * * *", async () => {
  if (!dbInstance) {
    console.log("DB not ready, skipping cron tick");
    return;
  }

  try {
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
    console.error("Cron error:", err);
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
    await categories().updateOne(
      { name: cat.name },
      { $setOnInsert: cat },
      { upsert: true }
    );
  }
}

// GOOGLE CALENDAR HELPERS
async function createGoogleEvent(uid, task) {
  const user = await users().findOne({ uid });
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
    await tasks().updateOne(
      { _id: task._id },
      { $set: { googleEventId: res.data.id } }
    );
  } catch (err) {
    console.error("Google Create Failed:", err.response?.data || err.message);
  }
}

async function updateGoogleEvent(uid, task) {
  const user = await users().findOne({ uid });
  if (!user?.googleTokens || !task.googleEventId) return;

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
    await calendar.events.patch({
      calendarId: "primary",
      eventId: task.googleEventId,
      resource: event,
    });
  } catch (err) {
    console.error("Google Update Failed:", err.response?.data || err.message);
  }
}

async function deleteGoogleEvent(uid, googleEventId) {
  const user = await users().findOne({ uid });
  if (!user?.googleTokens || !googleEventId) return;

  oauth2Client.setCredentials(user.googleTokens);
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  try {
    await calendar.events.delete({ calendarId: "primary", eventId: googleEventId });
  } catch (err) {
    console.error("Google Delete Failed:", err.message);
  }
}

// TASK ROUTES
app.get("/api/tasks/:uid", verifyToken, async (req, res) => {
  const { uid } = req.params;
  if (req.user.uid !== uid) return res.status(403).json({ error: "Forbidden" });
  const userTasks = await tasks().find({ uid }).toArray();
  res.json({ tasks: userTasks });
});

app.post("/api/tasks", verifyToken, upload.single("file"), async (req, res) => {
  const { uid, title, category, deadline } = req.body;
  if (!uid || !title || !category || !deadline) return res.status(400).json({ error: "Missing fields" });

  let finalDeadline = deadline;
  if (!deadline.includes("T")) finalDeadline += "T09:00:00";

  const fileInfo = req.file ? {
    name: req.file.filename,
    originalName: req.file.originalname,
    type: req.file.mimetype,
    path: `/uploads/${req.file.filename}`
  } : null;

  const result = await tasks().insertOne({
    uid,
    title,
    category,
    deadline: finalDeadline,
    file: fileInfo,
    createdAt: new Date()
  });

  const newTask = { _id: result.insertedId, uid, title, category, deadline: finalDeadline, file: fileInfo };
  await createGoogleEvent(uid, newTask);

  res.json({ taskId: result.insertedId });
});

app.patch("/api/tasks/:id", verifyToken, upload.single("file"), async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });

  const currentTask = await tasks().findOne({ _id: new ObjectId(id), uid: req.user.uid });
  if (!currentTask) return res.status(404).json({ error: "Task not found" });

  const { title, category, deadline } = req.body;
  let finalDeadline = deadline;
  if (!deadline.includes("T")) finalDeadline += "T09:00:00";

  const fileInfo = req.file ? {
    name: req.file.filename,
    originalName: req.file.originalname,
    type: req.file.mimetype,
    path: `/uploads/${req.file.filename}`
  } : currentTask.file;

  const oldFilePath = req.file && currentTask.file?.path ? path.join(__dirname, currentTask.file.path) : null;

  await tasks().updateOne(
    { _id: new ObjectId(id) },
    { $set: { title, category, deadline: finalDeadline, file: fileInfo, updatedAt: new Date() } }
  );

  const updatedTask = { ...currentTask, _id: new ObjectId(id), title, category, deadline: finalDeadline, file: fileInfo };
  await updateGoogleEvent(req.user.uid, updatedTask);

  if (oldFilePath && fs.existsSync(oldFilePath)) {
    fs.unlink(oldFilePath, () => {});
  }

  res.json({ success: true });
});

app.delete("/api/tasks/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });

  const task = await tasks().findOne({ _id: new ObjectId(id), uid: req.user.uid });
  if (!task) return res.status(404).json({ error: "Not found" });

  await deleteGoogleEvent(req.user.uid, task.googleEventId);
  await tasks().deleteOne({ _id: new ObjectId(id) });

  if (task.file?.path) {
    const filePath = path.join(__dirname, task.file.path);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  }

  res.json({ success: true });
});

// CATEGORY ROUTES (simplified – add more as needed)
app.get("/api/categories/:uid", verifyToken, async (req, res) => {
  const { uid } = req.params;
  const cats = await categories().find({ $or: [{ uid }, { uid: { $exists: false } }] }).toArray();
  res.json({ categories: cats });
});

// GOOGLE AUTH ROUTES
app.get("/api/auth/google", verifyToken, (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    state: JSON.stringify({ uid: req.user.uid }),
    prompt: "consent"
  });
  res.json({ url });
});

app.get("/api/auth/google/callback", async (req, res) => {
  const { code, state } = req.query;
  const { uid } = JSON.parse(state || "{}");
  if (!code || !uid) return res.status(400).send("Invalid request");

  try {
    const { tokens } = await oauth2Client.getToken(code);
    await users().updateOne({ uid }, { $set: { googleTokens: tokens } }, { upsert: true });
    res.send(`<script>window.opener.postMessage('google-auth-success', '*');window.close();</script>`);
  } catch (err) {
    console.error("Google Auth Error:", err);
    res.status(500).send("Authentication failed");
  }
});

app.delete("/api/auth/google", verifyToken, async (req, res) => {
  await users().updateOne({ uid: req.user.uid }, { $unset: { googleTokens: "" } });
  res.json({ success: true });
});

// USER PROFILE
app.post("/api/user/profile", verifyToken, async (req, res) => {
  const { uid, email, displayName, photoURL } = req.body;
  await users().updateOne(
    { uid },
    { $set: { email, displayName, photoURL, updatedAt: new Date() } },
    { upsert: true }
  );
  res.json({ success: true });
});

app.get("/api/user/profile", verifyToken, async (req, res) => {
  const user = await users().findOne({ uid: req.user.uid });
  res.json({ googleTokens: user?.googleTokens || null });
});

// START EVERYTHING
connectDB();

// CRITICAL: LISTEN ON RENDER'S PORT
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server LIVE on port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
});

// Graceful shutdown
process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));