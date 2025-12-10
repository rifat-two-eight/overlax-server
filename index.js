// server/index.js
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
require("dotenv").config();
const admin = require("./utils/firebaseAdmin");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 5000;

// GLOBAL FOR IN-MEMORY NOTIFIED TASKS
global.notifiedTasks = global.notifiedTasks || [];

// MIDDLEWARE - MUST BE BEFORE ROUTES!
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
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
  },
});
const upload = multer({ storage });
app.use("/uploads", express.static(uploadsDir));

// File serve route (uploads folder er jonno)
app.use("/uploads", (req, res, next) => {
  const filePath = path.join(__dirname, "uploads", req.path);

  // Auto detect MIME type
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };

  if (mimeTypes[ext]) {
    res.setHeader("Content-Type", mimeTypes[ext]);
  }

  express.static(path.join(__dirname, "uploads"))(req, res, next);
});

// MONGODB CONNECTION
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let dbInstance = null;

async function connectDB() {
  try {
    await client.connect();
    dbInstance = client.db("overlax");
    app.locals.db = dbInstance;

    await seedDefaultCategories();

    // START TELEGRAM BOT
    const { bot } = require("./telegram");
    bot.telegram
      .getMe()
      .then((me) => {
        console.log(`✅ Bot @${me.username} authenticated`);
      })
      .catch((err) => {
        console.error("❌ Invalid Telegram Bot Token:", err.message);
      });
  } catch (err) {
    console.error("❌ MongoDB Connection Failed:", err);
    process.exit(1);
  }
}

app.post(
  "/api/upload-avatar",
  verifyToken,
  upload.single("file"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file" });

    const avatarUrl = `${req.protocol}://${req.get("host")}/uploads/${
      req.file.filename
    }`;

    await users().updateOne(
      { uid: req.user.uid },
      { $set: { photoURL: avatarUrl } }
    );

    res.json({ url: avatarUrl });
  }
);

// COLLECTIONS
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
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    console.log("✅ Token verified for user:", decoded.uid);
    next();
  } catch (err) {
    console.error("❌ Token verification failed:", err.message);
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ROOT ROUTE
app.get("/", (req, res) => {
  res.json({
    message: "Overlax API Running",
    time: new Date().toISOString(),
    endpoints: {
      tasks: "/api/tasks/:uid",
      categories: "/api/categories/:uid",
      user: "/api/user/profile",
    },
  });
});

// IMPORT OTHER ROUTES
const userRoutes = require("./routes/user");
const aiRoutes = require("./routes/ai");
app.use("/api/user", userRoutes);
app.use("/api/ai", aiRoutes);

// TELEGRAM NOTIFICATION - FIXED VERSION
const sendTelegramNotification = async (task, taskUid) => {
  const chatIds = getChatIds();
  const userChatIds = chatIds
    .filter((c) => c.uid === taskUid)
    .map((c) => c.chatId);

  console.log(`🔔 Checking Telegram for user ${taskUid}:`, {
    totalChats: chatIds.length,
    userChats: userChatIds.length,
  });

  if (userChatIds.length === 0) {
    console.log(`⚠️ No Telegram chat IDs found for user ${taskUid}`);
    return;
  }

  const message = `⏰ REMINDER: "${task.title}"\n📋 Category: ${
    task.category
  }\n📅 Due: ${new Date(task.deadline).toLocaleString()}`;

  for (const chatId of userChatIds) {
    try {
      console.log(`📤 Sending notification to chatId: ${chatId}`);
      await axios.post(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        { chat_id: chatId, text: message }
      );
      console.log(`✅ Notification sent successfully to ${chatId}`);
    } catch (err) {
      console.error(
        `❌ Telegram send failed for ${chatId}:`,
        err.response?.data || err.message
      );
    }
  }
};

// IMPROVED REMINDER CHECK FUNCTION
async function triggerReminderCheck() {
  if (!dbInstance) {
    console.log("⚠️ DB not ready, skipping reminder check");
    return;
  }

  try {
    const now = new Date();
    // Check for tasks within next 2 minutes (120 seconds)
    const twoMinsLater = new Date(now.getTime() + 2 * 60 * 1000);

    console.log(`🔍 Checking reminders at ${now.toLocaleString()}`);
    console.log(
      `📅 Time window: ${now.toLocaleString()} to ${twoMinsLater.toLocaleString()}`
    );

    const allUsers = await users().find({}).toArray();
    console.log(`👥 Found ${allUsers.length} total users`);

    let notificationsSent = 0;

    for (const user of allUsers) {
      const userTasks = await tasks()
        .find({ uid: user.uid, completed: false })
        .toArray();

      console.log(
        `📋 User ${user.uid} has ${userTasks.length} incomplete tasks`
      );

      for (const task of userTasks) {
        const deadline = new Date(task.deadline);
        const taskId = task._id.toString();

        // DETAILED LOGGING FOR EACH TASK
        console.log(`\n📝 Checking task: "${task.title}"`);
        console.log(`   Task ID: ${taskId}`);
        console.log(`   Deadline (raw): ${task.deadline}`);
        console.log(`   Deadline (parsed): ${deadline.toLocaleString()}`);
        console.log(`   Current time: ${now.toLocaleString()}`);
        console.log(`   Window end: ${twoMinsLater.toLocaleString()}`);
        console.log(`   Is future? ${deadline > now}`);
        console.log(`   Is within 2 min? ${deadline <= twoMinsLater}`);
        console.log(
          `   Already notified? ${global.notifiedTasks.includes(taskId)}`
        );

        // Check if deadline is within the 2-minute window
        const isInWindow = deadline > now && deadline <= twoMinsLater;
        const notAlreadySent = !global.notifiedTasks.includes(taskId);

        if (isInWindow && notAlreadySent) {
          console.log(
            `🚨 MATCH FOUND! Task: "${
              task.title
            }" | Deadline: ${deadline.toLocaleString()}`
          );

          await sendTelegramNotification(task, user.uid);
          global.notifiedTasks.push(taskId);
          notificationsSent++;

          console.log(`✅ Notification sent for task: ${taskId}`);
        } else if (isInWindow && !notAlreadySent) {
          console.log(`⏭️ Task "${task.title}" already notified`);
        } else {
          console.log(`❌ Task does NOT match criteria`);
        }
      }
    }

    console.log(
      `📊 Reminder check complete. Sent ${notificationsSent} notifications.`
    );
    console.log(
      `📝 Total notified tasks in memory: ${global.notifiedTasks.length}`
    );
  } catch (err) {
    console.error("❌ Reminder check error:", err);
  }
}

// CONNECT TELEGRAM ROUTE
app.post("/api/connect-telegram", verifyToken, (req, res) => {
  const { chatId } = req.body;
  const uid = req.user.uid;

  console.log(`🔗 Connect Telegram request: uid=${uid}, chatId=${chatId}`);

  if (!chatId) {
    return res.status(400).json({ error: "chatId required" });
  }

  const CHAT_IDS_FILE = path.join(__dirname, "chatIds.json");
  const chatIds = getChatIds();

  if (chatIds.some((c) => c.chatId === chatId)) {
    console.log(`⚠️ Chat ID ${chatId} already connected`);
    return res.status(400).json({ error: "Already connected" });
  }

  chatIds.push({ uid, chatId });
  fs.writeFileSync(CHAT_IDS_FILE, JSON.stringify(chatIds, null, 2));

  console.log("✅ Telegram connected:", { uid, chatId });
  console.log("📋 Updated chatIds.json:", chatIds);

  res.json({ success: true });
});

// CRON JOB - RUN EVERY MINUTE FOR CHECKING REMINDERS
cron.schedule("* * * * *", async () => {
  console.log("⏰ [CRON] Running reminder check...", new Date().toISOString());
  await triggerReminderCheck();
});

// Self-ping cron job - server awake rakhbe (every 10 minutes)
cron.schedule("*/10 * * * *", async () => {
  console.log(
    "🏓 Self-ping: Keeping server awake...",
    new Date().toISOString()
  );
  try {
    await axios.get(
      `${process.env.RENDER_EXTERNAL_URL || "http://localhost:5000"}/api/ping`
    );
  } catch (err) {
    console.log("⚠️ Self-ping failed (expected):", err.message);
  }
});

// Simple ping route
app.get("/api/ping", (req, res) => {
  console.log("🏓 Ping received - server awake!");
  res.json({ status: "alive", time: new Date().toISOString() });
});

// MANUAL REMINDER CHECK ENDPOINT (for testing)
app.get("/api/reminder-ping", async (req, res) => {
  console.log("🚨 Manual reminder check requested!", new Date().toISOString());

  try {
    await triggerReminderCheck();

    console.log("✅ Manual reminder check completed!");
    res.json({
      success: true,
      message: "Reminder check done",
      notifiedTasks: global.notifiedTasks?.length || 0,
      time: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Manual reminder check failed:", err);
    res.status(500).json({
      success: false,
      error: "Reminder check failed",
      details: err.message,
    });
  }
});

// TELEGRAM STATUS
app.get("/api/telegram/status/:uid", (req, res) => {
  const { uid } = req.params;
  const chatIds = getChatIds();
  const connected = chatIds.some((c) => c.uid === uid);

  console.log(`🔍 Telegram status check for ${uid}:`, {
    connected,
    totalConnections: chatIds.length,
  });

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

// ============================================
// TASK ROUTES
// ============================================

app.get("/api/tasks/:uid", verifyToken, async (req, res) => {
  try {
    const { uid } = req.params;
    if (req.user.uid !== uid) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const userTasks = await tasks().find({ uid }).toArray();
    res.json({ tasks: userTasks });
  } catch (err) {
    console.error("Get tasks error:", err);
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

app.post("/api/tasks", verifyToken, upload.single("file"), async (req, res) => {
  try {
    const { uid, title, category, deadline } = req.body;

    if (!uid || !title || !category || !deadline) {
      return res.status(400).json({ error: "Missing fields" });
    }

    let finalDeadline = deadline;
    if (!deadline.includes("T")) finalDeadline += "T09:00:00";

    const fileInfo = req.file
      ? {
          name: req.file.filename,
          originalName: req.file.originalname,
          type: req.file.mimetype,
          path: `/uploads/${req.file.filename}`,
        }
      : null;

    const result = await tasks().insertOne({
      uid,
      title,
      category,
      deadline: finalDeadline,
      file: fileInfo,
      completed: false,
      createdAt: new Date(),
    });

    console.log("✅ Task created:", result.insertedId);
    res.json({ taskId: result.insertedId });
  } catch (err) {
    console.error("Create task error:", err);
    res.status(500).json({ error: "Failed to create task" });
  }
});

app.patch(
  "/api/tasks/:id",
  verifyToken,
  upload.single("file"),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid ID" });
      }

      const currentTask = await tasks().findOne({
        _id: new ObjectId(id),
        uid: req.user.uid,
      });

      if (!currentTask) {
        return res.status(404).json({ error: "Task not found" });
      }

      const { title, category, deadline } = req.body;
      let finalDeadline = deadline;
      if (deadline && !deadline.includes("T")) {
        finalDeadline = deadline + "T00:00:00.000Z";
      } else if (deadline) {
        finalDeadline = new Date(deadline).toISOString();
      }
      const fileInfo = req.file
        ? {
            name: req.file.filename,
            originalName: req.file.originalname,
            type: req.file.mimetype,
            path: `/uploads/${req.file.filename}`,
          }
        : currentTask.file;

      const oldFilePath =
        req.file && currentTask.file?.path
          ? path.join(__dirname, currentTask.file.path)
          : null;

      await tasks().updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            title,
            category,
            deadline: finalDeadline,
            file: fileInfo,
            updatedAt: new Date(),
          },
        }
      );

      if (oldFilePath && fs.existsSync(oldFilePath)) {
        fs.unlink(oldFilePath, () => {});
      }

      console.log("✅ Task updated:", id);
      res.json({ success: true });
    } catch (err) {
      console.error("Update task error:", err);
      res.status(500).json({ error: "Failed to update task" });
    }
  }
);

app.delete("/api/tasks/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid ID" });
    }

    const task = await tasks().findOne({
      _id: new ObjectId(id),
      uid: req.user.uid,
    });

    if (!task) {
      return res.status(404).json({ error: "Not found" });
    }

    await tasks().deleteOne({ _id: new ObjectId(id) });

    if (task.file?.path) {
      const filePath = path.join(__dirname, task.file.path);
      if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    }

    console.log("✅ Task deleted:", id);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete task error:", err);
    res.status(500).json({ error: "Failed to delete task" });
  }
});

// ============================================
// PRESSURE SETTINGS ROUTES
// ============================================

app.get("/api/pressure-settings/:uid", verifyToken, async (req, res) => {
  try {
    const { uid } = req.params;

    if (req.user.uid !== uid) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const user = await users().findOne({ uid });

    const defaultSettings = {
      low: 3,
      medium: 5,
      high: 7,
      critical: 8,
    };

    res.json({
      settings: user?.pressureSettings || defaultSettings,
    });
  } catch (err) {
    console.error("Get pressure settings error:", err);
    res.status(500).json({ error: "Failed to fetch pressure settings" });
  }
});

app.post("/api/pressure-settings", verifyToken, async (req, res) => {
  try {
    const { uid, settings } = req.body;

    console.log("💾 Saving pressure settings:", { uid, settings });

    if (!uid || !settings) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (req.user.uid !== uid) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (
      typeof settings.low !== "number" ||
      typeof settings.medium !== "number" ||
      typeof settings.high !== "number" ||
      typeof settings.critical !== "number"
    ) {
      return res.status(400).json({ error: "Invalid settings format" });
    }

    if (
      settings.low >= settings.medium ||
      settings.medium >= settings.high ||
      settings.high >= settings.critical
    ) {
      return res.status(400).json({
        error:
          "Settings must be in ascending order: low < medium < high < critical",
      });
    }

    await users().updateOne(
      { uid },
      {
        $set: {
          pressureSettings: settings,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    console.log("✅ Pressure settings saved successfully");

    res.json({
      success: true,
      settings: settings,
    });
  } catch (err) {
    console.error("❌ Save pressure settings error:", err);
    res.status(500).json({ error: "Failed to save pressure settings" });
  }
});

app.get("/api/pressure-calculate/:uid", verifyToken, async (req, res) => {
  try {
    const { uid } = req.params;

    if (req.user.uid !== uid) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const user = await users().findOne({ uid });
    const settings = user?.pressureSettings || {
      low: 3,
      medium: 5,
      high: 7,
      critical: 8,
    };

    const userTasks = await tasks().find({ uid }).toArray();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const upcomingTasks = userTasks.filter((t) => {
      if (!t.deadline || t.completed) return false;
      const taskDate = new Date(t.deadline);
      taskDate.setHours(0, 0, 0, 0);
      return taskDate >= today;
    });

    const taskCount = upcomingTasks.length;

    let pressureLevel = "Low";
    let pressureColor = "green";

    if (taskCount <= settings.low) {
      pressureLevel = "Low";
      pressureColor = "green";
    } else if (taskCount <= settings.medium) {
      pressureLevel = "Medium";
      pressureColor = "yellow";
    } else if (taskCount <= settings.high) {
      pressureLevel = "High";
      pressureColor = "orange";
    } else {
      pressureLevel = "Critical";
      pressureColor = "red";
    }

    res.json({
      taskCount,
      pressureLevel,
      pressureColor,
      settings,
      upcomingTasks: upcomingTasks.length,
    });
  } catch (err) {
    console.error("Calculate pressure error:", err);
    res.status(500).json({ error: "Failed to calculate pressure" });
  }
});

// ============================================
// CATEGORY ROUTES
// ============================================

app.get("/api/categories/:uid", verifyToken, async (req, res) => {
  try {
    const { uid } = req.params;

    if (req.user.uid !== uid) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const cats = await categories()
      .find({ $or: [{ uid }, { uid: { $exists: false } }] })
      .toArray();

    console.log(`✅ Fetched ${cats.length} categories for user ${uid}`);
    res.json({ categories: cats });
  } catch (err) {
    console.error("Get categories error:", err);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

app.post("/api/categories", verifyToken, async (req, res) => {
  try {
    const { uid, name } = req.body;

    console.log("📁 Add category request:", {
      uid,
      name,
      authUid: req.user.uid,
    });

    if (!uid || !name) {
      console.log("❌ Missing fields");
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (req.user.uid !== uid) {
      console.log("❌ UID mismatch");
      return res.status(403).json({ error: "Forbidden" });
    }

    const existingCat = await categories().findOne({
      uid,
      name: name.trim(),
    });

    if (existingCat) {
      console.log("❌ Category already exists");
      return res.status(400).json({ error: "Category already exists" });
    }

    const result = await categories().insertOne({
      uid,
      name: name.trim(),
      icon: "folder",
      createdAt: new Date(),
    });

    console.log("✅ Category added:", result.insertedId);
    res.json({
      success: true,
      categoryId: result.insertedId,
    });
  } catch (err) {
    console.error("❌ Add category error:", err);
    res
      .status(500)
      .json({ error: "Failed to add category", details: err.message });
  }
});

app.patch("/api/categories/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    console.log("📝 Edit category request:", { id, name });

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid category ID" });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Category name is required" });
    }

    const category = await categories().findOne({
      _id: new ObjectId(id),
      uid: req.user.uid,
    });

    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }

    const oldName = category.name;

    await categories().updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          name: name.trim(),
          updatedAt: new Date(),
        },
      }
    );

    await tasks().updateMany(
      { uid: req.user.uid, category: oldName },
      { $set: { category: name.trim() } }
    );

    console.log("✅ Category updated:", id);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Edit category error:", err);
    res.status(500).json({ error: "Failed to update category" });
  }
});

app.delete("/api/categories/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    console.log("🗑️ Delete category request:", { id });

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid category ID" });
    }

    const category = await categories().findOne({
      _id: new ObjectId(id),
      uid: req.user.uid,
    });

    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }

    const defaultCategories = ["Academic", "Personal", "Work"];
    if (defaultCategories.includes(category.name) && !category.uid) {
      return res
        .status(403)
        .json({ error: "Cannot delete default categories" });
    }

    await categories().deleteOne({ _id: new ObjectId(id) });

    await tasks().updateMany(
      { uid: req.user.uid, category: category.name },
      { $set: { category: "Uncategorized" } }
    );

    console.log("✅ Category deleted:", id);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Delete category error:", err);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

// ============================================
// USER PROFILE ROUTES
// ============================================

app.post("/api/user/profile", verifyToken, async (req, res) => {
  try {
    const { uid, email, displayName, photoURL } = req.body;
    await users().updateOne(
      { uid },
      { $set: { email, displayName, photoURL, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Save profile error:", err);
    res.status(500).json({ error: "Failed to save profile" });
  }
});

app.get("/api/user/profile", verifyToken, async (req, res) => {
  try {
    const user = await users().findOne({ uid: req.user.uid });
    res.json({ googleTokens: user?.googleTokens || null });
  } catch (err) {
    console.error("Get profile error:", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// 404 HANDLER
app.use((req, res) => {
  console.log("❌ 404 Not Found:", req.method, req.path);
  res.status(404).json({
    error: "Route not found",
    method: req.method,
    path: req.path,
  });
});

// START SERVER
connectDB();

app.listen(PORT, "0.0.0.0", () => {
  console.log("=".repeat(50));
  console.log(`✅ Server LIVE on port ${PORT}`);
  console.log(`✅ http://localhost:${PORT}`);
  console.log("=".repeat(50));
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down gracefully...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("\n👋 Shutting down gracefully...");
  process.exit(0);
});
