// Updating from the notice, end to end and offline: a local server stands in
// for GitHub's releases, with a "99.0.0" whose AppImage is a script, and the
// app replaces a stand-in for its own AppImage with it, quits, and starts it.
// The script, as the "new app", writes down whether the old one was gone.
//
// A debug build only, which reads ROER_UPDATE_RELEASES and ROER_UPDATE_TARGET
// (see updates.rs); a release build ignores both. Linux only: the restart
// waits through /bin/sh, and Windows updates through its setup instead.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { Roer } from "./harness.mjs";

const VERSION = "99.0.0";
const ASSET = `Roer_${VERSION}_amd64.AppImage`;
const OLD = "#!/bin/sh\necho the old Roer\n";
// The "new app": started once the old one has quit, it says whether any
// roer-app is still running, through /proc as nothing else may be installed.
const NEW = `#!/bin/sh
for p in /proc/[0-9]*; do
  if [ "$(cat "$p/comm" 2>/dev/null)" = roer-app ]; then echo "roer-app still running" > "$ROER_E2E_STARTED"; exit; fi
done
echo started > "$ROER_E2E_STARTED"
`;

/** GitHub's releases, as far as the app asks: `latest` redirects to the
 * release's tag, and its files are under `download/<tag>`. `sum` is the
 * checksum SHA256SUMS.txt gives the AppImage. Resolves to the server and
 * its address once it listens. */
function releases(sum) {
  const files = {
    [`/releases/download/v${VERSION}/SHA256SUMS.txt`]: `${sum}  ${ASSET}\n`,
    [`/releases/download/v${VERSION}/${ASSET}`]: NEW,
  };
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}/releases`;
    if (req.url === "/releases/latest") {
      res.writeHead(302, { Location: `${base}/tag/v${VERSION}`, "Content-Length": 0 });
      res.end();
      return;
    }
    const body = files[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => done({ server, url: `http://127.0.0.1:${server.address().port}/releases` })),
  );
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The app, pointed at `url` for releases and at a stand-in AppImage. */
async function launch(url) {
  const app = new Roer({
    env: (root) => ({
      ROER_UPDATE_RELEASES: url,
      ROER_UPDATE_TARGET: join(root, "Roer.AppImage"),
      ROER_E2E_STARTED: join(root, "started"),
    }),
  });
  app.target = join(app.root, "Roer.AppImage");
  app.started = join(app.root, "started");
  writeFileSync(app.target, OLD, { mode: 0o755 });
  // Claude Code's setup is not what this is about.
  mkdirSync(app.roerHome, { recursive: true });
  writeFileSync(join(app.roerHome, "claude-setup-asked"), "");
  await app.start();
  return app;
}

let app;
let server;

afterEach(async (t) => {
  if (app) {
    await app.keep(t.name);
    await app.stop();
  }
  server?.close();
  app = server = undefined;
});

const linux = process.platform === "linux";

test("Update and restart installs the new version in place and starts it", { skip: !linux }, async () => {
  let url;
  ({ server, url } = await releases(sha256(NEW)));
  app = await launch(url);
  // The app's own check, ten seconds after launch.
  await app.waitForText(`Roer ${VERSION} is available`, ".update-notice", 30_000);
  await app.click("Update and restart");

  await app.until("the new version to start", () => existsSync(app.started), 30_000);
  assert.equal(readFileSync(app.started, "utf8").trim(), "started", "the new version started only once the old app had quit");
  assert.equal(readFileSync(app.target, "utf8"), NEW, "the AppImage was replaced by the new one");
});

test("a download that does not match the release's checksum is not installed", { skip: !linux }, async () => {
  let url;
  ({ server, url } = await releases(sha256("something else")));
  app = await launch(url);
  await app.waitForText(`Roer ${VERSION} is available`, ".update-notice", 30_000);
  await app.click("Update and restart");

  await app.waitForText("does not match the release's checksum", ".update-notice");
  // Download is still there, for the release's page.
  await app.button("Download");
  assert.equal(readFileSync(app.target, "utf8"), OLD, "the old AppImage is left as it was");
  assert.ok(!existsSync(app.started), "nothing new was started");
});
