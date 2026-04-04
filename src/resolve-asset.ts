import { existsSync } from "node:fs";
import { join } from "node:path";

export function resolveAsset(name: string): string {
    const candidates: string[] = [];
    try { candidates.push(join(__dirname, name)); } catch { }
    candidates.push(join(process.cwd(), "src", name));
    candidates.push(join(process.cwd(), name));
    for (const p of candidates) {
        try { if (existsSync(p)) return p; } catch { }
    }
    return candidates[0] ?? name;
}
