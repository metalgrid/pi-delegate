import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Use the installed Pi host and its jiti; no test-only dependencies are needed.
const require = createRequire(process.env.PI_PACKAGE_DIR
	? fs.realpathSync(path.join(process.env.PI_PACKAGE_DIR, "package.json")) : import.meta.url);
const { createJiti } = require("jiti");
const hostJiti = createJiti(process.env.PI_PACKAGE_DIR ? fs.realpathSync(path.join(process.env.PI_PACKAGE_DIR, "package.json")) : import.meta.url);
const aliases = Object.fromEntries(["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"].map((name) => [name, hostJiti.esmResolve(name)]));
const jiti = createJiti(import.meta.url, { alias: aliases });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-model-test-"));
process.env.PI_CODING_AGENT_DIR = temp;
delete process.env.PI_DELEGATE_DEPTH;
const { loadDisabled, saveDisabled, modelPolicy } = await jiti.import("../model-policy.ts");
const { modelPicker } = await jiti.import("../model-picker.ts");
const { default: extension } = await jiti.import("../index.ts");
const { initTheme } = await jiti.import(aliases["@earendil-works/pi-coding-agent"]);
const file = path.join(temp, "delegate-models.json");
const catalog = [
	{ provider: "p", id: "cheap", cost: { input: 1 } },
	{ provider: "p", id: "large", reasoning: true, cost: { input: 10 } },
	{ provider: "q", id: "cheap", cost: { input: 2 } },
	{ provider: "q", id: "literal:high", cost: { input: 3 } },
];
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`ok ${checks} - ${name}`); };
const tools = new Map();
const commands = new Map();
const pi = { on() {}, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, command) { commands.set(name, command); } };
const ctx = { cwd: temp, model: catalog[0], modelRegistry: { getAll: () => catalog, getAvailable: () => catalog } };
const call = (name, params, context = ctx) => tools.get(name).execute("test", params, undefined, undefined, context);
try {
	check("missing file enables everything", () => assert.equal(loadDisabled(file).size, 0));
	check("atomic persistence retains absent identities", () => {
		saveDisabled(file, new Set(["gone/old", "p/cheap"]));
		assert.deepEqual([...loadDisabled(file)], ["gone/old", "p/cheap"]);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.ok(!fs.readdirSync(temp).some((name) => name.startsWith(".delegate-models-")));
	});
	check("exact provider identity, suffixes and literal colons", () => {
		const policy = modelPolicy(catalog, loadDisabled(file));
		assert.equal(policy.available.length, 3);
		assert.equal(policy.resolve("q/cheap:high"), "q/cheap:high");
		assert.equal(policy.resolve("q/literal:high"), "q/literal:high");
		for (const value of ["p/cheap", "p/cheap:high", "cheap", "p/ch", "P/cheap", "p/cheap:invalid", ""]) assert.throws(() => policy.resolve(value));
	});
	check("malformed preferences fail closed", () => {
		for (const value of ["{", "null", '{"version":2,"disabled":[]}', '{"version":1,"disabled":[3]}', '{"version":1,"disabled":["bare"]}', '{"version":1,"disabled":[],"typo":1}']) {
			fs.writeFileSync(file, value);
			assert.throws(() => loadDisabled(file), /Invalid delegation model preferences/);
		}
	});
	saveDisabled(file, new Set(["p/cheap"]));
	extension(pi);
	for (const params of [
		{ agent: "scout", task: "test", model: "p/cheap" },
		{ agent: "scout", task: "test", model: "p/cheap:high" },
		{ tasks: [{ agent: "scout", task: "test", model: "p/cheap" }], model: "q/cheap" },
		{ agent: "scout", task: "test", model: "cheap" },
	]) await assert.rejects(call("delegate", params), /disabled|exact provider/);
	checks++; console.log(`ok ${checks} - explicit top-level/task/suffix/fuzzy overrides rejected before spawn`);
	fs.writeFileSync(path.join(temp, "agents", "fixed.md"), "---\nname: fixed\nmodel: p/cheap:high\n---\nTest");
	await assert.rejects(call("delegate", { agent: "fixed", task: "test" }), /disabled/);
	await assert.rejects(call("consensus", { agent: "fixed", task: "test" }), /disabled/);
	await assert.rejects(call("consensus", { agent: "scout", task: "test", models: ["q/cheap", "p/cheap:high"] }), /disabled/);
	checks++; console.log(`ok ${checks} - profile and consensus overrides rejected`);
	saveDisabled(file, new Set(catalog.map((m) => `${m.provider}/${m.id}`)));
	await assert.rejects(call("delegate", { agent: "scout", task: "test" }), /No eligible/);
	await assert.rejects(call("consensus", { agent: "scout", task: "test" }), /No eligible/);
	await assert.rejects(call("delegate", { agent: "scout", task: "test" }, { ...ctx, modelRegistry: { ...ctx.modelRegistry, getAvailable: () => [] } }), /No eligible/);
	checks++; console.log(`ok ${checks} - all-disabled including parent fallback fails cleanly`);
	process.env.PI_DELEGATE_DEPTH = "1";
	extension(pi);
	await assert.rejects(call("delegate", { agent: "scout", task: "test", background: true, model: "p/cheap" }), /disabled/);
	delete process.env.PI_DELEGATE_DEPTH;
	extension(pi);
	checks++; console.log(`ok ${checks} - nested delegation reloads shared policy`);

	// A tiny RPC stand-in records launches; no real models or credentials are used.
	const fake = path.join(temp, "child.cjs");
	const log = path.join(temp, "launches.jsonl");
	fs.writeFileSync(fake, `const fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.stdin.once('data', (data) => { console.log(JSON.stringify({type:'response',id:JSON.parse(data.toString().trim()).id,success:true})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Merged result\\nDISSENT NOTES:\\nNone.\\nCONSENSUS: REACHED'}]}})); console.log(JSON.stringify({type:'agent_settled'})); });\n`);
	const oldArgv = process.argv[1];
	process.argv[1] = fake;
	try {
		saveDisabled(file, new Set(["p/cheap", "p/large", "q/literal:high"]));
		await call("delegate", { agent: "scout", task: "test" });
		await call("consensus", { agent: "scout", task: "test", n: 3, models: ["q/cheap:high"] });
		const launches = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
		assert.equal(launches.length, 5); // one delegate, three solvers, one arbiter
		for (const args of launches) {
			assert.equal(args[args.indexOf("--provider") + 1], "q");
			assert.match(args[args.indexOf("--model") + 1], /^cheap(?::high)?$/);
		}
		for (const args of launches.slice(1)) assert.equal(args[args.indexOf("--model") + 1], "cheap:high");
		checks++; console.log(`ok ${checks} - tier filtering and consensus cycling/arbiter use only eligible models`);
		for (const agent of ["worker", "architect"]) {
			const result = await call("delegate", { agent, task: "test" });
			assert.equal(result.details.results[0].resolvedModel, "q/cheap");
		}
		const fallbackResult = await call("delegate", { agent: "scout", task: "test" }, {
			...ctx, model: catalog[2], modelRegistry: { ...ctx.modelRegistry, getAvailable: () => [] },
		});
		assert.equal(fallbackResult.details.results[0].resolvedModel, "q/cheap");
		const beforeArbiter = fs.readFileSync(log, "utf8").trim().split("\n").length;
		const changed = await tools.get("consensus").execute("test", { agent: "scout", task: "test", n: 2 }, undefined,
			(update) => { if (update.content[0].text.startsWith("Arbiter:")) saveDisabled(file, new Set(["q/cheap"])); }, ctx);
		assert.equal(changed.isError, true);
		assert.match(changed.content[0].text, /disabled/);
		assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, beforeArbiter + 2);
		checks++; console.log(`ok ${checks} - standard/heavy tiers, enabled fallback and pre-arbiter policy reload`);
	} finally { process.argv[1] = oldArgv; }

	initTheme();
	const theme = { fg: (_color, text) => text };
	let selected = "pending";
	const initial = new Set(["gone/old"]);
	const picker = modelPicker({ requestRender() {} }, theme, catalog, initial, (value) => { selected = value; });
	picker.handleInput("large");
	picker.handleInput(" ");
	picker.handleInput("\u0013");
	assert.ok(selected.has("p/large"));
	assert.ok(selected.has("gone/old"));
	assert.deepEqual([...initial], ["gone/old"]);
	const cancel = modelPicker({ requestRender() {} }, theme, catalog, initial, (value) => { selected = value; });
	cancel.handleInput(" "); cancel.handleInput("\u001b");
	assert.equal(selected, undefined);
	for (const width of [10, 40, 100]) assert.ok(picker.render(width).length > 0);
	checks++; console.log(`ok ${checks} - searchable checkbox, save, cancel, narrow render and absent-ID retention`);
	const before = fs.readFileSync(file, "utf8");
	await commands.get("delegate:models").handler("", { ...ctx, mode: "tui", ui: { custom: async () => undefined, notify() {} } });
	assert.equal(fs.readFileSync(file, "utf8"), before);
	checks++; console.log(`ok ${checks} - cancelled command never writes preferences`);
	console.log(`${checks} checks passed`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
