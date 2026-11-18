import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import homepage from "./index.html";

const PORT = Number(process.env.PORT) || 4317;
const APP_DIR = import.meta.dir;
const LIBRARY = path.resolve(APP_DIR, "../unzipped-fonts");
const ROOTS_FILE = path.join(APP_DIR, "data", "roots.json");

const FONT_EXT = new Set(["otf", "ttf", "woff", "woff2", "otc", "ttc"]);
const RANK: Record<string, number> = { woff2: 5, woff: 4, otf: 3, ttf: 2, otc: 1, ttc: 1 };
const MIME: Record<string, string> = {
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
  otc: "font/collection",
  ttc: "font/collection",
};

type Root = { id: string; path: string; label: string };
type RootView = Root & { missing: boolean; error: string | null; faceCount: number };
type Face = {
  id: string;
  rootId: string;
  pack: string;
  name: string;
  ext: string;
  bytes: number;
  rel: string;
};

let roots: Root[] = [];
let faces: Face[] = [];
let files = new Map<string, string>();
let rootMeta = new Map<string, { missing: boolean; error: string | null }>();
let revision = 0;
let ready = false;
let scanGen = 0;
const watchers = new Map<string, FSWatcher>();
let rescanTimer: ReturnType<typeof setTimeout> | null = null;

function hashId(value: string): string {
  return new Bun.CryptoHasher("sha1").update(value).digest("hex").slice(0, 16);
}

function prettyStem(stem: string): string {
  return stem.replace(/[_]+/g, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function extOf(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot >= 0 ? file.slice(dot + 1).toLowerCase() : "";
}

async function loadRoots(): Promise<void> {
  await mkdir(path.dirname(ROOTS_FILE), { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(ROOTS_FILE, "utf8")) as Root[];
    if (Array.isArray(parsed)) {
      roots = parsed.filter((root) => root && typeof root.path === "string" && typeof root.id === "string");
    }
  } catch {
    roots = [];
  }
  if (roots.length === 0) {
    try {
      const info = await stat(LIBRARY);
      if (info.isDirectory()) {
        roots = [{ id: hashId(LIBRARY.toLowerCase()), path: LIBRARY, label: "Ludvig library" }];
        await saveRoots();
      }
    } catch {
      roots = [];
    }
  }
}

async function saveRoots(): Promise<void> {
  await mkdir(path.dirname(ROOTS_FILE), { recursive: true });
  await writeFile(ROOTS_FILE, JSON.stringify(roots, null, 2));
}

function scheduleRescan(): void {
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    void scanAll();
  }, 500);
}

function bindWatch(root: Root): void {
  watchers.get(root.id)?.close();
  watchers.delete(root.id);
  try {
    const watcher = watch(root.path, { recursive: true }, () => scheduleRescan());
    watcher.on("error", () => {
      watcher.close();
      watchers.delete(root.id);
    });
    watchers.set(root.id, watcher);
  } catch {
    watchers.delete(root.id);
  }
}

function rebindWatchers(): void {
  const live = new Set(roots.map((root) => root.id));
  for (const [id, watcher] of watchers) {
    if (!live.has(id)) {
      watcher.close();
      watchers.delete(id);
    }
  }
  for (const root of roots) {
    if (!watchers.has(root.id)) bindWatch(root);
  }
}

async function scanRoot(root: Root): Promise<{ faces: Face[]; files: Map<string, string> }> {
  const found = new Map<string, { face: Face; abs: string; rank: number }>();
  const glob = new Bun.Glob("**/*.{otf,ttf,woff,woff2,otc,ttc,OTF,TTF,WOFF,WOFF2,OTC,TTC}");
  for await (const relPosix of glob.scan({ cwd: root.path, onlyFiles: true })) {
    const rel = relPosix.replaceAll("\\", "/");
    const parts = rel.split("/");
    if (parts.some((part) => part === "node_modules" || part === "__MACOSX" || part.startsWith("."))) continue;
    const filename = parts[parts.length - 1] ?? "";
    if (filename.startsWith("._")) continue;
    const ext = extOf(filename);
    if (!FONT_EXT.has(ext)) continue;
    const abs = path.join(root.path, ...parts);
    const file = Bun.file(abs);
    const bytes = file.size;
    if (!bytes) continue;
    const stem = filename.slice(0, filename.length - ext.length - 1);
    const parent = parts.length >= 2 ? parts[parts.length - 2]! : root.label;
    const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const key = `${norm(parent)}/${norm(stem)}`;
    const rank = RANK[ext] ?? 0;
    const current = found.get(key);
    if (current && current.rank >= rank) continue;
    const pack = parts.length > 2 ? `${parts[0]} / ${parent}` : parts.length === 2 ? parts[0]! : root.label;
    const face: Face = {
      id: hashId(abs.toLowerCase()),
      rootId: root.id,
      pack,
      name: prettyStem(stem) || stem,
      ext,
      bytes,
      rel,
    };
    found.set(key, { face, abs, rank });
  }
  const faceList: Face[] = [];
  const fileMap = new Map<string, string>();
  for (const item of found.values()) {
    faceList.push(item.face);
    fileMap.set(item.face.id, item.abs);
  }
  faceList.sort((a, b) => a.pack.localeCompare(b.pack) || a.name.localeCompare(b.name));
  return { faces: faceList, files: fileMap };
}

async function scanAll(): Promise<void> {
  const gen = ++scanGen;
  const nextFaces: Face[] = [];
  const nextFiles = new Map<string, string>();
  const nextMeta = new Map<string, { missing: boolean; error: string | null }>();
  for (const root of roots) {
    try {
      const info = await stat(root.path);
      if (!info.isDirectory()) {
        nextMeta.set(root.id, { missing: true, error: "That path is not a folder." });
        continue;
      }
      const scanned = await scanRoot(root);
      if (gen !== scanGen) return;
      nextFaces.push(...scanned.faces);
      for (const [id, abs] of scanned.files) nextFiles.set(id, abs);
      nextMeta.set(root.id, { missing: false, error: null });
    } catch (error) {
      nextMeta.set(root.id, {
        missing: true,
        error: error instanceof Error ? error.message : "Nightgrass could not read that folder.",
      });
    }
  }
  if (gen !== scanGen) return;
  faces = nextFaces;
  files = nextFiles;
  rootMeta = nextMeta;
  ready = true;
  revision += 1;
  console.log(`Nightgrass indexed ${faces.length} faces from ${roots.length} folder${roots.length === 1 ? "" : "s"}.`);
}

function catalog() {
  const counts = new Map<string, number>();
  for (const face of faces) counts.set(face.rootId, (counts.get(face.rootId) ?? 0) + 1);
  const view: RootView[] = roots.map((root) => {
    const meta = rootMeta.get(root.id);
    return {
      ...root,
      missing: meta?.missing ?? false,
      error: meta?.error ?? null,
      faceCount: counts.get(root.id) ?? 0,
    };
  });
  let libraryMounted = false;
  try {
    const libraryKey = path.resolve(LIBRARY).toLowerCase();
    libraryMounted = roots.some((root) => path.resolve(root.path).toLowerCase() === libraryKey);
  } catch {
    libraryMounted = false;
  }
  return {
    ready,
    revision,
    libraryPath: LIBRARY,
    libraryMounted,
    roots: view,
    faces,
  };
}

async function addRoot(folderPath: string): Promise<{ error?: string }> {
  let resolved: string;
  try {
    const info = await stat(folderPath);
    if (!info.isDirectory()) return { error: "That path is not a folder." };
    resolved = await realpath(folderPath);
  } catch {
    return { error: "Nightgrass cannot read that folder." };
  }
  const key = resolved.toLowerCase();
  if (roots.some((root) => root.path.toLowerCase() === key)) return { error: "That folder is already open." };
  if (roots.length >= 24) return { error: "Nightgrass is already watching 24 folders." };
  const root: Root = { id: hashId(key), path: resolved, label: path.basename(resolved) || resolved };
  roots.push(root);
  await saveRoots();
  bindWatch(root);
  void scanAll();
  return {};
}

async function pickFolder(): Promise<{ cancelled?: boolean; error?: string; path?: string }> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a folder of fonts'
$dialog.ShowNewFolderButton = $false
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`.trim();
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-STA", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: false,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    return { error: stderr.trim() || "The folder window did not open." };
  }
  const selected = stdout.trim();
  if (!selected) return { cancelled: true };
  return { path: selected };
}

function fontResponse(abs: string, req: Request): Response {
  const file = Bun.file(abs);
  const size = file.size;
  const ext = extOf(abs);
  const headers: Record<string, string> = {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };
  const range = req.headers.get("range");
  if (!range) {
    headers["Content-Length"] = String(size);
    return new Response(file, { headers });
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  let start = 0;
  let end = size - 1;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
  } else {
    start = Number(match[1]);
    if (match[2] !== "") end = Number(match[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  end = Math.min(end, size - 1);
  headers["Content-Length"] = String(end - start + 1);
  headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return new Response(file.slice(start, end + 1), { status: 206, headers });
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

await loadRoots();
rebindWatchers();
void scanAll();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  routes: {
    "/": homepage,
    "/api/catalog": {
      GET: () => json(catalog()),
    },
    "/api/revision": {
      GET: () => json({ revision, ready }),
    },
    "/api/font/:id": {
      GET: (req) => {
        const abs = files.get(req.params.id);
        if (!abs) return json({ error: "That face is not in an open folder." }, 404);
        return fontResponse(abs, req);
      },
    },
    "/api/roots": {
      POST: async (req) => {
        let body: { path?: string; pick?: boolean; useLibrary?: boolean } = {};
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return json({ error: "Send a folder path." }, 400);
        }
        if (body.pick) {
          const picked = await pickFolder();
          if (picked.cancelled) return json({ cancelled: true, ...catalog() });
          if (picked.error || !picked.path) return json({ error: picked.error ?? "The folder window did not open." }, 400);
          body.path = picked.path;
        } else if (body.useLibrary) {
          body.path = LIBRARY;
        }
        if (!body.path || typeof body.path !== "string") return json({ error: "Send a folder path." }, 400);
        const added = await addRoot(body.path);
        if (added.error) return json({ error: added.error, ...catalog() }, 400);
        return json(catalog());
      },
    },
    "/api/roots/:id": {
      DELETE: async (req) => {
        const before = roots.length;
        roots = roots.filter((root) => root.id !== req.params.id);
        if (roots.length === before) return json({ error: "That folder is not open." }, 404);
        watchers.get(req.params.id)?.close();
        watchers.delete(req.params.id);
        await saveRoots();
        void scanAll();
        return json(catalog());
      },
    },
  },
  fetch() {
    return new Response("Not found", { status: 404 });
  },
  development: process.env.NODE_ENV !== "production",
});

console.log(`Nightgrass is at http://${server.hostname}:${server.port}`);
