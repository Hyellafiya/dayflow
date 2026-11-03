
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  createAuthClient,
  createUserDb,
  requireUser
} from "./lib/auth.js";
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  addEvent
} from "./lib/supabase-store.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: "1mb" }));
app.use("/api", rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false
}));
import {
  createGoogleAuthorization,
  completeGoogleAuthorization,
  getGoogleConnection,
  disconnectGoogle
} from "./lib/google-oauth.js";
app.locals.supabase = createAuthClient();

function userDb(req) {
  return createUserDb(req.accessToken);
}

const TaskInput = z.object({
  instruction: z.string().trim().min(8).max(4000),
  mode: z.enum([
    "plan",
    "document",
    "email",
    "browser",
    "research"
  ]).default("plan")
});

const EmailDraftInput = z.object({
  instruction: z.string().trim().min(8).max(4000)
});

app.get("/api/config", (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabasePublishableKey:
      process.env.SUPABASE_PUBLISHABLE_KEY || "",
    authConfigured: Boolean(
      process.env.SUPABASE_URL &&
      process.env.SUPABASE_PUBLISHABLE_KEY
    ),
    appName: "Dayflow"
  });
});

app.get("/api/health", (_req, res) => {
  const configured = Boolean(
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_PUBLISHABLE_KEY
  );

  res.json({
    ok: true,
    authConfigured: configured,
    aiConfigured: Boolean(process.env.OPENROUTER_API_KEY),
    researchConfigured: Boolean(process.env.TAVILY_API_KEY),
    browserConfigured: Boolean(
      process.env.BROWSERBASE_API_KEY &&
      process.env.BROWSERBASE_PROJECT_ID
    ),
    googleOAuthConfigured: Boolean(
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET
    ),
    persistence: configured ? "supabase" : "not-configured",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/me", requireUser, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    createdAt: req.user.created_at,
    role: req.user.role || "authenticated"
  });
});

app.get("/api/tasks", requireUser, async (req, res) => {
  try {
    const tasks = await listTasks(userDb(req), req.user.id);
    res.json(tasks);
  } catch (error) {
    console.error("Load tasks:", error.message);
    res.status(500).json({
      error: "Could not load tasks from your workspace."
    });
  }
});

app.post("/api/tasks", requireUser, async (req, res) => {
  const parsed = TaskInput.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues[0]?.message || "Invalid task."
    });
  }

  try {
    const db = userDb(req);

    let task = await createTask(
      db,
      req.user.id,
      parsed.data
    );

    if (process.env.OPENROUTER_API_KEY) {
      try {
        const response = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
              "Content-Type": "application/json",
              "HTTP-Referer":
                process.env.APP_URL || "http://localhost:3000",
              "X-Title": "Dayflow"
            },
            body: JSON.stringify({
              model:
                process.env.OPENROUTER_MODEL ||
                "openai/gpt-4.1-mini",
              messages: [
                {
                  role: "system",
                  content:
                    "You are Dayflow, a careful productivity planner. " +
                    "Return ONLY JSON with summary and steps. " +
                    "Steps must contain title and description. " +
                    "Give 3-7 concrete steps. Never claim to have " +
                    "performed external actions."
                },
                {
                  role: "user",
                  content:
                    `Mode: ${parsed.data.mode}\n` +
                    `Goal: ${parsed.data.instruction}`
                }
              ],
              response_format: { type: "json_object" },
              temperature: 0.3
            })
          }
        );

        if (!response.ok) {
          throw new Error(`AI provider returned ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        const plan = JSON.parse(content || "{}");

        if (!Array.isArray(plan.steps) || !plan.steps.length) {
          throw new Error("AI returned an invalid plan.");
        }

        task = await updateTask(
          db,
          req.user.id,
          task.id,
          (current) => {
            current.plan = plan.steps.slice(0, 8).map(step => ({
              title: String(step.title || "Next step").slice(0, 160),
              description:
                String(step.description || "").slice(0, 800)
            }));

            current.internalPlan = {
              summary: String(
                plan.summary || "Plan generated."
              ).slice(0, 1500)
            };

            current.status = "planned";
            addEvent(current, "success", "AI plan generated.");
          }
        );
      } catch (error) {
        console.error("AI planning:", error.message);

        task = await updateTask(
          db,
          req.user.id,
          task.id,
          current => addEvent(
            current,
            "error",
            "AI planning was unavailable; the starter plan was saved."
          )
        );
      }
    }

    res.status(201).json(task);
  } catch (error) {
    console.error("Create task:", error.message);
    res.status(500).json({
      error: "Could not save your task. Check your database configuration."
    });
  }
});

app.get("/api/tasks/:id", requireUser, async (req, res) => {
  try {
    const task = await getTask(
      userDb(req),
      req.user.id,
      req.params.id
    );

    if (!task) {
      return res.status(404).json({ error: "Task not found." });
    }

    res.json(task);
  } catch (error) {
    console.error("Get task:", error.message);
    res.status(500).json({
      error: "Could not load this task."
    });
  }
});

app.post(
  "/api/tasks/:id/approve",
  requireUser,
  async (req, res) => {
    if (req.body?.approved !== true) {
      return res.status(400).json({
        error: "Explicit approval is required."
      });
    }

    try {
      const task = await updateTask(
        userDb(req),
        req.user.id,
        req.params.id,
        current => {
          current.approval = {
            required: false,
            approved: true,
            reason: "User approved the task."
          };

          addEvent(
            current,
            "success",
            "User approved the task."
          );
        }
      );

      if (!task) {
        return res.status(404).json({
          error: "Task not found."
        });
      }

      res.json(task);
    } catch (error) {
      console.error("Approve task:", error.message);
      res.status(500).json({
        error: "Could not save task approval."
      });
    }
  }
);

app.post("/api/tasks/:id/run", requireUser, (_req, res) => {
  res.status(501).json({
    error:
      "Task execution is not connected yet. Your task and plan " +
      "are saved, but Dayflow will not mark them complete until " +
      "the execution engine is implemented."
  });
});

app.post("/api/email/draft", requireUser, async (req, res) => {
  const parsed = EmailDraftInput.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error:
        parsed.error.issues[0]?.message || "Invalid instruction."
    });
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(503).json({
      error: "AI drafting is not configured."
    });
  }

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model:
            process.env.OPENROUTER_MODEL ||
            "openai/gpt-4.1-mini",
          messages: [
            {
              role: "system",
              content:
                "Draft a helpful professional email. Return only JSON " +
                "with subject and body strings. Do not send it."
            },
            {
              role: "user",
              content: parsed.data.instruction
            }
          ],
          response_format: { type: "json_object" },
          temperature: 0.4
        })
      }
    );

    if (!response.ok) {
      throw new Error("AI provider request failed.");
    }

    const data = await response.json();
    const draft = JSON.parse(
      data.choices?.[0]?.message?.content || "{}"
    );

    res.json({
      subject: String(draft.subject || "").slice(0, 250),
      body: String(draft.body || "").slice(0, 20000),
      sendEnabled: false
    });
  } catch (error) {
    console.error("Email draft:", error.message);
    res.status(502).json({
      error: "Couldn't generate a draft. Check the AI configuration."
    });
  }
});

app.post("/api/email/send", requireUser, (_req, res) => {
  res.status(501).json({
    error:
      "Email sending is not connected yet. Configure and test " +
      "a provider integration before enabling delivery."
  });
});


app.get(
  "/api/connectors/google/status",
  requireUser,
  async (req, res) => {
    try {
      const connection = await getGoogleConnection(req.user.id);

      res.json({
        configured: true,
        ...connection
      });
    } catch (error) {
      console.error("Google status:", error.message);
      res.status(503).json({
        configured: false,
        connected: false,
        error: "Google connection status is unavailable."
      });
    }
  }
);

app.post(
  "/api/connectors/google/start",
  requireUser,
  async (req, res) => {
    try {
      const authUrl = await createGoogleAuthorization(req.user.id);
      res.json({ authUrl });
    } catch (error) {
      console.error("Google OAuth start:", error.message);
      res.status(503).json({
        error: "Could not start Google authorization. Check server configuration."
      });
    }
  }
);

app.get("/api/connectors/google/callback", async (req, res) => {
  const appUrl = process.env.APP_URL || "https://day-flow-iota.vercel.app";

  if (req.query.error) {
    return res.redirect(
      302,
      `${appUrl}/?google=error#integrations`
    );
  }

  try {
    await completeGoogleAuthorization(
      String(req.query.code || ""),
      String(req.query.state || "")
    );

    return res.redirect(
      302,
      `${appUrl}/?google=connected#integrations`
    );
  } catch (error) {
    console.error("Google OAuth callback:", error.message);

    return res.redirect(
      302,
      `${appUrl}/?google=error#integrations`
    );
  }
});

app.post(
  "/api/connectors/google/disconnect",
  requireUser,
  async (req, res) => {
    try {
      await disconnectGoogle(req.user.id);
      res.json({ disconnected: true });
    } catch (error) {
      console.error("Google disconnect:", error.message);
      res.status(500).json({
        error: "Could not disconnect Google."
      });
    }
  }
);


app.get(
  "/api/connectors/google/start",
  requireUser,
  (_req, res) => {
    res.status(501).json({
      error: "Google OAuth is not implemented yet."
    });
  }
);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

app.use(express.static("public"));

app.get("*path", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();

  res.sendFile("index.html", { root: "public" });
});

app.use((err, _req, res, _next) => {
  console.error("Request error:", err?.message || "unknown");
  res.status(500).json({
    error: "Unexpected server error. Check server logs."
  });
});

if (
  process.env.NODE_ENV !== "production" &&
  process.env.SESSION_SECRET &&
  process.env.SESSION_SECRET.length < 32
) {
  console.warn("SESSION_SECRET should be at least 32 characters.");
}

export default app;
