// SPDX-FileCopyrightText: 2026 Authologic Sp. z o.o.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict"
import fs from "node:fs"
import Module from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const testDirectory = path.dirname(fileURLToPath(import.meta.url))

// Load the actual TypeScript routes and store with the same alias used by Next.js.
function loadTs(relativePath, aliases = {}) {
  const filename = path.join(testDirectory, "..", relativePath)
  const source = fs.readFileSync(filename, "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } })
  const loaded = new Module(filename)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  const originalRequire = loaded.require.bind(loaded)
  loaded.require = id => Object.hasOwn(aliases, id) ? aliases[id] : originalRequire(id)
  loaded._compile(compiled.outputText, filename)
  return loaded.exports
}

test("webhooks require authentication before reading or writing results", async () => {
  const cwd = process.cwd()
  const originalEnv = { NODE_ENV: process.env.NODE_ENV, WEBHOOK_SECRET: process.env.WEBHOOK_SECRET }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-test-"))
  process.chdir(dir)
  try {
    const store = loadTs("lib/result-store.ts")
    const { POST } = loadTs("app/api/webhook/route.ts", { "@/lib/result-store": store })
    const { GET } = loadTs("app/api/conversations/[id]/route.ts", { "@/lib/result-store": store })
    const payload = JSON.stringify({ payload: { conversation: { id: "conversation", userKey: "user", status: "FINISHED", result: { name: "Example" } } } })
    const post = (token, body = payload) => POST(new Request(`http://localhost/api/webhook${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`, { method: "POST", body }))

    for (const environment of ["development", "test", "production"]) {
      process.env.NODE_ENV = environment
      for (const secret of [undefined, ""]) {
        if (secret === undefined) delete process.env.WEBHOOK_SECRET
        else process.env.WEBHOOK_SECRET = secret
        assert.equal((await post(undefined)).status, 503)
        assert.equal((await post("anything", "invalid JSON")).status, 503)
      }
    }
    assert.equal(fs.existsSync(path.join(dir, ".verification-results")), false)

    process.env.WEBHOOK_SECRET = "a"
    assert.equal((await post(undefined, "invalid JSON")).status, 401)
    assert.equal((await post("wrong")).status, 401)
    assert.equal((await post("é")).status, 401) // Same character length, different byte length.
    assert.equal((await post("a", "invalid JSON")).status, 400)
    assert.equal((await post("a")).status, 200)
    for (const id of ["conversation", "user"]) {
      const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ id }) })
      assert.equal(response.status, 200)
      assert.deepEqual((await response.json()).result, { name: "Example" })
    }

    delete process.env.WEBHOOK_SECRET
    const forged = JSON.stringify({ payload: { conversation: { id: "conversation", userKey: "user", status: "FORGED" } } })
    assert.equal((await post(undefined, forged)).status, 503)
    assert.equal(store.getResult("conversation").status, "FINISHED")
    assert.equal(store.getResult("user").status, "FINISHED")
  } finally {
    process.chdir(cwd)
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
