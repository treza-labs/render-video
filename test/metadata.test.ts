/** action.yml, the code and the README agree on the inputs and outputs. */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

/** The names (and defaults) under one top-level key of action.yml. */
function section(yml: string, key: string): Record<string, string | undefined> {
  const body = yml.split(new RegExp(`^${key}:\\n`, "m"))[1]!.split(/^\S/m)[0]!;
  const found: Record<string, string | undefined> = {};
  let current = "";
  for (const line of body.split("\n")) {
    const name = line.match(/^ {2}([a-z-]+):\s*$/);
    if (name) found[(current = name[1]!)] = undefined;
    const value = line.match(/^ {4}default:\s*"?([^"]*)"?\s*$/);
    if (value && current) found[current] = value[1];
  }
  return found;
}

describe("metadata", () => {
  it("action.yml declares every input the code reads, with the defaults the code assumes", async () => {
    const inputs = section(await read("action.yml"), "inputs");
    expect(inputs).toEqual({
      "api-key": undefined,
      mode: "video",
      prompt: undefined,
      model: undefined,
      duration: undefined,
      "aspect-ratio": undefined,
      "pipeline-id": undefined,
      inputs: undefined,
      "max-cost-usd": undefined,
      wait: "true",
      "timeout-minutes": "15",
      "download-path": undefined,
    });
    const code = (await read("src/inputs.ts")) + (await read("src/run.ts"));
    for (const name of Object.keys(inputs)) expect(code, name).toContain(`"${name}"`);
  });

  it("action.yml declares every output the code sets", async () => {
    const yml = await read("action.yml");
    const outputs = Object.keys(section(yml, "outputs"));
    expect(outputs).toEqual(["run-id", "pipeline-id", "status", "price-usd", "url", "files", "path"]);
    const code = await read("src/run.ts");
    const set = [...code.matchAll(/output\("([a-z-]+)"/g)].map((m) => m[1]);
    expect([...new Set(set)].sort()).toEqual([...outputs].sort());
    expect(yml).toMatch(/^runs:\n {2}using: node24\n {2}main: dist\/index\.js$/m);
    expect(yml).toMatch(/^branding:\n {2}icon: film\n {2}color: purple$/m);
  });

  it("the README lists every input and output", async () => {
    const readme = await read("README.md");
    const yml = await read("action.yml");
    for (const name of [...Object.keys(section(yml, "inputs")), ...Object.keys(section(yml, "outputs"))]) {
      expect(readme, name).toContain(`| \`${name}\` |`);
    }
  });
});
