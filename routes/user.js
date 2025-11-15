// routes/user.js
const express = require('express');
const router = express.Router();

router.get('/all', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const userDocs = await db.collection("users").find({}).toArray();
    const userList = userDocs.map(doc => ({
      uid: doc.uid,
      email: doc.email,
      displayName: doc.displayName,
      photoURL: doc.photoURL
    }));
    res.json(userList);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;