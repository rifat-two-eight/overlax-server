// server/routes/ai.js
const express = require('express');
const router = express.Router();
const { OpenAI } = require('openai');
require('dotenv').config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

router.post('/chat', async (req, res) => {
  const { message, uid } = req.body;

  // Streaming header
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: "system",
          content: `Tumi Overlax AI Assistant. Bangla + English e kotha bolba. 
          Super friendly + helpful. User er task manage korba. 
          Jodi task bole, tui suggest diba: Title, Category, Deadline diye.`
        },
        { role: "user", content: message }
      ],
      temperature: 0.7,
      stream: true,   // EI LINE TA MAGIC!
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        res.write(content);   // ekta ekta word pathay
      }
    }
    res.write('\n[END]');   // stream end signal
    res.end();

  } catch (err) {
    res.write('Sorry, ami ekhn busy');
    res.end();
  }
});

module.exports = router;