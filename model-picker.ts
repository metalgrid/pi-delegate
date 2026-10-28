import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, SettingsList, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { modelKey, type ModelIdentity } from "./model-policy.ts";

export function modelPicker(
	tui: TUI,
	theme: Theme,
	catalog: ModelIdentity[],
	disabled: ReadonlySet<string>,
	done: (selection: Set<string> | undefined) => void,
) {
	// Keep absent model IDs: temporarily missing providers must not reset preferences.
	const draft = new Set(disabled);
	const items = [...new Set(catalog.map(modelKey))].sort().map((id) => ({
		id, label: id, currentValue: draft.has(id) ? "[ ]" : "[x]", values: ["[x]", "[ ]"],
	}));
	const listTheme = getSettingsListTheme();
	const list = new SettingsList(items, 12, {
		...listTheme,
		label: (text, selected) => listTheme.label(`${draft.has(text.trimEnd()) ? "[ ]" : "[x]"} ${text}`, selected),
	}, (id, value) => {
		if (value === "[ ]") draft.add(id);
		else draft.delete(id);
	}, () => done(undefined), { enableSearch: true });
	return {
		render(width: number): string[] {
			return [
				theme.fg("accent", "Delegation models"),
				theme.fg("dim", "Type to search · ↑/↓ move · Space/Enter toggle"),
				theme.fg("dim", "Ctrl+S save · Esc cancel · [x] eligible"),
				...(items.length ? list.render(width) : ["No available chat models. Configure a provider first."]),
			].map((line) => truncateToWidth(line, width));
		},
		invalidate() { list.invalidate(); },
		handleInput(data: string) {
			if (matchesKey(data, "ctrl+s")) done(draft);
			else if (matchesKey(data, "escape")) done(undefined);
			else list.handleInput(data === " " ? "\r" : data);
			tui.requestRender();
		},
	};
}
