import * as fs from "node:fs";
import * as path from "node:path";

export interface ModelIdentity { provider: string; id: string }
export const modelKey = (model: ModelIdentity): string => `${model.provider}/${model.id}`;
const thinkingSuffix = /:(off|minimal|low|medium|high|xhigh|max)$/;

function validKey(value: unknown): value is string {
	return typeof value === "string" && /^[^/\s]+\/\S+$/.test(value);
}

export function loadDisabled(file: string): Set<string> {
	let text: string;
	try { text = fs.readFileSync(file, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
		throw new Error(`Cannot read delegation model preferences ${file}: ${String(error)}`);
	}
	try {
		const data = JSON.parse(text);
		if (!data || data.version !== 1 || !Array.isArray(data.disabled) || !data.disabled.every(validKey)
			|| Object.keys(data).some((key) => key !== "version" && key !== "disabled")) throw new Error("expected { version: 1, disabled: [provider/model-id, ...] }");
		return new Set(data.disabled);
	} catch (error) {
		throw new Error(`Invalid delegation model preferences ${file}: ${String(error)}. Repair or remove this file before delegating.`);
	}
}

export function saveDisabled(file: string, disabled: ReadonlySet<string>): void {
	if (![...disabled].every(validKey)) throw new Error("Invalid disabled model identity");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tempDir = fs.mkdtempSync(path.join(path.dirname(file), ".delegate-models-"));
	try {
		const temp = path.join(tempDir, "preferences.json");
		fs.writeFileSync(temp, JSON.stringify({ version: 1, disabled: [...disabled].sort() }, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(temp, file);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

export function modelPolicy<T extends ModelIdentity>(catalog: T[], disabled: ReadonlySet<string>) {
	const keys = new Set(catalog.map(modelKey));
	return {
		available: catalog.filter((model) => !disabled.has(modelKey(model))),
		resolve(reference: string): string {
			const value = reference.trim();
			if (!value) throw new Error("No eligible delegation model. Enable a model with /delegate:models.");
			// Literal IDs containing colons take precedence over a thinking suffix, as in Pi.
			const key = keys.has(value) ? value : value.replace(thinkingSuffix, "");
			if (!keys.has(key)) throw new Error(`Unknown delegation model "${value}". Use an exact provider/model-id from /delegate:models (optionally :thinking).`);
			if (disabled.has(key)) throw new Error(`Delegation model "${key}" is disabled. Enable it with /delegate:models or choose another model.`);
			return value;
		},
	};
}
