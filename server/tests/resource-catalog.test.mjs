import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResourceCatalog, normalizeProject, projectUrlFrom } from "../lib/resource-catalog.mjs";

test("imports project map and resolves aliases, ids and URLs", async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "webchat-catalog-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const catalog = await new ResourceCatalog({ runtimeDir }).init();

  const result = await catalog.importProjects({
    projects: {
      Finance: "g-p-finance123",
      Auditor: {
        id: "g-p-auditor456",
        name: "Auditor Project",
        aliases: ["audit", "bca"],
        short_url: "g-p-auditor456-auditor-project",
      },
    },
  });

  assert.equal(result.imported, 2);
  assert.equal(catalog.resolveProject("Finance").id, "g-p-finance123");
  assert.equal(catalog.resolveProject("audit").id, "g-p-auditor456");
  assert.equal(catalog.resolveProject("g-p-auditor456").name, "Auditor Project");
  assert.equal(catalog.resolveProject("https://chatgpt.com/g/g-p-auditor456-auditor-project/project").id, "g-p-auditor456");
});

test("live sync merges metadata without losing admin aliases", async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "webchat-catalog-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const catalog = await new ResourceCatalog({ runtimeDir }).init();
  await catalog.importProjects({ Alpha: { id: "g-p-alpha123", aliases: ["client-a"] } });

  await catalog.syncProjects([{
    gizmo: {
      id: "g-p-alpha123",
      short_url: "g-p-alpha123-alpha",
      display: { name: "Alpha Live" },
      memory_scope: "project_v2",
      files: [{ id: "file-1", name: "source.pdf" }],
    },
  }]);

  const project = catalog.resolveProject("client-a");
  assert.equal(project.name, "Alpha Live");
  assert.equal(project.memory_scope, "project_v2");
  assert.equal(project.files.length, 1);
  assert.match(project.url, /g-p-alpha123-alpha/);
});

test("normalization rejects invalid project ids and builds canonical URLs", () => {
  assert.throws(() => normalizeProject({ id: "not-a-project" }), /invalid ChatGPT project id/);
  assert.equal(projectUrlFrom({ id: "g-p-abc123" }), "https://chatgpt.com/g/g-p-abc123/project");
});
