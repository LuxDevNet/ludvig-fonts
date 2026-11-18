type Face = {
  id: string;
  rootId: string;
  pack: string;
  name: string;
  ext: string;
  bytes: number;
  rel: string;
};

type RootView = {
  id: string;
  path: string;
  label: string;
  missing: boolean;
  error: string | null;
  faceCount: number;
};

type Catalog = {
  ready: boolean;
  revision: number;
  libraryPath: string;
  libraryMounted: boolean;
  roots: RootView[];
  faces: Face[];
};

const PRESETS: Record<string, string> = {
  night: "Fireflies over wet grass",
  pangram: "The quick brown fox jumps over the lazy dog",
  reading: "Night air sits on the pond. Grass ticks against the path and the letters keep their shape.",
  figures: "0123456789  !?&@  (meadow)",
};

const PAGE = 60;
const loaded = new Set<string>();
const expanded = new Set<string>();
const revealed = new Set<string>();
const held: string[] = [];

let catalog: Catalog | null = null;
let revision = -1;
let selected: string | null = null;
let query = "";
let loadToken = 0;
let booted = false;

const $ = <T extends Element>(id: string) => document.getElementById(id) as T;

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[char] ?? char;
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function packKey(face: Face): string {
  return `${face.rootId}/${face.pack}`;
}

function packLabel(pack: string): string {
  return pack.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

function scenery(): void {
  const ground = $("ground");
  const blades = Array.from({ length: 56 }, (_, index) => {
    const left = (index / 55) * 100;
    const height = 48 + ((index * 37) % 84);
    const lean = ((index % 7) - 3) * 2.2;
    const swing = 3 + (index % 5);
    const width = 5 + (index % 4);
    const tip = index % 5 === 0 ? "var(--firefly)" : "#b6f7a4";
    const delay = `${(index % 9) * -0.4}s`;
    const duration = `${4.2 + (index % 6) * 0.45}s`;
    return `<span class="blade" style="left:${left}%;--h:${height}px;--w:${width}px;--lean:${lean}deg;--swing:${swing}deg;--tip:${tip};--delay:${delay};--dur:${duration}"></span>`;
  });
  const lights = [
    [12, 40],
    [28, 70],
    [47, 28],
    [63, 64],
    [81, 36],
    [92, 72],
  ].map(([left, bottom], index) => {
    return `<span class="firefly-dot" style="left:${left}%;bottom:${bottom}px;--dur:${3 + index * 0.6}s"></span>`;
  });
  const stars = [18, 54, 76].map((left, index) => {
    return `<svg class="spark" style="left:${left}%;bottom:${80 + index * 8}px" viewBox="0 0 20 20"><path d="M10 0 L11.6 8.4 L20 10 L11.6 11.6 L10 20 L8.4 11.6 L0 10 L8.4 8.4 Z"/></svg>`;
  });
  ground.innerHTML = blades.join("") + lights.join("") + stars.join("");
}

function currentFace(): Face | undefined {
  return catalog?.faces.find((face) => face.id === selected);
}

function renderLede(): void {
  const lede = $("lede");
  if (!catalog?.ready) {
    lede.textContent = "Walking the folders…";
    return;
  }
  const count = catalog.faces.length;
  const folders = catalog.roots.length;
  lede.textContent = count
    ? `${count.toLocaleString()} faces streaming from ${folders} folder${folders === 1 ? "" : "s"}.`
    : "Choose a folder and the faces stream in.";
}

function renderRoots(): void {
  const host = $("roots");
  if (!catalog) {
    host.innerHTML = "";
    return;
  }
  const chips = catalog.roots.map((root) => {
    const title = root.missing ? root.error || "Folder missing" : root.path;
    return `<div class="root" title="${esc(title)}"><span>${esc(root.label)}</span><button type="button" data-remove="${esc(root.id)}">Remove</button></div>`;
  });
  if (!catalog.libraryMounted) {
    chips.push(`<button type="button" id="use-library">Add the Ludvig library</button>`);
  }
  host.innerHTML = chips.join("");
}

function renderList(): void {
  const host = $("list");
  const rail = $("rail");
  const top = rail.scrollTop;
  if (!catalog?.ready) {
    host.innerHTML = "";
    return;
  }
  const needle = query.trim().toLowerCase();
  if (needle) {
    const matches = catalog.faces.filter((face) => {
      return `${face.name} ${face.pack} ${face.rel}`.toLowerCase().includes(needle);
    });
    const shown = matches.slice(0, 120);
    host.innerHTML = shown.length
      ? `<div class="faces">${shown.map(faceButton).join("")}</div>${matches.length > shown.length ? `<p class="note">${matches.length - shown.length} more. Keep typing.</p>` : ""}`
      : `<p class="note">No faces match that.</p>`;
    rail.scrollTop = top;
    return;
  }
  const groups = new Map<string, Face[]>();
  for (const face of catalog.faces) {
    const key = packKey(face);
    const list = groups.get(key);
    if (list) list.push(face);
    else groups.set(key, [face]);
  }
  const html: string[] = [];
  for (const [key, group] of groups) {
    const open = expanded.has(key);
    const visible = revealed.has(key) ? group : group.slice(0, PAGE);
    html.push(`<section class="pack"><button type="button" data-pack="${esc(key)}" aria-expanded="${open}"><b>${esc(packLabel(group[0]?.pack || key))}</b><span>${group.length}</span></button>`);
    if (open) {
      html.push(`<div class="faces">${visible.map(faceButton).join("")}</div>`);
      if (visible.length < group.length) {
        html.push(`<button class="more" type="button" data-more="${esc(key)}">Show the rest (${group.length - visible.length})</button>`);
      }
    }
    html.push(`</section>`);
  }
  host.innerHTML = html.join("") || `<p class="note">This folder has no font files yet.</p>`;
  rail.scrollTop = top;
}

function faceButton(face: Face): string {
  const current = face.id === selected;
  const preview = current && loaded.has(face.id) ? ` style="font-family:'ng-${face.id}', Bahnschrift, sans-serif"` : "";
  return `<button class="face" type="button" data-face="${esc(face.id)}" aria-current="${current}"${preview}><span>${esc(face.name)}</span><small>${esc(face.ext)}</small></button>`;
}

function renderHeld(): void {
  const host = $("held");
  if (!held.length || !catalog) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = held
    .map((id) => catalog?.faces.find((face) => face.id === id))
    .filter((face): face is Face => Boolean(face))
    .map((face) => `<button type="button" data-held="${esc(face.id)}">${esc(face.name)}</button>`)
    .join("");
}

function renderMeta(): void {
  const face = currentFace();
  const name = $("face-name");
  const meta = $("face-meta");
  if (!face) {
    name.textContent = catalog?.ready ? "Pick a face" : "Walking the folders…";
    meta.textContent = "";
    document.title = "Nightgrass";
    return;
  }
  name.textContent = face.name;
  meta.textContent = `${packLabel(face.pack)}, ${face.ext}, ${formatBytes(face.bytes)}`;
  document.title = `${face.name}, Nightgrass`;
}

function applyMetrics(): void {
  const root = document.documentElement;
  root.style.setProperty("--sample-size", `${($("size") as HTMLInputElement).value}px`);
  root.style.setProperty("--track", `${Number(($("track") as HTMLInputElement).value) / 1000}em`);
  root.style.setProperty("--lead", `${Number(($("lead") as HTMLInputElement).value) / 100}`);
}

async function applyFace(id: string): Promise<void> {
  const token = ++loadToken;
  const face = catalog?.faces.find((item) => item.id === id);
  if (!face) return;
  selected = id;
  expanded.add(packKey(face));
  renderList();
  renderMeta();
  renderHeld();
  const status = $("status");
  status.textContent = "Streaming the file…";
  try {
    if (!loaded.has(id)) {
      const font = new FontFace(`ng-${id}`, `url(/api/font/${id})`);
      await font.load();
      if (token !== loadToken) return;
      document.fonts.add(font);
      loaded.add(id);
    }
    if (token !== loadToken) return;
    document.documentElement.style.setProperty("--face", `"ng-${id}"`);
    const face = currentFace();
    status.textContent = face ? `${formatBytes(face.bytes)} streamed` : "";
    renderList();
  } catch {
    if (token !== loadToken) return;
    status.textContent = "This file did not load as a font.";
  }
}

function chooseInitial(): void {
  if (!catalog?.faces.length) {
    selected = null;
    renderMeta();
    return;
  }
  if (selected && catalog.faces.some((face) => face.id === selected)) return;
  const preferred =
    catalog.faces.find((face) => face.pack === "lemon_milk" && /regular/i.test(face.name)) ||
    catalog.faces.find((face) => face.pack === "lemon_milk") ||
    catalog.faces[0];
  if (!preferred) return;
  expanded.add(packKey(preferred));
  void applyFace(preferred.id);
}

async function refresh(): Promise<void> {
  const next = (await (await fetch("/api/catalog")).json()) as Catalog;
  if (next.revision === revision && booted) return;
  revision = next.revision;
  catalog = next;
  booted = true;
  renderLede();
  renderRoots();
  renderList();
  renderHeld();
  chooseInitial();
}

async function postRoot(body: Record<string, unknown>): Promise<void> {
  const note = $("note");
  note.textContent = body.pick ? "Waiting for the folder window…" : "";
  const response = await fetch("/api/roots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as Catalog & { error?: string; cancelled?: boolean };
  if (payload.cancelled) {
    note.textContent = "";
    return;
  }
  if (!response.ok) {
    note.textContent = payload.error || "That folder did not open.";
    if (payload.faces) {
      catalog = payload;
      revision = payload.revision;
      renderLede();
      renderRoots();
      renderList();
    }
    return;
  }
  note.textContent = "";
  catalog = payload;
  revision = payload.revision;
  renderLede();
  renderRoots();
  renderList();
  chooseInitial();
}

function wire(): void {
  $("search").addEventListener("input", (event) => {
    query = (event.target as HTMLInputElement).value;
    renderList();
  });
  $("pick").addEventListener("click", () => {
    void postRoot({ pick: true });
  });
  $("path-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("path-input") as HTMLInputElement;
    const folder = input.value.trim();
    if (!folder) return;
    void postRoot({ path: folder }).then(() => {
      input.value = "";
    });
  });
  $("roots").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.id === "use-library") {
      void postRoot({ useLibrary: true });
      return;
    }
    const remove = target.closest<HTMLElement>("[data-remove]");
    if (!remove?.dataset.remove) return;
    void fetch(`/api/roots/${remove.dataset.remove}`, { method: "DELETE" }).then(() => refresh());
  });
  $("list").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const more = target.closest<HTMLElement>("[data-more]");
    if (more?.dataset.more) {
      revealed.add(more.dataset.more);
      expanded.add(more.dataset.more);
      renderList();
      return;
    }
    const face = target.closest<HTMLElement>("[data-face]");
    if (face?.dataset.face) {
      void applyFace(face.dataset.face);
      return;
    }
    const pack = target.closest<HTMLElement>("[data-pack]");
    if (!pack?.dataset.pack) return;
    if (expanded.has(pack.dataset.pack)) expanded.delete(pack.dataset.pack);
    else expanded.add(pack.dataset.pack);
    renderList();
  });
  $("held").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-held]");
    if (button?.dataset.held) void applyFace(button.dataset.held);
  });
  document.body.addEventListener("click", (event) => {
    const preset = (event.target as HTMLElement).closest<HTMLElement>("[data-preset]");
    if (!preset?.dataset.preset) return;
    const text = PRESETS[preset.dataset.preset];
    if (!text) return;
    const specimen = $("specimen");
    specimen.textContent = text;
    specimen.focus();
  });
  for (const id of ["size", "track", "lead"]) {
    $(id).addEventListener("input", applyMetrics);
  }
  $("ink-mist").addEventListener("click", () => setInk("mist"));
  $("ink-dew").addEventListener("click", () => setInk("dew"));
  $("align-left").addEventListener("click", () => setAlign("left"));
  $("align-center").addEventListener("click", () => setAlign("center"));
  $("hold").addEventListener("click", () => {
    if (!selected) return;
    const index = held.indexOf(selected);
    if (index >= 0) held.splice(index, 1);
    else {
      held.unshift(selected);
      held.splice(6);
    }
    renderHeld();
  });
  const specimen = $("specimen");
  if (!specimen.textContent?.trim()) specimen.textContent = PRESETS.night;
}

function setInk(ink: "mist" | "dew"): void {
  $("stage").dataset.ink = ink;
  $("ink-mist").setAttribute("aria-pressed", String(ink === "mist"));
  $("ink-dew").setAttribute("aria-pressed", String(ink === "dew"));
}

function setAlign(align: "left" | "center"): void {
  document.documentElement.style.setProperty("--align", align);
  $("align-left").setAttribute("aria-pressed", String(align === "left"));
  $("align-center").setAttribute("aria-pressed", String(align === "center"));
}

function listen(): void {
  window.setInterval(() => {
    void fetch("/api/revision")
      .then((response) => response.json())
      .then((payload: { revision: number }) => {
        if (payload.revision !== revision) void refresh();
      })
      .catch(() => undefined);
  }, 2000);
}

scenery();
applyMetrics();
wire();
void refresh();
listen();
