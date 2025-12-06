// server/routes/ai.js
const express = require('express');
const router = express.Router();
const { tasks } = require('../index');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

router.post('/chat', async (req, res) => {
  const { message, uid = "guest" } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let fullReply = "";
  let taskCreated = false;

  const getUserTasks = async () => {
    const taskList = await tasks().find({ uid }).sort({ createdAt: -1 }).limit(10).toArray();
    const total = await tasks().countDocuments({ uid });
    const pending = await tasks().countDocuments({ uid, status: "pending" });
    const done = await tasks().countDocuments({ uid, status: "done" });

    if (taskList.length === 0) {
      return "You have no tasks yet! Want to add one?";
    }

    let reply = `You have ${total} tasks (${pending} pending, ${done} done):\n\n`;
    taskList.forEach((t, i) => {
      const status = t.status === "done" ? "Done" : "Pending";
      reply += `${i + 1}. ${t.title} (${t.category}) — ${status}\n`;
      if (t.deadline) reply += `   Deadline: ${new Date(t.deadline).toLocaleString()}\n`;
      reply += "\n";
    });
    return reply;
  };

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          {
            role: "system",
            content: `You are Overlax AI — a super smart productivity assistant.

CAPABILITIES:
1. Create task → reply with:
[TASK_CREATE]
Title: Study math
Deadline: Tomorrow 8pm
Category: Study
[TASK_CREATE]

2. Show tasks → when user asks "my tasks", "koyta task ache", "list tasks" → reply:
[TASK_LIST]

3. Normal chat → reply normally.

Always be friendly and helpful!`
          },
          { role: "user", content: message }
        ],
        temperature: 0.7,
        stream: true
      })
    });

    const reader = groqRes.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const json = JSON.parse(line.slice(6));
            const text = json.choices?.[0]?.delta?.content || "";
            if (text) {
              fullReply += text;

              if (fullReply.includes("[TASK_LIST]")) {
                const list = await getUserTasks();
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: list } }] })}\n\n`);
                fullReply = "";
                continue;
              }

              if (!taskCreated && fullReply.includes("[TASK_CREATE]")) {
                const match = fullReply.match(/Title:\s*(.+)\s*Deadline:\s*(.+)\s*Category:\s*(.+)/i);
                if (match) {
                  const title = match[1].trim();
                  const deadlineStr = match[2].trim();
                  const category = match[3].trim();

                  let deadline = null;
                  if (deadlineStr.toLowerCase().includes("tomorrow")) {
                    deadline = new Date();
                    deadline.setDate(deadline.getDate() + 1);
                  } else if (!deadlineStr.toLowerCase().includes("none")) {
                    deadline = new Date(deadlineStr);
                  }

                  await tasks().insertOne({
                    uid,
                    title,
                    category: category || "Personal",
                    deadline,
                    status: "pending",
                    createdAt: new Date()
                  });

                  taskCreated = true;
                  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `\n\nTask "${title}" added successfully!` } }] })}\n\n`);
                }
              } else {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
              }
            }
          } catch {
            // ignore malformed streaming chunks (very common with Groq/OpenAI)
          }
        }
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();

  } catch (err) {
    console.error(err);
    res.write("data: Sorry, try again.\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

module.exports = router;