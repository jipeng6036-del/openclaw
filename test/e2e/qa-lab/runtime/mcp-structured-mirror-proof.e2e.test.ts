// Draft verification-only fixture, NOT_RUN. Install beside gateway-node-mcp.e2e.test.ts.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQaGatewayChild, startQaMockOpenAiServer } from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  approvePairing, createChildEnv, invokeNodeMcpPayload, startNodeProcess,
  stopChild, waitForNode, type CapturedChild,
} from "./gateway-node-mcp.test-support.js";

// A single result contains two semantically equal mirrors plus independent text.
// The fixed boundary must remove only the first two text blocks.
const STRUCTURED = { count: 2, nested: { ready: true, name: "synthetic" } };
const COMPACT = '{"count":2,"nested":{"ready":true,"name":"synthetic"}}';
const REORDERED = '{"nested":{"name":"synthetic","ready":true},"count":2}';
const DIFFERENT = '{"count":3,"nested":{"ready":true,"name":"synthetic"}}';
const GUIDANCE = "Recovery guidance: retry with a smaller query.";

describe("Configured Gateway and node-host MCP structured mirror proof", () => {
  it("removes compact/reordered mirrors and retains different JSON and guidance", { timeout: 240_000 },
    async ({ onTestFinished }) => {
      const tempDirs = useAutoCleanupTempDirTracker(onTestFinished);
      const repoRoot = process.cwd();
      const root = tempDirs.make("openclaw-mirror-proof-");
      const fixture = path.join(root, "mirror-fixture.mjs");
      const home = path.join(root, "node-home");
      const state = path.join(root, "node-state");
      const tmp = path.join(root, "node-tmp");
      const config = path.join(root, "node-config.json");
      await Promise.all([home, state, tmp].map((directory) => fs.mkdir(directory, { recursive: true })));
      // Resolve SDK packages inside the independently installed checkout.
      await fs.writeFile(fixture, `
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(${JSON.stringify(path.join(repoRoot, "package.json"))});
const { McpServer } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href);
const { StdioServerTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href);
const server = new McpServer({ name: "synthetic-mirror-proof", version: "1.0.0" });
server.registerTool("parity_probe", { description: "Return synthetic mirror proof data" }, async () => ({
  structuredContent: ${JSON.stringify(STRUCTURED)},
  content: ${JSON.stringify([COMPACT, REORDERED, DIFFERENT, GUIDANCE].map((text) => ({ type: "text", text })))},
}));
await server.connect(new StdioServerTransport());
`);
      const mcp = {
        transport: "stdio" as const,
        command: process.execPath,
        args: [fixture],
        cwd: repoRoot,
        env: createChildEnv({ home, tempDir: tmp }),
        toolFilter: { include: ["parity_probe"] },
      };
      await fs.writeFile(config, JSON.stringify({
        gateway: { mode: "local" }, plugins: { enabled: false },
        nodeHost: { mcp: { servers: { mirror: mcp } }, skills: { enabled: false } },
      }));
      const owner = createQaGatewayChild();
      let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
      let node: CapturedChild | undefined;
      onTestFinished(async () => {
        const outcomes = await Promise.allSettled([
          ...(node ? [stopChild(node)] : []),
          stopQaGatewayFixture(owner),
          ...(mock ? [Promise.resolve(mock.stop())] : []),
        ]);
        const errors = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
        if (errors.length) throw new AggregateError(errors, "mirror proof cleanup failed");
      });
      mock = await startQaMockOpenAiServer();
      const gateway = await owner.start({
        repoRoot,
        command: { executablePath: process.execPath, argsPrefix: ["dist/index.js"], cwd: repoRoot, usePackagedPlugins: true },
        providerBaseUrl: `${mock.baseUrl}/v1`, providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna", transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false, runtimeEnvPatch: { OPENCLAW_SKIP_CHANNELS: "1" },
        mutateConfig: (cfg) => ({
          ...cfg, mcp: { servers: { mirror: mcp } }, channels: {},
          tools: { ...cfg.tools, profile: "full", toolSearch: false, codeMode: false },
          gateway: { ...cfg.gateway, nodes: { ...cfg.gateway?.nodes,
            commands: { allow: ["mcp.tools.call.v1"] },
            pairing: { ...cfg.gateway?.nodes?.pairing, autoApproveLocal: false },
          } },
        }),
      });
      const port = Number(new URL(gateway.baseUrl).port);
      const nodeEnv = createChildEnv({ home, tempDir: tmp, extra: {
        OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: config,
        OPENCLAW_GATEWAY_TOKEN: gateway.token, OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
      } });
      node = startNodeProcess(port, nodeEnv);
      const nodeId = await approvePairing(gateway, "device");
      await stopChild(node);
      node = startNodeProcess(port, nodeEnv);
      await approvePairing(gateway, "node", nodeId);
      const descriptor = (await waitForNode(gateway, nodeId, 1)).nodePluginTools?.find((tool) => tool.mcp?.server === "mirror");
      expect(descriptor).toBeDefined();
      const nodeResult = await invokeNodeMcpPayload({ gateway, nodeId, descriptor: descriptor!, marker: "normal" });
      expect(nodeResult).toMatchObject({ ok: true, payload: {
        structuredContent: STRUCTURED,
        content: [{ type: "text", text: DIFFERENT }, { type: "text", text: GUIDANCE }],
      } });
      const sessionKey = `agent:qa:mirror-proof-${randomUUID()}`;
      const started = await gateway.call("agent", {
        sessionKey, message: "Tool search QA check target=mirror__parity_probe. Call exactly that tool once and then summarize.",
        deliver: false, idempotencyKey: randomUUID(),
      }) as { runId?: string; status?: string };
      expect(started.status).toBe("accepted");
      expect(started.runId).toBeDefined();
      await expect(gateway.call("agent.wait", { runId: started.runId, timeoutMs: 60_000 }, { timeoutMs: 65_000 })).resolves.toMatchObject({ status: "ok" });
      const history = await gateway.call("chat.history", { sessionKey, limit: 50 }) as {
        messages?: Array<{ role?: string; toolName?: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const result = history.messages?.find((message) => message.role === "toolResult" && message.toolName === "mirror__parity_probe");
      expect(result).toBeDefined();
      const texts = result?.content?.filter((block) => block.type === "text").map((block) => block.text);
      expect(texts).toHaveLength(3);
      expect(texts?.[0]).toContain("structuredContent:");
      expect(texts?.slice(1)).toEqual([DIFFERENT, GUIDANCE]);
      expect(texts).not.toContain(COMPACT);
      expect(texts).not.toContain(REORDERED);
      // Print only synthetic result texts, never Gateway tokens, raw config or child logs.
      console.log(JSON.stringify({ proof: "mirror-runtime", nodeResult, gatewayTexts: texts }));
    });
});
