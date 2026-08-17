import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import OpenAI from "openai";

const execFileAsync = promisify(execFile);

const STAGING_CONTENTS = "env: staging\nreplicas: 3\n";
const PRODUCTION_CONTENTS = "env: production\nreplicas: 3\n";

function sha256Utf8Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function ingestUrl(): string {
  const base = process.env.LATTICEAG_INGEST_URL;
  if (!base) {
    throw new Error("LATTICEAG_INGEST_URL is required");
  }
  return `${base.replace(/\/$/, "")}/generic`;
}

function resolveWritePath(inputPath: string): string {
  const outRoot = path.resolve("out");
  const stripped = inputPath.replace(/^(?:\.\/)?out\//, "");
  const resolved = path.resolve(outRoot, stripped);
  const rel = path.relative(outRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`write_file refuses path outside ./out/: ${inputPath}`);
  }
  return resolved;
}

function lexshieldOnPath(): boolean {
  try {
    execFileSync("lexshield", ["--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
    });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ENOENT";
  }
}

async function evaluatePolicy(tool: string, args: Record<string, unknown>): Promise<void> {
  if (!lexshieldOnPath()) {
    process.stderr.write("lexshield missing, skip policy\n");
    return;
  }
  try {
    await execFileAsync(
      "lexshield",
      [
        "evaluate",
        "--tool",
        tool,
        "--args",
        JSON.stringify(args),
        "-c",
        "policy/lexshield",
        "--json",
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      process.stderr.write("lexshield missing, skip policy\n");
      return;
    }
    process.stderr.write(
      `lexshield evaluate failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function ingest(name: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(ingestUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, payload }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ingest ${name} failed: ${res.status} ${text}`);
  }
}

async function postToolObserved(
  name: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  await ingest("tool_observed", {
    source: "axion",
    name,
    arguments: args,
    result,
  });
}

function verdictPayload(
  verdict: "pass" | "steer",
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  message: string,
): Record<string, unknown> {
  const tool_call = `write_file ${JSON.stringify(args)}`;
  const goal = process.env.LATTICEAG_GOAL ?? "complete the user task";
  const resultText = JSON.stringify(result);
  return {
    verdict,
    confidence: verdict === "pass" ? 0.95 : 0.8,
    message,
    tool_call,
    goal,
    result: resultText,
    tool_call_sha256: sha256Utf8Hex(tool_call),
    goal_sha256: sha256Utf8Hex(goal),
    result_sha256: sha256Utf8Hex(resultText),
    latency_ms: 1,
  };
}

async function tryLexverdict(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<boolean> {
  const base = (process.env.LEXVERDICT_URL ?? "").replace(/\/$/, "");
  if (!base) {
    return false;
  }
  const tool_call = `write_file ${JSON.stringify(args)}`;
  const goal = process.env.LATTICEAG_GOAL ?? "complete the user task";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 800);
  try {
    const res = await fetch(`${base}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool_call,
        goal,
        result: JSON.stringify(result),
      }),
      signal: ac.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function writeFileTool(filePath: string, contents: string): Promise<string> {
  const args = { path: filePath, contents };
  await evaluatePolicy("write_file", args);
  const dest = resolveWritePath(filePath);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, contents);
  return dest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForJsonlName(name: string, timeoutMs: number): Promise<boolean> {
  const filePath = process.env.LATTICEAG_EVENTS_PATH;
  if (!filePath) {
    await sleep(timeoutMs);
    return false;
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = readFileSync(filePath, "utf8");
      if (text.includes(`"name":"${name}"`) || text.includes(`"name": "${name}"`)) {
        return true;
      }
    } catch {
      // jsonl not written yet
    }
    await sleep(50);
  }
  return false;
}

async function afterWrite(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  fallbackVerdict: "pass" | "steer",
  message: string,
  offline: boolean,
): Promise<void> {
  await tryLexverdict(args, result);
  if (offline || process.env.LATTICEAG_INGEST_URL) {
    await postToolObserved("write_file", args, result);
  }
  if (offline) {
    await ingest("verdict", verdictPayload(fallbackVerdict, args, result, message));
  }
  if (offline && fallbackVerdict === "steer") {
    await waitForJsonlName("approval_granted", 5000);
    await waitForJsonlName("receipt_issued", 2000);
  } else {
    await sleep(400);
  }
}

async function runOffline(): Promise<void> {
  const stagingArgs = { path: "out/config.yaml", contents: STAGING_CONTENTS };
  const stagingResult = { ok: true, path: await writeFileTool("out/config.yaml", STAGING_CONTENTS) };
  await afterWrite(
    stagingArgs,
    stagingResult,
    "steer",
    "staging is not production",
    true,
  );

  const prodArgs = { path: "out/config.yaml", contents: PRODUCTION_CONTENTS };
  const prodResult = {
    ok: true,
    path: await writeFileTool("out/config.yaml", PRODUCTION_CONTENTS),
  };
  await afterWrite(
    prodArgs,
    prodResult,
    "pass",
    "production config written",
    true,
  );
  await sleep(800);
}

async function runLive(): Promise<void> {
  const client = new OpenAI({
    defaultHeaders: {
      "x-axion-session": process.env.LATTICEAG_SESSION_ID ?? "",
    },
  });
  const goal =
    process.env.LATTICEAG_GOAL ??
    "Write production config.yaml with env: production and replicas: 3";
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a text file under ./out/",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            contents: { type: "string" },
          },
          required: ["path", "contents"],
        },
      },
    },
  ];
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "user", content: goal },
  ];
  for (let i = 0; i < 6; i++) {
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o",
      messages,
      tools,
    });
    const choice = completion.choices[0];
    if (!choice?.message) {
      break;
    }
    messages.push(choice.message);
    const calls = choice.message.tool_calls ?? [];
    if (calls.length === 0) {
      break;
    }
    for (const call of calls) {
      if (call.function.name !== "write_file") {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: "unknown tool" }),
        });
        continue;
      }
      const parsed = JSON.parse(call.function.arguments) as {
        path?: string;
        contents?: string;
      };
      const filePath = parsed.path ?? "out/config.yaml";
      const contents = parsed.contents ?? "";
      const dest = await writeFileTool(filePath, contents);
      const args = { path: filePath, contents };
      const result = { ok: true, path: dest };
      await afterWrite(
        args,
        result,
        contents.includes("env: production") ? "pass" : "steer",
        contents.includes("env: production")
          ? "production config written"
          : "not production",
        false,
      );
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }
}

const offline = process.argv.includes("--offline-fixture");
const run = offline ? runOffline() : runLive();
run.catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
