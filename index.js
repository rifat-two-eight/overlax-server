// server/index.js
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// MIDDLEWARE
app.use(cors({ origin: "http://localhost:3000", credentials: true }));
app.use(express.json());

// UPLOADS
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

// FIREBASE
let serviceAccount;
try {
  serviceAccount = require("./firebase-service-account.json");
} catch (err) {
  console.error("Missing firebase-service-account.json");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// GOOGLE OAUTH
let oauth2Client;
try {
  const googleCredentials = require("./google-client-secret.json");
  const { client_id, client_secret, redirect_uris } = googleCredentials.web;
  oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
} catch (err) {
  console.error("Missing google-client-secret.json");
  process.exit(1);
}

// MONGODB
const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const client = new MongoClient(uri);
let db;

async function connectDB() {
  try {
    await client.connect();
    db = client.db("overlax");
    console.log("MongoDB Connected");
    await seedDefaultCategories();
  } catch (err) {
    console.error("MongoDB Failed:", err);
    process.exit(1);
  }
}
connectDB();

const users = () => db.collection("users");
const tasks = () => db.collection("tasks");
const categories = () => db.collection("categories");

// TOKEN VERIFY
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

// SEED CATEGORIES
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

// GOOGLE CALENDAR — FIXED
async function createGoogleEvent(uid, task) {
  const user = await users().findOne({ uid });
  if (!user?.googleTokens) return;

  oauth2Client.setCredentials(user.googleTokens);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  let deadline = task.deadline;
  if (!deadline.includes("T")) {
    deadline += "T09:00:00"; // default 9 AM
  }

  const start = new Date(deadline);
  if (isNaN(start)) {
    console.error("Invalid deadline in createGoogleEvent:", deadline);
    return;
  }

  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const event = {
    summary: task.title,
    description: `Category: ${task.category}\nOverlax Task ID: ${task._id}\nFile: ${task.file?.originalName || 'None'}`,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  };

  try {
    console.log("Creating Google Event:", event); // DEBUG
    const res = await calendar.events.insert({ calendarId: 'primary', resource: event });
    await tasks().updateOne(
      { _id: task._id },
      { $set: { googleEventId: res.data.id } }
    );
    console.log("Google Event Created:", res.data.id);
  } catch (err) {
    console.error("Google Create Failed:", err.response?.data || err.message);
  }
}

async function updateGoogleEvent(uid, task) {
  const user = await users().findOne({ uid });
  if (!user?.googleTokens || !task.googleEventId) return;

  oauth2Client.setCredentials(user.googleTokens);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  let deadline = task.deadline;
  if (!deadline.includes("T")) deadline += "T09:00:00";

  const start = new Date(deadline);
  if (isNaN(start)) return;

  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const event = {
    summary: task.title,
    description: `Category: ${task.category}\nOverlax Task ID: ${task._id}\nFile: ${task.file?.originalName || 'None'}`,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  };

  try {
    await calendar.events.patch({
      calendarId: 'primary',
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
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  try {
    await calendar.events.delete({ calendarId: 'primary', eventId: googleEventId });
  } catch (err) {
    console.error("Google Delete Failed:", err.message);
  }
}

// ROUTES
app.get("/", (req, res) => res.json({ message: "API Running" }));

app.post("/api/user/profile", verifyToken, async (req, res) => {
  const { uid, email, displayName, photoURL } = req.body;
  if (!uid) return res.status(400).json({ error: "UID required" });
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

// GOOGLE AUTH
app.get("/api/auth/google", verifyToken, (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: JSON.stringify({ uid: req.user.uid }),
    prompt: 'consent'
  });
  res.json({ url });
});

app.get("/api/auth/google/callback", async (req, res) => {
  const { code, state } = req.query;
  const { uid } = JSON.parse(state || '{}');
  if (!code || !uid) return res.status(400).send("Invalid");

  try {
    const { tokens } = await oauth2Client.getToken(code);
    await users().updateOne(
      { uid },
      { $set: { googleTokens: tokens } },
      { upsert: true }
    );
    res.send(`
      <script>
        window.opener.postMessage('google-auth-success', '*');
        window.close();
      </script>
    `);
  } catch (err) {
    console.error("Google Auth Error:", err);
    res.status(500).send("Failed");
  }
});

app.delete("/api/auth/google", verifyToken, async (req, res) => {
  await users().updateOne(
    { uid: req.user.uid },
    { $unset: { googleTokens: "" } }
  );
  res.json({ success: true });
});

// TASKS
app.get("/api/tasks/:uid", verifyToken, async (req, res) => {
  const { uid } = req.params;
  const userTasks = await tasks().find({ uid }).toArray();
  res.json({ tasks: userTasks });
});

app.post("/api/tasks", verifyToken, upload.single("file"), async (req, res) => {
  const { uid, title, category, deadline } = req.body;
  if (!uid || !title || !category || !deadline) return res.status(400).json({ error: "Missing" });

  let finalDeadline = deadline;
  if (!deadline.includes("T")) finalDeadline += "T09:00:00";

  const fileInfo = req.file ? {
    name: req.file.filename,
    originalName: req.file.originalname,
    type: req.file.mimetype,
    path: `/uploads/${req.file.filename}`
  } : null;

  const result = await tasks().insertOne({
    uid, title, category, deadline: finalDeadline, file: fileInfo, createdAt: new Date()
  });

  const newTask = { 
    _id: result.insertedId, 
    uid, title, category, 
    deadline: finalDeadline, 
    file: fileInfo 
  };

  await createGoogleEvent(uid, newTask);

  res.json({ taskId: result.insertedId });
});

app.patch("/api/tasks/:id", verifyToken, upload.single("file"), async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });

  const { title, category, deadline } = req.body;
  if (!title || !category || !deadline) return res.status(400).json({ error: "Missing" });

  const currentTask = await tasks().findOne({ _id: new ObjectId(id), uid: req.user.uid });
  if (!currentTask) return res.status(404).json({ error: "Not found" });

  let finalDeadline = deadline;
  if (!deadline.includes("T")) finalDeadline += "T09:00:00";

  const fileInfo = req.file ? {
    name: req.file.filename,
    originalName: req.file.originalname,
    type: req.file.mimetype,
    path: `/uploads/${req.file.filename}`
  } : currentTask.file;

  const oldFilePath = req.file && currentTask.file?.path
    ? path.join(__dirname, currentTask.file.path)
    : null;

  await tasks().updateOne(
    { _id: new ObjectId(id) },
    { $set: { title, category, deadline: finalDeadline, file: fileInfo, updatedAt: new Date() } }
  );

  const updatedTask = { 
    ...currentTask, 
    title, category, 
    deadline: finalDeadline, 
    file: fileInfo 
  };
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

// CATEGORIES
app.get("/api/categories/:uid", verifyToken, async (req, res) => {
  const { uid } = req.params;
  const cats = await categories().find({ $or: [{ uid }, { uid: { $exists: false } }] }).toArray();
  res.json({ categories: cats });
});

app.post("/api/categories", verifyToken, async (req, res) => {
  const { uid, name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Name required" });
  const trimmedName = name.trim();
  const exists = await categories().findOne({ name: trimmedName, uid });
  if (exists) return res.status(400).json({ error: "Exists" });

  const result = await categories().insertOne({ uid, name: trimmedName, icon: "folder" });
  res.json({ categoryId: result.insertedId });
});

app.patch("/api/categories/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Name required" });
  const result = await categories().updateOne(
    { _id: new ObjectId(id), uid: req.user.uid },
    { $set: { name: name.trim() } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

app.delete("/api/categories/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });
  const cat = await categories().findOne({ _id: new ObjectId(id), uid: req.user.uid });
  if (!cat) return res.status(404).json({ error: "Not found" });
  await categories().deleteOne({ _id: new ObjectId(id) });
  await tasks().updateMany({ category: cat.name }, { $set: { category: "Uncategorized" } });
  res.json({ success: true });
});

// START
app.listen(PORT, () => {
  console.log(`Server LIVE on http://localhost:${PORT}`);
});