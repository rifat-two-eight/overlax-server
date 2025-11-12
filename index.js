// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

let db;

async function connectDB() {
  try {
    await client.connect();
    db = client.db("overlax");
    console.log("Connected to MongoDB → Database: overlax");
    await db.command({ ping: 1 });
    console.log("Ping successful!");
  } catch (err) {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  }
}

// === ROUTES ===

app.get('/', (req, res) => {
  res.json({ message: 'Overlax API is running!', database: 'overlax' });
});

// POST: Create Task
app.post('/api/tasks', async (req, res) => {
  const { uid, title, deadline, category } = req.body;
  if (!uid || !title || !deadline) {
    return res.status(400).json({ error: "uid, title, and deadline are required" });
  }

  try {
    const tasks = db.collection('tasks');
    const newTask = {
      uid,
      title,
      deadline: new Date(deadline),
      category: category || "Personal",
      completed: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await tasks.insertOne(newTask);
    res.status(201).json({
      message: "Task created",
      taskId: result.insertedId,
      task: newTask
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to create task" });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const tasks = db.collection('tasks');
    const result = await tasks.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Not found" });
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Get Tasks by UID
app.get('/api/tasks/:uid', async (req, res) => {
  const { uid } = req.params;
  if (!uid) return res.status(400).json({ error: "uid required" });

  try {
    const tasks = db.collection('tasks');
    const userTasks = await tasks.find({ uid }).sort({ deadline: 1 }).toArray();
    res.json({ count: userTasks.length, tasks: userTasks });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

// Start Server
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});