import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { variantWidths } from "@/lib/media-src";

/** Every `?w=` written in the code is a width /media resizes; any other answers 400. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.(tsx?|mts)$/.test(name) ? [full] : [];
  });
}

describe("media widths in the code", () => {
  it("only asks /media for sizes it makes", () => {
    const bad: string[] = [];
    for (const file of files(path.resolve("src"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/[?&]w=(\d+)/g)) {
        if (!variantWidths.includes(Number(m[1])))
          bad.push(`${path.relative(process.cwd(), file)}: w=${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
