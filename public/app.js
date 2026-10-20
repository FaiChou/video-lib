const $ = (id) => document.getElementById(id);
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  sort: '<path d="M7 4v16m-3-3 3 3 3-3M14 5h6m-6 5h4m-4 5h2"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 11.5-2L20 8M4 16l2.5 3A7 7 0 0 0 18 17"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  play: '<path d="m9 5 11 7-11 7z"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  arrowLeft: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  chevronLeft: '<path d="m14 6-6 6 6 6"/>',
  chevronRight: '<path d="m10 6 6 6-6 6"/>',
  film: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18M16 3v18M4 8h4m8 0h4M4 16h4m8 0h4M8 12h8"/>',
  folder:
    '<path d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
};
function icon(name) {
  const span = document.createElement("span");
  span.dataset.icon = name;
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.film}</svg>`;
  return span;
}
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => el.replaceChildren(...icon(el.dataset.icon).childNodes));
function el(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function button(text, className, action, iconName) {
  const item = el("button", className);
  item.type = "button";
  if (iconName) item.append(icon(iconName));
  if (text) item.append(document.createTextNode(text));
  if (action) item.addEventListener("click", action);
  return item;
}
const params = new URLSearchParams(location.search);
const state = {
  videos: [],
  users: [],
  selected: new Set(params.getAll("user")),
  search: params.get("q") || "",
  sort: params.get("sort") === "asc" ? "asc" : "desc",
  page: Math.max(1, Number(params.get("page")) || 1),
  pageSize: [50, 100, 200, 500].includes(Number(params.get("size")))
    ? Number(params.get("size"))
    : 100,
  today: "",
  timeZone: "Asia/Shanghai",
  maxUploadBytes: 2 * 1024 ** 3,
  loaded: false,
};
let loadGeneration = 0,
  queue = [],
  uploading = false,
  toastTimer,
  thumbnails;
const palette = [
  ["#f0e8f7", "#9e7cb7"],
  ["#e5f0eb", "#719e87"],
  ["#fff0db", "#b99b68"],
  ["#e6eefb", "#7c96bc"],
  ["#fce5ec", "#c17f94"],
];
function avatar(name) {
  const seed = [...name].reduce((n, c) => n + c.codePointAt(0), 0);
  const [bg, color] = palette[seed % palette.length];
  const a = el("span", "avatar", [...name][0]?.toUpperCase() || "?");
  a.style.background = bg;
  a.style.color = color;
  a.setAttribute("aria-hidden", "true");
  return a;
}
function formatSize(n) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
function showToast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 4000);
}
async function api(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}
function syncURL() {
  const p = new URLSearchParams();
  [...state.selected].forEach((name) => p.append("user", name));
  if (state.search) p.set("q", state.search);
  if (state.sort !== "desc") p.set("sort", state.sort);
  if (state.page > 1) p.set("page", state.page);
  if (state.pageSize !== 100) p.set("size", state.pageSize);
  const query = p.toString();
  history.replaceState(
    null,
    "",
    `${location.pathname}${query ? "?" + query : ""}${location.hash}`,
  );
}
function renderFilters() {
  const all = button("全部用户", "filter-chip", () => {
    state.selected.clear();
    state.page = 1;
    renderLibrary();
  });
  all.setAttribute("aria-pressed", String(!state.selected.size));
  all.append(el("span", "filter-count", String(state.videos.length)));
  const fragment = document.createDocumentFragment();
  fragment.append(all);
  for (const user of state.users) {
    const b = button("", "filter-chip", () => {
      state.selected.has(user.name)
        ? state.selected.delete(user.name)
        : state.selected.add(user.name);
      state.page = 1;
      renderLibrary();
    });
    b.append(
      avatar(user.name),
      document.createTextNode(user.name),
      el("span", "filter-count", String(user.count)),
    );
    b.setAttribute("aria-pressed", String(state.selected.has(user.name)));
    fragment.append(b);
  }
  $("userFilters").replaceChildren(fragment);
}
function filteredVideos() {
  return state.videos
    .filter(
      (v) =>
        (!state.selected.size || state.selected.has(v.user)) &&
        v.name.toLocaleLowerCase().includes(state.search.toLocaleLowerCase()),
    )
    .sort((a, b) => {
      const date = a.date.localeCompare(b.date);
      return (
        (state.sort === "desc" ? -date : date) ||
        a.user.localeCompare(b.user, "zh-CN") ||
        a.name.localeCompare(b.name, "zh-CN", { numeric: true })
      );
    });
}
function clearThumbs() {
  thumbnails?.disconnect();
  $("videoGrid")
    .querySelectorAll("video")
    .forEach((video) => {
      video.removeAttribute("src");
      video.load();
    });
}
function card(video) {
  const article = el("article", "video-card");
  const thumb = button("", "thumbnail", () => openPlayer(video));
  thumb.setAttribute("aria-label", `播放 ${video.name}`);
  const fallback = el("span", "thumb-fallback");
  fallback.append(icon("film"));
  const preview = el("video");
  preview.muted = true;
  preview.playsInline = true;
  preview.preload = "metadata";
  preview.tabIndex = -1;
  preview.setAttribute("aria-hidden", "true");
  preview.dataset.src = video.url + "#t=0.1";
  const play = el("span", "thumb-play");
  play.append(icon("play"));
  const duration = el(
    "span",
    "duration",
    video.name.split(".").pop().toUpperCase(),
  );
  preview.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(preview.duration)) {
      const seconds = Math.floor(preview.duration);
      duration.textContent =
        seconds >= 3600
          ? `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
          : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }
  });
  preview.addEventListener(
    "error",
    () => {
      preview.hidden = true;
    },
    { once: true },
  );
  thumb.append(fallback, preview, play, duration);
  const info = el("div", "video-info");
  const name = button(video.name, "video-name", () => openPlayer(video));
  name.title = video.name;
  name.setAttribute("aria-label", `播放 ${video.name}`);
  const meta = el("div", "video-meta");
  const user = el("span", "user-label", video.user);
  user.title = video.user;
  const date = el("time", "meta-date", video.date.replaceAll("-", "."));
  date.dateTime = video.date;
  if (video.dateSource === "modified")
    date.title = "文件名无有效日期，按文件修改日期显示";
  meta.append(avatar(video.user), user, date);
  info.append(name, meta);
  const footer = el("div", "card-footer");
  const download = el("a", "card-action");
  download.href = video.downloadUrl;
  download.download = video.name;
  download.setAttribute("aria-label", `下载 ${video.name}`);
  download.append(icon("download"), document.createTextNode("下载"));
  footer.append(
    el("span", "file-size", formatSize(video.size)),
    button("播放", "card-action", () => openPlayer(video), "play"),
    download,
  );
  article.append(thumb, info, footer);
  return article;
}
function renderEmpty(mode, message) {
  $("emptyState").hidden = false;
  const wrap = el("span", "empty-icon");
  wrap.append(icon(mode === "error" ? "refresh" : "film"));
  const title = el(
    "h3",
    "",
    mode === "error"
      ? "暂时没能读取视频"
      : mode === "filtered"
        ? "还没有找到这个片刻"
        : "这里，等你的第一个片刻",
  );
  const detail = el("p");
  if (mode === "error") detail.textContent = message;
  else if (mode === "filtered")
    detail.textContent = "换个关键词，或者试试其他用户。";
  else
    detail.append(
      "上传一些视频，或将用户文件夹放入 ",
      el("code", "", "videos/"),
      "，然后刷新页面。",
    );
  const action = button(
    mode === "error"
      ? "重新读取"
      : mode === "filtered"
        ? "清除筛选"
        : "上传第一个视频",
    "button primary",
    mode === "error"
      ? () => loadLibrary()
      : mode === "filtered"
        ? () => {
            state.selected.clear();
            state.search = "";
            $("searchInput").value = "";
            state.page = 1;
            renderLibrary();
          }
        : openUpload,
    mode === "error" ? "refresh" : mode === "filtered" ? "close" : "plus",
  );
  $("emptyState").replaceChildren(wrap, title, detail, action);
}
function renderPagination(total, pages) {
  $("paginationBar").hidden = !total;
  $("pageSummary").textContent = `第 ${state.page} / ${pages} 页`;
  const nav = $("pagination");
  nav.replaceChildren();
  const go = (p) => {
    state.page = p;
    renderLibrary();
    document
      .querySelector(".collection")
      .scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const prev = button(
    "",
    "page-button arrow",
    () => go(state.page - 1),
    "chevronLeft",
  );
  prev.disabled = state.page === 1;
  prev.setAttribute("aria-label", "上一页");
  nav.append(prev);
  const numbers = [
    ...new Set([1, state.page - 1, state.page, state.page + 1, pages]),
  ]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
  let last = 0;
  for (const n of numbers) {
    if (last && n - last > 1) nav.append(el("span", "page-gap", "…"));
    const b = button(String(n), "page-button", () => go(n));
    b.setAttribute("aria-label", `第 ${n} 页`);
    if (n === state.page) b.setAttribute("aria-current", "page");
    nav.append(b);
    last = n;
  }
  const next = button(
    "",
    "page-button arrow",
    () => go(state.page + 1),
    "chevronRight",
  );
  next.disabled = state.page === pages;
  next.setAttribute("aria-label", "下一页");
  nav.append(next);
}
function renderLibrary() {
  renderFilters();
  const videos = filteredVideos();
  const pages = Math.max(1, Math.ceil(videos.length / state.pageSize));
  state.page = Math.min(Math.max(1, Math.floor(state.page)), pages);
  const start = (state.page - 1) * state.pageSize;
  $("totalCount").textContent = String(state.videos.length);
  $("collectionTitle").textContent = state.selected.size
    ? "筛选片刻"
    : "全部片刻";
  $("resultSummary").textContent = videos.length
    ? `共 ${videos.length} 个视频 · 正在展示 ${start + 1}–${Math.min(start + state.pageSize, videos.length)} 个`
    : "共 0 个视频";
  clearThumbs();
  $("videoGrid").replaceChildren(
    ...videos.slice(start, start + state.pageSize).map(card),
  );
  $("emptyState").hidden = !!videos.length;
  if (!videos.length)
    renderEmpty(
      state.videos.length || state.selected.size || state.search
        ? "filtered"
        : "empty",
    );
  renderPagination(videos.length, pages);
  syncURL();
  thumbnails = new IntersectionObserver(
    (entries) =>
      entries.forEach(({ target, isIntersecting }) => {
        if (isIntersecting) {
          target.src = target.dataset.src;
          thumbnails.unobserve(target);
        }
      }),
    { rootMargin: "200px" },
  );
  $("videoGrid")
    .querySelectorAll("video")
    .forEach((v) => thumbnails.observe(v));
}
function updateUserOptions() {
  const old = $("uploadUser").value;
  $("uploadUser").replaceChildren();
  if (!state.users.length) {
    const option = el("option", "", "请先新建一个用户");
    option.value = "";
    $("uploadUser").append(option);
  }
  for (const user of state.users) {
    const option = el("option", "", user.name);
    option.value = user.name;
    $("uploadUser").append(option);
  }
  if (state.users.some((u) => u.name === old)) $("uploadUser").value = old;
  else if (
    state.selected.size === 1 &&
    state.users.some((u) => state.selected.has(u.name))
  )
    $("uploadUser").value = [...state.selected][0];
  updateUploadButton();
}
async function loadLibrary({ notify = false } = {}) {
  const generation = ++loadGeneration;
  $("refreshButton").disabled = true;
  $("refreshButton").classList.add("spinning");
  try {
    const data = await api("/api/library");
    if (generation !== loadGeneration) return;
    state.videos = data.videos;
    state.users = data.users;
    state.today = data.today;
    state.timeZone = data.timeZone || "Asia/Shanghai";
    state.maxUploadBytes = data.maxUploadBytes;
    state.loaded = true;
    state.selected = new Set(
      [...state.selected].filter((name) =>
        state.users.some((u) => u.name === name),
      ),
    );
    renderLibrary();
    updateUserOptions();
    if (notify) showToast("视频库已刷新");
  } catch (error) {
    if (generation !== loadGeneration) return;
    clearThumbs();
    $("videoGrid").replaceChildren();
    $("paginationBar").hidden = true;
    $("resultSummary").textContent = "读取失败";
    renderEmpty("error", `请确认本地服务正在运行。${error.message}`);
    showToast("无法连接视频库，请重试");
  } finally {
    if (generation === loadGeneration) {
      $("refreshButton").disabled = false;
      $("refreshButton").classList.remove("spinning");
    }
  }
}
function route() {
  const upload =
    location.hash === "#upload" ||
    (!location.hash && /^\/upload\/?$/.test(location.pathname));
  $("libraryView").hidden = upload;
  $("uploadView").hidden = !upload;
  document.title = upload ? "上传视频 · 片刻" : "片刻 · 视频收藏";
}
function openPlayer(video) {
  $("playerTitle").textContent = video.name;
  $("playerMeta").textContent =
    `${video.user} · ${video.date} · ${formatSize(video.size)}`;
  $("playerDownload").href = video.downloadUrl;
  $("playerDownload").download = video.name;
  $("playbackError").hidden = true;
  $("player").src = video.url;
  $("playerDialog").showModal();
  $("player")
    .play()
    .catch(() => {});
}
function stopPlayer() {
  $("player").pause();
  $("player").removeAttribute("src");
  $("player").load();
}
$("closePlayer").addEventListener("click", () => $("playerDialog").close());
$("playerDialog").addEventListener("close", stopPlayer);
$("player").addEventListener("error", () => {
  if ($("player").hasAttribute("src")) $("playbackError").hidden = false;
});
function closeOnBackdrop(dialog, callback) {
  dialog.addEventListener("click", (e) => {
    const rect = dialog.getBoundingClientRect();
    if (
      e.target === dialog &&
      (e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom)
    )
      callback();
  });
}
closeOnBackdrop($("playerDialog"), () => $("playerDialog").close());
function today() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: state.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return (
    Number.isFinite(d.getTime()) &&
    d.toISOString().slice(0, 10) === s &&
    Number(s.slice(0, 4)) >= 1000
  );
}
function getDate(name) {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})_/);
  if (m) {
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    if (validDate(d)) return { date: d, detected: true };
  }
  return { date: today(), detected: false };
}
function openUpload() {
  if (!state.loaded) {
    showToast("请先连接视频库，或点击刷新重试");
    return;
  }
  if (!uploading && queue.length && queue.every((q) => q.status === "success"))
    queue = [];
  $("uploadError").hidden = true;
  $("overallProgress").hidden = true;
  $("uploadFooterHint").textContent = "重名文件会自动编号，已有视频会保留。";
  $("newUserFields").hidden = state.users.length > 0;
  updateUserOptions();
  renderQueue();
  if (!$("uploadDialog").open) $("uploadDialog").showModal();
}
function closeUpload() {
  if (uploading) {
    showToast("正在上传，请等待当前批次完成");
    return;
  }
  $("uploadDialog").close();
}
function setUploadError(message) {
  $("uploadError").textContent = message;
  $("uploadError").hidden = !message;
}
function updateUploadButton() {
  const pending = queue.filter((q) => q.status !== "success");
  $("startUpload").disabled =
    uploading || !pending.length || !$("uploadUser").value;
  $("uploadButtonLabel").textContent = uploading
    ? "正在上传…"
    : pending.length
      ? `上传 ${pending.length} 个视频`
      : "开始上传";
}
function renderQueue() {
  $("queueHeading").hidden = !queue.length;
  $("queueCount").textContent = `已选择 ${queue.length} 个视频`;
  $("uploadQueue").replaceChildren();
  for (const item of queue) {
    const row = el("div", "queue-item");
    const fileIcon = el("span", "queue-file-icon");
    fileIcon.append(icon("film"));
    const info = el("div", "queue-file-info");
    const name = el("p", "queue-file-name", item.file.name);
    name.title = item.file.name;
    const status = el(
      "p",
      `queue-file-status ${item.status === "success" ? "success" : item.status === "failed" ? "failed" : ""}`,
      item.status === "success"
        ? `已保存为 ${item.savedName}`
        : item.status === "failed"
          ? item.error
          : item.status === "uploading"
            ? `上传中 · ${item.percent || 0}%`
            : `${formatSize(item.file.size)} · 等待上传`,
    );
    item.statusEl = status;
    info.append(name, status);
    const date = el("label", "queue-date");
    const input = el("input");
    input.type = "date";
    input.value = item.date;
    input.required = true;
    input.min = "1000-01-01";
    input.max = "9999-12-31";
    input.disabled = uploading || item.status === "success";
    input.setAttribute("aria-label", `${item.file.name} 的日期`);
    const hint = el(
      "span",
      "",
      item.detected ? "已识别文件名日期" : "未识别日期 · 默认今天",
    );
    input.addEventListener("change", () => {
      item.date = input.value;
      hint.textContent = "使用自定义日期";
    });
    date.append(input, hint);
    const remove = button(
      "",
      "queue-remove",
      () => {
        queue = queue.filter((q) => q !== item);
        renderQueue();
      },
      "close",
    );
    remove.disabled = uploading;
    remove.setAttribute("aria-label", `移除 ${item.file.name}`);
    row.append(fileIcon, info, date, remove);
    $("uploadQueue").append(row);
  }
  updateUploadButton();
}
function addFiles(files) {
  if (uploading) return;
  const rejected = [];
  for (const file of files) {
    if (!/\.(mp4|webm|mov|m4v)$/i.test(file.name)) {
      rejected.push(`${file.name}：不支持的格式`);
      continue;
    }
    if (!file.size) {
      rejected.push(`${file.name}：文件为空`);
      continue;
    }
    if (file.size > state.maxUploadBytes) {
      rejected.push(
        `${file.name}：超过 ${formatSize(state.maxUploadBytes)} 限制`,
      );
      continue;
    }
    if (
      queue.some(
        (q) =>
          q.file.name === file.name &&
          q.file.size === file.size &&
          q.file.lastModified === file.lastModified,
      )
    )
      continue;
    queue.push({ file, ...getDate(file.name), status: "ready" });
  }
  setUploadError(rejected.join("；"));
  $("overallProgress").hidden = true;
  renderQueue();
}
function lockUpload(locked) {
  uploading = locked;
  [
    "uploadUser",
    "toggleNewUser",
    "newUserName",
    "createUserButton",
    "dropZone",
    "fileInput",
    "closeUpload",
  ].forEach((id) => ($(id).disabled = locked));
  renderQueue();
}
function uploadFile(item, user, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const p = new URLSearchParams({
      user,
      name: item.file.name,
      date: item.date,
    });
    xhr.open("POST", `/api/upload?${p}`);
    xhr.setRequestHeader(
      "Content-Type",
      item.file.type || "application/octet-stream",
    );
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onerror = () => reject(new Error("网络连接中断，请重试"));
    xhr.onabort = () => reject(new Error("上传已中止"));
    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = { error: "服务器返回了无效响应" };
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `上传失败（${xhr.status}）`));
    };
    xhr.send(item.file);
  });
}
async function submitUploads(e) {
  e.preventDefault();
  if (uploading) return;
  const pending = queue.filter((q) => q.status !== "success");
  if (!pending.length) return;
  if (!$("uploadUser").value) {
    setUploadError("请选择或新建一个用户");
    return;
  }
  if (pending.some((q) => !validDate(q.date))) {
    setUploadError("请为每个视频填写有效日期");
    return;
  }
  if (!$("newUserFields").hidden && $("newUserName").value.trim()) {
    setUploadError("新用户名尚未创建，请先点击「创建」");
    return;
  }
  const user = $("uploadUser").value;
  setUploadError("");
  lockUpload(true);
  $("overallProgress").hidden = false;
  const bytes = pending.reduce((n, q) => n + q.file.size, 0);
  let completed = 0,
    success = 0;
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    item.status = "uploading";
    item.statusEl.className = "queue-file-status";
    item.statusEl.textContent = "正在准备上传…";
    $("progressLabel").textContent =
      `正在上传 ${i + 1} / ${pending.length} · ${item.file.name}`;
    try {
      const data = await uploadFile(item, user, (loaded, total) => {
        const progress = Math.round(((completed + loaded) / bytes) * 100);
        $("uploadProgress").value = progress;
        $("progressPercent").textContent = `${progress}%`;
        item.statusEl.textContent = `上传中 · ${Math.round((loaded / total) * 100)}%`;
      });
      item.status = "success";
      item.savedName = data.video.name;
      success++;
      item.statusEl.textContent = `已保存为 ${item.savedName}`;
      item.statusEl.classList.add("success");
    } catch (error) {
      item.status = "failed";
      item.error = error.message;
      item.statusEl.textContent = error.message;
      item.statusEl.classList.add("failed");
    }
    completed += item.file.size;
  }
  lockUpload(false);
  $("uploadProgress").value = 100;
  $("progressPercent").textContent = "100%";
  const failures = pending.length - success;
  $("progressLabel").textContent = failures
    ? `${success} 个上传成功，${failures} 个失败；可重试失败的视频。`
    : `${success} 个视频已放入 ${user} 的收藏`;
  $("uploadFooterHint").textContent = failures
    ? "点击上传按钮，只重试失败的视频。"
    : "上传完成，可以继续添加视频或关闭弹窗。";
  if (failures) setUploadError("部分视频上传失败，请查看每个文件下方的原因。");
  showToast(
    failures
      ? `${success} 个成功，${failures} 个失败`
      : `已上传 ${success} 个视频`,
  );
  await loadLibrary();
}
$("uploadForm").addEventListener("submit", submitUploads);
$("createUserButton").addEventListener("click", async () => {
  const name = $("newUserName").value.trim();
  if (!name) {
    setUploadError("请输入用户名");
    $("newUserName").focus();
    return;
  }
  $("createUserButton").disabled = true;
  try {
    const data = await api("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await loadLibrary();
    $("uploadUser").value = data.user.name;
    $("newUserName").value = "";
    $("newUserFields").hidden = true;
    setUploadError("");
    updateUploadButton();
    showToast(`已创建 ${data.user.name} 的收藏`);
  } catch (error) {
    setUploadError(error.message);
  } finally {
    $("createUserButton").disabled = false;
  }
});
$("newUserName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("createUserButton").click();
  }
});
$("toggleNewUser").addEventListener("click", () => {
  $("newUserFields").hidden = !$("newUserFields").hidden;
  if (!$("newUserFields").hidden) $("newUserName").focus();
});
$("uploadUser").addEventListener("change", updateUploadButton);
$("quickUpload").addEventListener("click", openUpload);
$("uploadEntry").addEventListener("click", openUpload);
$("closeUpload").addEventListener("click", closeUpload);
$("uploadDialog").addEventListener("cancel", (e) => {
  if (uploading) {
    e.preventDefault();
    showToast("正在上传，请等待当前批次完成");
  }
});
closeOnBackdrop($("uploadDialog"), closeUpload);
$("dropZone").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", () => {
  addFiles($("fileInput").files);
  $("fileInput").value = "";
});
for (const event of ["dragenter", "dragover"])
  $("dropZone").addEventListener(event, (e) => {
    e.preventDefault();
    if (!uploading) $("dropZone").classList.add("dragover");
  });
for (const event of ["dragleave", "drop"])
  $("dropZone").addEventListener(event, (e) => {
    e.preventDefault();
    $("dropZone").classList.remove("dragover");
  });
$("dropZone").addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
});
window.addEventListener("beforeunload", (e) => {
  if (uploading) {
    e.preventDefault();
    e.returnValue = "";
  }
});
$("searchInput").value = state.search;
$("sortSelect").value = state.sort;
$("pageSizeSelect").value = String(state.pageSize);
$("searchInput").addEventListener("input", () => {
  state.search = $("searchInput").value.trim();
  state.page = 1;
  renderLibrary();
});
$("sortSelect").addEventListener("change", () => {
  state.sort = $("sortSelect").value;
  state.page = 1;
  renderLibrary();
});
$("pageSizeSelect").addEventListener("change", () => {
  state.pageSize = Number($("pageSizeSelect").value);
  state.page = 1;
  renderLibrary();
});
$("refreshButton").addEventListener("click", () =>
  loadLibrary({ notify: true }),
);
window.addEventListener("hashchange", route);
for (let i = 0; i < 8; i++)
  $("videoGrid").append(el("div", "loading-placeholder"));
route();
loadLibrary();
