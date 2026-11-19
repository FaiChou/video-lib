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
  manage: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="9" cy="18" r="2" fill="currentColor"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  pause: '<path d="M8 5h3v14H8zM13 5h3v14h-3z"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
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
const pageSizes = Array.from({ length: 10 }, (_, i) => (i + 1) * 48);
const state = {
  videos: [],
  users: [],
  selected: params.get("user") || "",
  search: params.get("q") || "",
  hideProcessed: params.get("hideProcessed") === "1",
  sort: params.get("sort") === "asc" ? "asc" : "desc",
  page: Math.max(1, Number(params.get("page")) || 1),
  pageSize: pageSizes.includes(Number(params.get("size")))
    ? Number(params.get("size"))
    : 48,
  maxColumns: params.get("columns") === "4" ? 4 : 6,
  today: "",
  timeZone: "Asia/Shanghai",
  maxUploadBytes: 2 * 1024 ** 3,
  loaded: false,
  loadError: "",
  view: "library",
};
const management = {
  search: "",
  user: "",
  processed: "all",
  sort: "desc",
  page: 1,
  pageSize: 48,
  selected: new Set(),
};
function defaultExportSettings() {
  return {
    watermark: {
      enabled: false,
      text: "",
      color: "#ffffff",
      bold: false,
      backgroundColor: "#000000",
      backgroundOpacity: 0.55,
      borderRadius: 8,
      fontSize: 28,
      paddingX: 16,
      paddingY: 8,
      opacity: 1,
      x: 0.92,
      y: 0.92,
    },
    music: {
      enabled: false,
      file: "",
      volume: 0.35,
      loop: true,
      keepOriginalAudio: true,
    },
  };
}
function cloneExportSettings(settings) {
  return {
    watermark: { ...settings.watermark },
    music: { ...settings.music },
  };
}
const exportState = {
  saved: defaultExportSettings(),
  draft: defaultExportSettings(),
  music: [],
  maxMusicBytes: 50 * 1024 * 1024,
  loaded: false,
  saving: false,
  uploadingMusic: false,
  auditionName: "",
  loadError: "",
};
const auditionAudio = new Audio();
let previewResizeObserver = null;
let previewScrubbing = false;
let previewBadgeRect = null;
const wmDrag = {
  active: false,
  pointerId: null,
  grabX: 0,
  grabY: 0,
  hovering: false,
  snapX: false,
  snapY: false,
};
let deleteTargets = [],
  deleting = false;
const deletedChanges = new Map();
let loadGeneration = 0,
  queue = [],
  uploading = false,
  toastTimer,
  thumbnails;
const pendingProcessed = new Set();
const processedChanges = new Map();
const downloads = new Map();
let activeDownload = null,
  downloadPollTimer,
  downloadPollController,
  downloadGeneration = 0,
  downloadDialogGeneration = 0,
  autoStartDownload = false;
let processedRevision = 0;
let filterScrollObserver = null;
let lastRenderedFilterUser = null;
let shouldRevealFilterChip = false;
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
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
function showToast(message, duration = 4000) {
  clearTimeout(toastTimer);
  // Dialogs live above the document; put feedback in the active top layer.
  (document.querySelector("dialog[open]") || document.body).append($("toast"));
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, duration);
}
async function api(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(
      new Error(data.error || `请求失败（${response.status}）`),
      { status: response.status },
    );
  return data;
}
function syncURL() {
  const p = new URLSearchParams();
  if (state.selected) p.set("user", state.selected);
  if (state.search) p.set("q", state.search);
  if (state.hideProcessed) p.set("hideProcessed", "1");
  if (state.sort !== "desc") p.set("sort", state.sort);
  if (state.page > 1) p.set("page", state.page);
  if (state.pageSize !== 48) p.set("size", state.pageSize);
  if (state.maxColumns !== 6) p.set("columns", state.maxColumns);
  const query = p.toString();
  history.replaceState(
    null,
    "",
    `${location.pathname}${query ? "?" + query : ""}${location.hash}`,
  );
}
function renderGridLayout() {
  $("videoGrid").dataset.maxColumns = String(state.maxColumns);
  $("gridLayoutSwitch")
    .querySelectorAll("button")
    .forEach((toggle) => {
      toggle.setAttribute(
        "aria-pressed",
        String(Number(toggle.dataset.columns) === state.maxColumns),
      );
    });
}
function usesFallbackFilterFades() {
  return (
    !CSS.supports("animation-timeline", "scroll()") ||
    reducedMotionQuery.matches
  );
}
function syncFilterScrollHints() {
  filterScrollObserver?.disconnect();
  filterScrollObserver = null;
  const scroller = $("userFilters");
  scroller.classList.remove("more-start", "more-end");
  if (
    !usesFallbackFilterFades() ||
    scroller.hidden ||
    !scroller.firstElementChild
  )
    return;
  const first = scroller.firstElementChild;
  const last = scroller.lastElementChild;
  filterScrollObserver = new IntersectionObserver(
    (entries) => {
      for (const { target, intersectionRatio } of entries) {
        if (target === first)
          scroller.classList.toggle("more-start", intersectionRatio < 1);
        if (target === last)
          scroller.classList.toggle("more-end", intersectionRatio < 1);
      }
    },
    { root: scroller, threshold: 1, rootMargin: "1px" },
  );
  filterScrollObserver.observe(first);
  if (last !== first) filterScrollObserver.observe(last);
}
reducedMotionQuery.addEventListener("change", syncFilterScrollHints);
function revealFilterChip(chip, smooth = true) {
  const scroller = $("userFilters");
  if (!chip || scroller.hidden || scroller.scrollWidth <= scroller.clientWidth)
    return;
  const scrollerRect = scroller.getBoundingClientRect();
  const chipRect = chip.getBoundingClientRect();
  const pad = 28;
  let delta = 0;
  if (chipRect.left < scrollerRect.left + pad)
    delta = chipRect.left - (scrollerRect.left + pad);
  else if (chipRect.right > scrollerRect.right - pad)
    delta = chipRect.right - (scrollerRect.right - pad);
  if (delta) {
    scroller.scrollBy({
      left: delta,
      behavior: smooth && !reducedMotionQuery.matches ? "smooth" : "auto",
    });
  }
}
function renderFilters() {
  const scroller = $("userFilters");
  const activeInFilters = scroller.contains(document.activeElement);
  const all = button("全部用户", "filter-chip", () => {
    state.selected = "";
    state.page = 1;
    shouldRevealFilterChip = true;
    renderLibrary();
  });
  all.setAttribute("aria-pressed", String(!state.selected));
  all.append(el("span", "filter-count", String(state.videos.length)));
  let activeChip = !state.selected ? all : null;
  const fragment = document.createDocumentFragment();
  fragment.append(all);
  for (const user of state.users) {
    const b = button("", "filter-chip", () => {
      state.selected = user.name;
      state.page = 1;
      shouldRevealFilterChip = true;
      renderLibrary();
    });
    b.append(
      avatar(user.name),
      document.createTextNode(user.name),
      el("span", "filter-count", String(user.count)),
    );
    const pressed = state.selected === user.name;
    b.setAttribute("aria-pressed", String(pressed));
    if (pressed) activeChip = b;
    fragment.append(b);
  }
  scroller.replaceChildren(fragment);
  syncFilterScrollHints();
  if (activeInFilters && activeChip) activeChip.focus({ preventScroll: true });
  if (
    activeChip &&
    (shouldRevealFilterChip || lastRenderedFilterUser !== state.selected)
  ) {
    revealFilterChip(activeChip, lastRenderedFilterUser !== null);
  }
  lastRenderedFilterUser = state.selected;
  shouldRevealFilterChip = false;
}
function filteredVideos() {
  return state.videos
    .filter(
      (v) =>
        (!state.selected || state.selected === v.user) &&
        (!state.hideProcessed || !v.processed) &&
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
function updateProcessedToggle(toggle, video) {
  const pending = pendingProcessed.has(video.id);
  toggle.setAttribute("aria-checked", String(video.processed));
  toggle.setAttribute("aria-label", `${video.user}/${video.name} 已处理`);
  toggle.setAttribute("aria-busy", String(pending));
  toggle.disabled = pending;
  toggle.title = video.processed ? "标记为未处理" : "标记为已处理";
  toggle.querySelector(".processed-label").textContent = pending
    ? "保存中…"
    : video.processed
      ? "已处理"
      : "未处理";
}
function syncProcessedToggles(video) {
  document.querySelectorAll(".processed-toggle").forEach((toggle) => {
    if (toggle.dataset.videoId === video.id) updateProcessedToggle(toggle, video);
  });
}
function processedToggle(video) {
  const toggle = button("", "processed-toggle", () => toggleProcessed(video));
  toggle.dataset.videoId = video.id;
  toggle.setAttribute("role", "switch");
  const track = el("span", "processed-track");
  track.setAttribute("aria-hidden", "true");
  toggle.append(track, el("span", "processed-label"));
  updateProcessedToggle(toggle, video);
  return toggle;
}
async function toggleProcessed(original) {
  if (pendingProcessed.has(original.id)) return;
  const video = state.videos.find((item) => item.id === original.id) || original;
  let saved = false;
  pendingProcessed.add(video.id);
  syncProcessedToggles(video);
  try {
    const data = await api("/api/processed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: video.user,
        name: video.name,
        processed: !video.processed,
      }),
    });
    video.processed = data.video.processed;
    original.processed = video.processed;
    processedChanges.set(video.id, {
      processed: video.processed,
      revision: ++processedRevision,
    });
    const current = state.videos.find((item) => item.id === video.id);
    if (current) current.processed = video.processed;
    saved = true;
  } catch (error) {
    showToast(`处理状态保存失败：${error.message}`);
  } finally {
    pendingProcessed.delete(video.id);
    syncProcessedToggles(
      state.videos.find((item) => item.id === video.id) || video,
    );
    if (saved && (state.hideProcessed || state.view === "manage")) renderCurrentView();
  }
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
  preview.dataset.src = video.url + "#t=1";
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
  const download = button("", "card-action download-action", () =>
    openDownload(video),
  );
  download.dataset.videoId = video.id;
  download.append(icon("download"), el("span", "download-label"));
  updateDownloadButton(download, video);
  const actions = el("div", "card-footer-actions");
  actions.append(
    el("span", "file-size", formatSize(video.size)),
    download,
  );
  footer.append(processedToggle(video), actions);
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
    detail.textContent = state.hideProcessed
      ? "已隐藏处理过的视频，试试关闭「隐藏已处理」或调整其他筛选条件。"
      : "换个关键词，或者试试其他用户。";
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
            state.selected = "";
            state.search = "";
            state.hideProcessed = false;
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
  const go = (p) => {
    state.page = p;
    renderLibrary();
    document
      .querySelector(".collection")
      .scrollIntoView({ behavior: "smooth", block: "start" });
  };
  renderPageButtons($("pagination"), state.page, pages, go);
}
function renderPageButtons(nav, currentPage, pages, go) {
  nav.replaceChildren();
  const prev = button(
    "",
    "page-button arrow",
    () => go(currentPage - 1),
    "chevronLeft",
  );
  prev.disabled = currentPage === 1;
  prev.setAttribute("aria-label", "上一页");
  nav.append(prev);
  const numbers = [
    ...new Set([1, currentPage - 1, currentPage, currentPage + 1, pages]),
  ]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
  let last = 0;
  for (const n of numbers) {
    if (last && n - last > 1) nav.append(el("span", "page-gap", "…"));
    const b = button(String(n), "page-button", () => go(n));
    b.setAttribute("aria-label", `第 ${n} 页`);
    if (n === currentPage) b.setAttribute("aria-current", "page");
    nav.append(b);
    last = n;
  }
  const next = button(
    "",
    "page-button arrow",
    () => go(currentPage + 1),
    "chevronRight",
  );
  next.disabled = currentPage === pages;
  next.setAttribute("aria-label", "下一页");
  nav.append(next);
}
function renderLibrary() {
  if (state.view !== "library") return;
  if (state.loadError) {
    clearThumbs();
    $("videoGrid").replaceChildren();
    $("paginationBar").hidden = true;
    $("resultSummary").textContent = "读取失败";
    renderEmpty("error", state.loadError);
    return;
  }
  renderFilters();
  $("hideProcessed").checked = state.hideProcessed;
  const videos = filteredVideos();
  const pages = Math.max(1, Math.ceil(videos.length / state.pageSize));
  state.page = Math.min(Math.max(1, Math.floor(state.page)), pages);
  const start = (state.page - 1) * state.pageSize;
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
      state.videos.length ||
        state.selected ||
        state.search ||
        state.hideProcessed
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
function renderManagement() {
  const existing = new Set(state.videos.map((video) => video.id));
  for (const id of management.selected) {
    if (!existing.has(id)) management.selected.delete(id);
  }
  const allUsers = el("option", "", "全部分组");
  allUsers.value = "";
  $("manageUser").replaceChildren(allUsers, ...state.users.map((user) => {
    const option = el("option", "", `${user.name}（${user.count}）`);
    option.value = user.name;
    return option;
  }));
  if (!state.users.some((user) => user.name === management.user)) management.user = "";
  $("manageUser").value = management.user;
  const videos = state.videos.filter((video) =>
    (!management.user || video.user === management.user) &&
    video.name.toLocaleLowerCase().includes(management.search.toLocaleLowerCase()) &&
    (management.processed === "all" || video.processed === (management.processed === "processed")),
  ).sort((a, b) => {
    const date = a.date.localeCompare(b.date);
    return (management.sort === "desc" ? -date : date) ||
      a.user.localeCompare(b.user, "zh-CN") ||
      a.name.localeCompare(b.name, "zh-CN", { numeric: true });
  });
  const pages = Math.max(1, Math.ceil(videos.length / management.pageSize));
  management.page = Math.min(management.page, pages);
  const start = (management.page - 1) * management.pageSize;
  const hasVideos = !state.loadError && videos.length > 0;
  $("manageTableWrap").hidden = !hasVideos;
  $("managePaginationBar").hidden = !hasVideos;
  $("manageEmpty").hidden = !!hasVideos;
  $("manageSummary").textContent = state.loadError ? "读取失败" : videos.length
    ? `共 ${videos.length} 个视频 · 正在展示 ${start + 1}–${Math.min(start + management.pageSize, videos.length)} 个`
    : "共 0 个视频";
  $("manageRows").replaceChildren(...(hasVideos ? videos.slice(start, start + management.pageSize) : []).map((video) => {
    const row = el("tr");
    const selectCell = el("td", "management-select");
    const select = el("input", "management-checkbox");
    select.type = "checkbox";
    select.dataset.videoId = video.id;
    select.setAttribute("aria-label", `选择 ${video.user}/${video.name}`);
    select.addEventListener("change", () => {
      if (select.checked) management.selected.add(video.id);
      else management.selected.delete(video.id);
      syncManagementSelection();
    });
    selectCell.append(select);
    const name = el("td", "management-name");
    const preview = button(video.name, "management-title", () => openPlayer(video));
    preview.title = video.name;
    preview.setAttribute("aria-label", `预览 ${video.user}/${video.name}`);
    name.append(preview);
    const group = el("td", "management-group", video.user);
    group.title = video.user;
    const date = el("time", "", video.date);
    date.dateTime = video.date;
    date.title = video.dateSource === "modified" ? "文件名无有效日期，按文件修改日期显示" : "文件名中的视频日期";
    const dateCell = el("td", "management-date");
    dateCell.append(date);
    const statusCell = el("td");
    statusCell.append(el("span", `management-status${video.processed ? " is-processed" : ""}`, video.processed ? "已处理" : "未处理"));
    const actionCell = el("td");
    const remove = button("删除", "delete-action", () => openDelete([video]), "trash");
    remove.setAttribute("aria-label", `删除 ${video.user}/${video.name}`);
    actionCell.append(remove);
    row.append(selectCell, name, group, dateCell, el("td", "management-size", formatSize(video.size)), statusCell, actionCell);
    return row;
  }));
  syncManagementSelection();
  if (!hasVideos) {
    const filtered = management.search || management.user || management.processed !== "all";
    $("manageEmpty").replaceChildren(
      el("h3", "", state.loadError ? "暂时没能读取视频" : filtered ? "没有符合条件的视频" : "还没有视频"),
      el("p", "", state.loadError || (filtered ? "试试其他关键词、分组或处理状态。" : "上传视频后，可以在这里管理。")),
      button(state.loadError ? "重新读取" : filtered ? "清除筛选" : "上传视频", "button primary", state.loadError ? () => loadLibrary() : filtered ? () => {
        management.search = "";
        management.user = "";
        management.processed = "all";
        management.page = 1;
        management.selected.clear();
        $("manageSearch").value = "";
        $("manageProcessed").value = "all";
        renderManagement();
      } : openUpload),
    );
  }
  $("managePageSummary").textContent = `第 ${management.page} / ${pages} 页`;
  renderPageButtons($("managePagination"), management.page, pages, (page) => {
    management.page = page;
    renderManagement();
    $("manageView").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}
function syncManagementSelection() {
  const checkboxes = [...$("manageRows").querySelectorAll(".management-checkbox")];
  let checked = 0;
  for (const checkbox of checkboxes) {
    checkbox.checked = management.selected.has(checkbox.dataset.videoId);
    checkbox.closest("tr").classList.toggle("is-selected", checkbox.checked);
    if (checkbox.checked) checked++;
  }
  $("manageSelectPage").checked = checkboxes.length > 0 && checked === checkboxes.length;
  $("manageSelectPage").indeterminate = checked > 0 && checked < checkboxes.length;
  $("manageSelectPage").disabled = !checkboxes.length || deleting;
  $("manageSelectionCount").textContent = `已选择 ${management.selected.size} 个`;
  $("manageClearSelection").disabled = !management.selected.size || deleting;
  $("manageDeleteSelected").disabled = !management.selected.size || deleting || !!state.loadError;
}
function renderCurrentView() {
  if (state.view === "manage") renderManagement();
  else if (state.view === "export") renderExportPage();
  else if (state.view === "library") renderLibrary();
}
function renderDeleteTargets(failures = []) {
  const count = deleteTargets.length;
  $("deleteTitle").textContent = count === 1 ? "删除这个视频？" : `删除这 ${count} 个视频？`;
  $("deleteButtonLabel").textContent = `确认删除 ${count} 个视频`;
  const video = deleteTargets[0];
  $("deleteName").textContent = count === 1 ? video.name : `已选择 ${count} 个视频`;
  $("deleteMeta").textContent = count === 1
    ? `${video.user} · ${video.date} · ${formatSize(video.size)} · ${video.processed ? "已处理" : "未处理"}`
    : `共 ${new Set(deleteTargets.map((item) => item.user)).size} 个分组 · ${formatSize(deleteTargets.reduce((sum, item) => sum + item.size, 0))}`;
  $("deleteList").hidden = count === 1 && !failures.length;
  $("deleteList").replaceChildren(...deleteTargets.map((item) => {
    const entry = el("li");
    entry.append(el("span", "delete-failure-name", `${item.user}/${item.name}`));
    const failure = failures.find((failed) => failed.video.id === item.id);
    if (failure) entry.append(el("span", "delete-failure-reason", failure.message));
    return entry;
  }));
}
function openDelete(videos) {
  if (deleting || !videos.length) return;
  deleteTargets = [...videos];
  renderDeleteTargets();
  $("deleteError").hidden = true;
  $("deleteProgress").hidden = true;
  $("deleteDialog").showModal();
  $("cancelDelete").focus();
}
function closeDelete() {
  if (!deleting) $("deleteDialog").close();
}
function removeDeletedVideo(video) {
  deletedChanges.set(video.id, ++processedRevision);
  processedChanges.delete(video.id);
  downloads.delete(video.id);
  management.selected.delete(video.id);
  state.videos = state.videos.filter((item) => item.id !== video.id);
}
function updateUserCounts() {
  const counts = new Map();
  for (const video of state.videos) counts.set(video.user, (counts.get(video.user) || 0) + 1);
  state.users = state.users.map((user) => ({ ...user, count: counts.get(user.name) || 0 }));
}
async function confirmDelete() {
  if (!deleteTargets.length || deleting) return;
  const targets = [...deleteTargets];
  deleting = true;
  for (const id of ["confirmDelete", "cancelDelete", "closeDelete"]) $(id).disabled = true;
  $("deleteDialog").setAttribute("aria-busy", "true");
  $("deleteButtonLabel").textContent = "正在删除…";
  $("deleteError").hidden = true;
  $("deleteProgress").hidden = false;
  syncManagementSelection();
  const failures = [];
  let removed = 0;
  let missing = 0;
  try {
    // Reuse the validated single-video endpoint and track each result so a
    // failed item never hides successful deletions or gets silently discarded.
    for (const [index, video] of targets.entries()) {
      $("deleteProgress").textContent = `正在删除 ${index + 1} / ${targets.length}：${video.name}`;
      try {
        await api("/api/videos", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user: video.user, name: video.name }),
        });
        removeDeletedVideo(video);
        removed++;
      } catch (error) {
        if (error.status === 404) {
          removeDeletedVideo(video);
          missing++;
        } else {
          failures.push({ video, message: error.message });
        }
      }
    }
  } finally {
    deleting = false;
    for (const id of ["confirmDelete", "cancelDelete", "closeDelete"]) $(id).disabled = false;
    $("deleteDialog").setAttribute("aria-busy", "false");
    updateUserCounts();
    renderCurrentView();
    updateUserOptions();
  }
  const result = `已删除 ${removed} 个视频${missing ? `，${missing} 个已不存在并移出列表` : ""}`;
  if (failures.length) {
    deleteTargets = failures.map((failure) => failure.video);
    renderDeleteTargets(failures);
    $("deleteProgress").textContent = `${result}，${failures.length} 个删除失败。`;
    $("deleteError").textContent = "以下视频未能删除，请查看原因后重试。";
    $("deleteError").hidden = false;
    $("deleteButtonLabel").textContent = `重试删除 ${failures.length} 个视频`;
  } else {
    closeDelete();
    $("manageSearch").focus();
    showToast(result);
  }
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
    state.selected &&
    state.users.some((u) => u.name === state.selected)
  )
    $("uploadUser").value = state.selected;
  updateUploadButton();
}
async function loadLibrary({ notify = false } = {}) {
  const generation = ++loadGeneration;
  const revision = processedRevision;
  for (const id of ["refreshButton", "manageRefresh"]) {
    $(id).disabled = true;
    $(id).classList.add("spinning");
  }
  try {
    const data = await api("/api/library");
    if (generation !== loadGeneration) return;
    state.videos = data.videos.filter((video) => !(deletedChanges.get(video.id) > revision)).map((video) => {
      // A refresh started before a successful save must not restore old status.
      const change = processedChanges.get(video.id);
      if (change && change.revision > revision) video.processed = change.processed;
      return video;
    });
    state.users = data.users;
    updateUserCounts();
    state.today = data.today;
    state.timeZone = data.timeZone || "Asia/Shanghai";
    state.maxUploadBytes = data.maxUploadBytes;
    state.loaded = true;
    state.loadError = "";
    if (!state.users.some((u) => u.name === state.selected)) state.selected = "";
    syncPreviewVideo();
    renderCurrentView();
    const playerToggle =
      $("playerProcessedControl").querySelector(".processed-toggle");
    const playerVideo = state.videos.find(
      (video) => video.id === playerToggle?.dataset.videoId,
    );
    if (playerVideo) updateProcessedToggle(playerToggle, playerVideo);
    updateUserOptions();
    if (notify) showToast("视频库已刷新");
  } catch (error) {
    if (generation !== loadGeneration) return;
    state.loadError = `请确认本地服务正在运行。${error.message}`;
    renderCurrentView();
    showToast("无法连接视频库，请重试");
  } finally {
    if (generation === loadGeneration) {
      for (const id of ["refreshButton", "manageRefresh"]) {
        $(id).disabled = false;
        $(id).classList.remove("spinning");
      }
    }
  }
}
function route() {
  const upload =
    location.hash === "#upload" ||
    (!location.hash && /^\/upload\/?$/.test(location.pathname));
  const exportPage =
    location.hash === "#manage/export" ||
    (!location.hash && /^\/manage\/export\/?$/.test(location.pathname));
  const manage =
    !exportPage &&
    (location.hash === "#manage" ||
      (!location.hash && /^\/manage\/?$/.test(location.pathname)));
  const inManageSection = manage || exportPage;
  const isLibrary = !upload && !inManageSection;
  state.view = upload ? "upload" : exportPage ? "export" : manage ? "manage" : "library";
  $("userFilters").hidden = !isLibrary;
  $("headerBack").hidden = isLibrary;
  $("manageNav").hidden = !inManageSection;
  $("libraryView").hidden = !isLibrary;
  $("uploadView").hidden = !upload;
  $("manageView").hidden = !manage;
  $("exportView").hidden = !exportPage;
  if (inManageSection) $("manageLink").setAttribute("aria-current", "page");
  else $("manageLink").removeAttribute("aria-current");
  if (manage) $("manageTabVideos").setAttribute("aria-current", "page");
  else $("manageTabVideos").removeAttribute("aria-current");
  if (exportPage) $("manageTabExport").setAttribute("aria-current", "page");
  else $("manageTabExport").removeAttribute("aria-current");
  if (!isLibrary) {
    clearThumbs();
    $("videoGrid").replaceChildren();
  }
  if (!exportPage) stopExportMedia();
  syncFilterScrollHints();
  if (exportPage && !exportState.loaded) loadExportSettings();
  if (state.loaded || state.loadError || exportPage) renderCurrentView();
  document.title = upload
    ? "上传视频 · 片刻"
    : exportPage
      ? "水印与音乐 · 片刻"
      : manage
        ? "管理视频 · 片刻"
        : "片刻 · 视频收藏";
}
function openPlayer(video) {
  video = state.videos.find((item) => item.id === video.id) || video;
  $("playerProcessedControl").replaceChildren(processedToggle(video));
  $("playerTitle").textContent = video.name;
  $("playerMeta").textContent =
    `${video.user} · ${video.date} · ${formatSize(video.size)}`;
  $("playerDownload").dataset.videoId = video.id;
  $("playerDownload").onclick = () => openDownload(video);
  updateDownloadButton($("playerDownload"), video);
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
function hasActiveExportEffects() {
  const wm = exportState.saved.watermark;
  const mu = exportState.saved.music;
  return Boolean((wm.enabled && wm.text.trim()) || (mu.enabled && mu.file));
}
function activeEffectsLabel(effects) {
  if (!effects) return "";
  if (effects.watermark && effects.music) return "水印与背景音乐";
  if (effects.watermark) return "文字水印";
  if (effects.music) return "背景音乐";
  return "";
}
function updateDownloadButton(control, video) {
  const entry = downloads.get(video.id);
  const checking = entry?.requesting;
  const busy =
    checking || ["queued", "processing"].includes(entry?.job?.status);
  const activeEffects = hasActiveExportEffects();
  control.setAttribute("aria-busy", String(!!busy));
  control.setAttribute(
    "aria-label",
    `${checking ? "正在检查下载格式" : busy ? "查看下载进度" : activeEffects ? "处理并下载 MP4" : "下载 H.264 MP4"}：${video.name}`,
  );
  control.title = checking
    ? "正在检查下载格式"
    : busy
      ? "点击查看下载准备进度"
      : activeEffects
        ? "点击后将添加水印/音乐并导出 MP4"
        : "下载 H.264 编码的 MP4";
  control.querySelector(".download-label").textContent = checking
    ? "检查中…"
    : busy
      ? "查看进度"
      : "下载";
}
function syncDownloadButtons(entry) {
  document.querySelectorAll(".download-action").forEach((control) => {
    if (control.dataset.videoId === entry.video.id)
      updateDownloadButton(control, entry.video);
  });
}
function stopDownloadPolling() {
  clearTimeout(downloadPollTimer);
  downloadPollController?.abort();
  downloadPollController = null;
  downloadGeneration++;
}
function renderDownload(entry) {
  syncDownloadButtons(entry);
  if (entry !== activeDownload || !$("downloadDialog").open) return;
  downloadDialogGeneration = downloadGeneration;
  const job = entry.job;
  const ready = job?.status === "ready";
  const failed = job?.status === "failed";
  const error =
    entry.error || (failed ? job.error || "视频处理失败，请重试。" : "");
  const progress = Math.round(
    Math.min(1, Math.max(0, Number(job?.progress) || 0)) * 100,
  );
  $("downloadName").textContent = entry.video.name;
  const effectsText = activeEffectsLabel(job?.effects);
  $("downloadStatus").textContent = error
    ? "暂时无法准备下载"
    : ready
      ? effectsText
        ? `已添加${effectsText}，MP4 已准备好`
        : "H.264 MP4 已准备好"
      : job?.status === "processing"
        ? effectsText
          ? "正在处理中…"
          : "正在检查编码并准备 H.264 MP4…"
        : job?.status === "queued"
          ? "正在排队，请稍候…"
          : "正在准备下载…";
  const progressTitle = $("downloadProgressGroup").querySelector(".progress-meta > span");
  if (progressTitle) {
    progressTitle.textContent = effectsText ? "正在处理中" : "准备 H.264 MP4";
  }
  $("readyDownload").replaceChildren(
    icon("download"),
    document.createTextNode(effectsText ? "下载处理后的 MP4" : "下载 H.264 MP4"),
  );
  $("downloadProgress").value = ready ? 100 : progress;
  $("downloadProgressGroup").hidden = ready || !!error;
  $("downloadPercent").textContent = `${progress}%`;
  $("downloadError").textContent = error;
  $("downloadError").hidden = !error;
  $("retryDownload").hidden = !error;
  $("retryDownload").textContent = job && !failed ? "重新连接" : "重试";
  $("readyDownload").hidden = !ready;
  if (ready) {
    $("readyDownload").href = job.downloadUrl;
    $("readyDownload").download = job.name;
  } else {
    $("readyDownload").removeAttribute("href");
  }
  $("originalDownload").href = entry.video.downloadUrl;
  $("originalDownload").download = entry.video.name;
  $("downloadHint").textContent = ready
    ? "已尝试开始下载。如果浏览器未弹出下载，请点击下方按钮。"
    : error
      ? "可以重试，或选择下载原文件。"
      : "处理可能需要一些时间。关闭弹窗后仍会继续，再次点击下载可查看进度。";
}
function updateDownloadJob(entry, job) {
  if (
    !job?.id ||
    !["queued", "processing", "ready", "failed"].includes(job.status) ||
    (job.status === "ready" && !job.downloadUrl)
  )
    throw new Error("服务器返回了无效的下载状态，请重试。");
  entry.job = job;
  entry.error = "";
}
function continueDownload(entry) {
  renderDownload(entry);
  if (entry !== activeDownload) return;
  if (entry.job?.status === "ready" && !entry.error) {
    if (autoStartDownload) {
      autoStartDownload = false;
      // A normal link streams the download without buffering the video in memory.
      const link = el("a");
      link.href = entry.job.downloadUrl;
      link.download = entry.job.name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      showToast("已发起下载，未开始时可", 10000);
      const retry = el("a", "toast-download", "点击重试");
      retry.href = entry.job.downloadUrl;
      retry.download = entry.job.name;
      $("toast").append(retry);
    }
    return;
  }
  showDownloadDialog(entry);
  if (
    ["queued", "processing"].includes(entry.job?.status) &&
    !entry.error
  ) {
    clearTimeout(downloadPollTimer);
    downloadPollTimer = setTimeout(() => refreshDownload(entry), 1000);
  }
}
async function requestDownload(entry) {
  if (entry.requesting) return;
  entry.requesting = true;
  entry.job = null;
  entry.error = "";
  renderDownload(entry);
  try {
    const data = await api("/api/downloads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: entry.video.user, name: entry.video.name }),
    });
    updateDownloadJob(entry, data.job);
  } catch (error) {
    entry.error = error.message;
  } finally {
    entry.requesting = false;
    continueDownload(entry);
  }
}
async function refreshDownload(entry) {
  if (entry !== activeDownload || !$("downloadDialog").open || !entry.job)
    return;
  const generation = downloadGeneration;
  const controller = new AbortController();
  downloadPollController = controller;
  try {
    const data = await api(`/api/downloads/${encodeURIComponent(entry.job.id)}`, {
      signal: controller.signal,
    });
    if (generation !== downloadGeneration) return;
    updateDownloadJob(entry, data.job);
    continueDownload(entry);
  } catch (error) {
    if (controller.signal.aborted || generation !== downloadGeneration) return;
    // A service restart can discard a job; retrying should create it again.
    if (error.status === 404) entry.job = null;
    entry.error = error.message;
    renderDownload(entry);
  } finally {
    if (downloadPollController === controller) downloadPollController = null;
  }
}
function showDownloadDialog(entry) {
  if (entry !== activeDownload) return;
  if ($("playerDialog").open) $("playerDialog").close();
  if (!$("downloadDialog").open) $("downloadDialog").showModal();
  renderDownload(entry);
}
function openDownload(video) {
  stopDownloadPolling();
  let entry = downloads.get(video.id);
  if (!entry) {
    entry = { video, job: null, requesting: false, error: "" };
    downloads.set(video.id, entry);
  }
  entry.video = video;
  activeDownload = entry;
  autoStartDownload = true;
  if (entry.requesting) return;
  // Revalidate ready jobs so changed source files and expired caches are handled.
  if (entry.job?.status === "ready") requestDownload(entry);
  else if (entry.job || entry.error) {
    showDownloadDialog(entry);
    if (entry.job && entry.job.status !== "failed") refreshDownload(entry);
  } else requestDownload(entry);
}
$("closeDownload").addEventListener("click", () => $("downloadDialog").close());
$("downloadDialog").addEventListener("close", () => {
  // A queued close event can arrive after another download has already started.
  if (
    $("downloadDialog").open ||
    downloadDialogGeneration !== downloadGeneration
  )
    return;
  stopDownloadPolling();
  activeDownload = null;
  autoStartDownload = false;
});
$("retryDownload").addEventListener("click", () => {
  const entry = activeDownload;
  if (!entry || entry.requesting) return;
  stopDownloadPolling();
  entry.error = "";
  autoStartDownload = true;
  if (entry.job?.status === "failed") entry.job = null;
  renderDownload(entry);
  if (entry.job) refreshDownload(entry);
  else requestDownload(entry);
});
closeOnBackdrop($("downloadDialog"), () => $("downloadDialog").close());
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
  $("uploadFooterHint").textContent =
    "视频将保存为 H.264 MP4；上传后请等待编码检查和处理完成。";
  $("newUserFields").hidden = state.users.length > 0;
  updateUserOptions();
  renderQueue();
  if (!$("uploadDialog").open) $("uploadDialog").showModal();
}
function closeUpload() {
  if (uploading) {
    showToast("正在上传或处理视频，请等待当前批次完成");
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
    const info = el("div", "queue-file-info");
    const name = el("p", "queue-file-name", item.file.name);
    name.title = item.file.name;
    const status = el(
      "p",
      `queue-file-status ${item.status === "success" ? "success" : item.status === "failed" ? "failed" : ""}`,
      item.status === "success"
        ? `已保存到 ${item.savedUser} 的收藏 · ${item.savedName}`
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
    row.append(info, date, remove);
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
function uploadFile(item, user, onProgress, onUploaded) {
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
    xhr.upload.onload = onUploaded;
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
    $("uploadButtonLabel").textContent = "正在上传…";
    $("progressLabel").textContent =
      `正在上传 ${i + 1} / ${pending.length} · ${item.file.name}`;
    try {
      const data = await uploadFile(
        item,
        user,
        (loaded, total) => {
          const progress = Math.round(((completed + loaded) / bytes) * 100);
          $("uploadProgress").value = progress;
          $("progressPercent").textContent = `${progress}%`;
          item.statusEl.textContent = `上传中 · ${Math.round((loaded / total) * 100)}%`;
        },
        () => {
          item.statusEl.textContent = "上传完成，正在检查编码 / 转码…";
          $("progressLabel").textContent =
            `正在处理 ${i + 1} / ${pending.length} · ${item.file.name}`;
          $("progressPercent").textContent = "处理中";
          $("uploadButtonLabel").textContent = "正在处理…";
        },
      );
      item.status = "success";
      item.savedName = data.video.name;
      item.savedUser = data.video.user;
      success++;
      item.statusEl.textContent = `已保存到 ${item.savedUser} 的收藏 · ${item.savedName}`;
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
    showToast("正在上传或处理视频，请等待当前批次完成");
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
const EXPORT_FONT_FAMILY =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif';

function isExportDirty() {
  return (
    JSON.stringify(exportState.draft) !== JSON.stringify(exportState.saved)
  );
}
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "未知时长";
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
function syncRangeSlider(input, valueText) {
  input.style.setProperty("--attr-min", input.min || "0");
  input.style.setProperty("--attr-max", input.max || "100");
  input.style.setProperty("--control-value", input.value);
  if (valueText !== undefined) {
    input.setAttribute("aria-valuetext", String(valueText));
  }
}
function setSwitchState(control, checked, labelText) {
  control.setAttribute("aria-checked", String(Boolean(checked)));
  const label = control.querySelector(".processed-label");
  if (label && labelText !== undefined) label.textContent = labelText;
}
function updateExportActiveBadge() {
  const wm = exportState.saved.watermark;
  const mu = exportState.saved.music;
  const hasWm = Boolean(wm.enabled && wm.text.trim());
  const hasMu = Boolean(mu.enabled && mu.file);
  const badge = $("exportActiveBadge");
  if (hasWm && hasMu) {
    badge.textContent = "水印+音乐";
    badge.hidden = false;
  } else if (hasWm) {
    badge.textContent = "水印";
    badge.hidden = false;
  } else if (hasMu) {
    badge.textContent = "音乐";
    badge.hidden = false;
  } else {
    badge.textContent = "";
    badge.hidden = true;
  }
  document.querySelectorAll(".download-action").forEach((control) => {
    const video = state.videos.find((v) => v.id === control.dataset.videoId);
    if (video) updateDownloadButton(control, video);
  });
}
function stopExportMedia() {
  $("previewVideo").pause();
  $("previewAudio").pause();
  auditionAudio.pause();
  if (exportState.auditionName) {
    exportState.auditionName = "";
    renderMusicList();
  }
  syncPreviewPlaybackUI();
}
function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
function drawRoundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
function measureAndRenderWatermarkBadge(wm, scale) {
  const lines = (wm.text || "").replace(/\r\n?/g, "\n").split("\n");
  const fontSize = Math.max(1, wm.fontSize * scale);
  const lineHeight = fontSize * 1.25;
  const padX = Math.max(0, wm.paddingX * scale);
  const padY = Math.max(0, wm.paddingY * scale);
  const font = `${wm.bold ? "700 " : ""}${fontSize}px ${EXPORT_FONT_FAMILY}`;

  const measureCanvas = document.createElement("canvas");
  const mCtx = measureCanvas.getContext("2d");
  mCtx.font = font;
  const maxLineW = Math.max(
    1,
    ...lines.map((line) => mCtx.measureText(line || " ").width),
  );
  const textH = lines.length * lineHeight;
  const badgeW = Math.max(2, Math.ceil(maxLineW + padX * 2));
  const badgeH = Math.max(2, Math.ceil(textH + padY * 2));

  const inner = document.createElement("canvas");
  inner.width = badgeW;
  inner.height = badgeH;
  const iCtx = inner.getContext("2d");

  if (wm.backgroundOpacity > 0) {
    iCtx.save();
    iCtx.globalAlpha = wm.backgroundOpacity;
    iCtx.fillStyle = wm.backgroundColor;
    drawRoundedRectPath(iCtx, 0, 0, badgeW, badgeH, wm.borderRadius * scale);
    iCtx.fill();
    iCtx.restore();
  }

  iCtx.save();
  iCtx.font = font;
  iCtx.fillStyle = wm.color;
  iCtx.textBaseline = "middle";
  iCtx.textAlign = "center";
  for (let i = 0; i < lines.length; i++) {
    iCtx.fillText(lines[i], badgeW / 2, padY + (i + 0.5) * lineHeight);
  }
  iCtx.restore();

  if (wm.opacity >= 0.999) return inner;
  const out = document.createElement("canvas");
  out.width = badgeW;
  out.height = badgeH;
  const oCtx = out.getContext("2d");
  oCtx.globalAlpha = wm.opacity;
  oCtx.drawImage(inner, 0, 0);
  return out;
}
function computePreviewWatermarkPlacement(wm, videoW, videoH, badgeW, badgeH) {
  const rx = Math.max(0, Math.min(1, Number(wm.x) || 0));
  const ry = Math.max(0, Math.min(1, Number(wm.y) || 0));
  return {
    x: Math.round(rx * Math.max(0, videoW - badgeW)),
    y: Math.round(ry * Math.max(0, videoH - badgeH)),
  };
}
function exportWatermarkOverlayPng(wm) {
  const baseCanvas = measureAndRenderWatermarkBadge(wm, 1);
  const overlayScale = Math.max(
    0.1,
    Math.min(3, 3840 / baseCanvas.width, 2160 / baseCanvas.height),
  );
  const hiCanvas =
    Math.abs(overlayScale - 1) < 0.01
      ? baseCanvas
      : measureAndRenderWatermarkBadge(wm, overlayScale);
  const dataUrl = hiCanvas.toDataURL("image/png");
  return {
    overlayPng: dataUrl.slice("data:image/png;base64,".length),
    overlayScale,
  };
}
function drawPreviewWatermark() {
  const stage = $("previewStage");
  const video = $("previewVideo");
  const canvas = $("previewCanvas");
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  if (!stageW || !stageH) return;

  let dispW = stageW;
  let dispH = stageH;
  let offX = 0;
  let offY = 0;
  if (!video.hidden && video.videoWidth > 0 && video.videoHeight > 0) {
    const videoAspect = video.videoWidth / video.videoHeight;
    const stageAspect = stageW / stageH;
    if (videoAspect > stageAspect) {
      dispW = stageW;
      dispH = stageW / videoAspect;
      offY = (stageH - dispH) / 2;
    } else {
      dispH = stageH;
      dispW = stageH * videoAspect;
      offX = (stageW - dispW) / 2;
    }
  }

  canvas.style.left = `${offX}px`;
  canvas.style.top = `${offY}px`;
  canvas.style.width = `${dispW}px`;
  canvas.style.height = `${dispH}px`;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pxW = Math.max(1, Math.round(dispW * dpr));
  const pxH = Math.max(1, Math.round(dispH * dpr));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, pxW, pxH);

  const wm = exportState.draft.watermark;
  const draggable = Boolean(wm.enabled && wm.text.trim());
  $("previewDragHint").hidden = !draggable;
  canvas.classList.toggle("is-draggable", draggable);
  if (!draggable) {
    previewBadgeRect = null;
    canvas.classList.remove("is-hovering", "is-dragging");
    return;
  }

  const scale = Math.min(pxW, pxH) / 720;
  const badge = measureAndRenderWatermarkBadge(wm, scale);
  const fit = Math.min(1, pxW / badge.width, pxH / badge.height);
  const drawW = Math.max(1, Math.round(badge.width * fit));
  const drawH = Math.max(1, Math.round(badge.height * fit));
  const { x, y } = computePreviewWatermarkPlacement(wm, pxW, pxH, drawW, drawH);

  previewBadgeRect = {
    x: x / dpr,
    y: y / dpr,
    w: drawW / dpr,
    h: drawH / dpr,
    canvasW: dispW,
    canvasH: dispH,
  };

  if (wmDrag.active && (wmDrag.snapX || wmDrag.snapY)) {
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
    ctx.lineWidth = Math.max(1, dpr);
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    if (wmDrag.snapX) {
      ctx.beginPath();
      ctx.moveTo(pxW / 2, 0);
      ctx.lineTo(pxW / 2, pxH);
      ctx.stroke();
    }
    if (wmDrag.snapY) {
      ctx.beginPath();
      ctx.moveTo(0, pxH / 2);
      ctx.lineTo(pxW, pxH / 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.drawImage(badge, x, y, drawW, drawH);

  if (wmDrag.hovering || wmDrag.active) {
    ctx.save();
    ctx.strokeStyle = wmDrag.active
      ? "rgba(247, 104, 138, 0.95)"
      : "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = Math.max(1.5, 1.5 * dpr);
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.strokeRect(
      Math.max(0.5, x - 2),
      Math.max(0.5, y - 2),
      Math.min(pxW - 1, drawW + 4),
      Math.min(pxH - 1, drawH + 4),
    );
    ctx.restore();
  }
}
function syncPreviewPlaybackUI() {
  const videoEl = $("previewVideo");
  const playBtn = $("previewPlayToggle");
  const seek = $("previewSeek");
  const timeEl = $("previewTime");
  const hasVideo = state.videos.length > 0 && !videoEl.hidden;
  const playing = hasVideo && !videoEl.paused && !videoEl.ended;

  playBtn.disabled = !hasVideo;
  playBtn.replaceChildren(icon(playing ? "pause" : "play"));
  playBtn.setAttribute("aria-label", playing ? "暂停预览" : "播放预览");
  playBtn.title = playing ? "暂停" : "播放";

  const dur = Number.isFinite(videoEl.duration) && videoEl.duration > 0 ? videoEl.duration : 0;
  const cur = Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
  const timeText = `${formatClock(cur)} / ${formatClock(dur)}`;
  timeEl.textContent = timeText;

  seek.disabled = !hasVideo || !dur;
  if (!previewScrubbing) {
    seek.value = dur > 0 ? String(Math.round((cur / dur) * 1000)) : "0";
    syncRangeSlider(seek, timeText);
  }
}
function syncPreviewVideo() {
  const videoEl = $("previewVideo");
  const emptyEl = $("previewEmpty");
  const active = state.videos[0] || null;

  if (!active) {
    videoEl.hidden = true;
    if (videoEl.hasAttribute("src")) {
      videoEl.pause();
      videoEl.removeAttribute("src");
      videoEl.load();
    }
    emptyEl.hidden = false;
    $("previewVideoMeta").textContent = "视频库暂无视频（仍可预览水印效果）";
    syncPreviewPlaybackUI();
    drawPreviewWatermark();
    return;
  }

  emptyEl.hidden = true;
  videoEl.hidden = false;
  if (videoEl.getAttribute("src") !== active.url) {
    videoEl.src = active.url;
  }
  const resText =
    videoEl.videoWidth > 0
      ? ` · ${videoEl.videoWidth}×${videoEl.videoHeight}`
      : "";
  $("previewVideoMeta").textContent = `${active.user} / ${active.name}${resText}`;
  syncPreviewPlaybackUI();
}
function syncPreviewAudioSource() {
  const videoEl = $("previewVideo");
  const audioEl = $("previewAudio");
  const mu = exportState.draft.music;
  const track = exportState.music.find((item) => item.name === mu.file);
  videoEl.muted = Boolean(mu.enabled && mu.keepOriginalAudio === false);
  audioEl.volume = Math.max(0, Math.min(1, mu.volume));
  audioEl.loop = Boolean(mu.loop);
  if (!mu.enabled || !track) {
    audioEl.pause();
    if (audioEl.hasAttribute("src")) {
      audioEl.removeAttribute("src");
      audioEl.load();
    }
    return;
  }
  if (audioEl.getAttribute("src") !== track.url) {
    audioEl.src = track.url;
  }
}
function syncPreviewAudioPlayback() {
  const videoEl = $("previewVideo");
  const audioEl = $("previewAudio");
  const mu = exportState.draft.music;
  if (
    !mu.enabled ||
    !mu.file ||
    !audioEl.hasAttribute("src") ||
    videoEl.paused ||
    videoEl.ended
  ) {
    audioEl.pause();
    return;
  }
  auditionAudio.pause();
  if (exportState.auditionName) {
    exportState.auditionName = "";
    renderMusicList();
  }
  const dur = audioEl.duration;
  if (Number.isFinite(dur) && dur > 0) {
    if (!mu.loop && videoEl.currentTime >= dur) {
      audioEl.pause();
      return;
    }
    const target = mu.loop ? videoEl.currentTime % dur : videoEl.currentTime;
    if (Math.abs(audioEl.currentTime - target) > 0.25) {
      audioEl.currentTime = target;
    }
  }
  audioEl.play().catch(() => {});
}
function renderPreviewSummary() {
  const wm = exportState.draft.watermark;
  const mu = exportState.draft.music;
  const parts = [];
  if (wm.enabled && wm.text.trim()) parts.push("文字水印");
  else if (wm.enabled) parts.push("水印已开启（未填内容）");
  if (mu.enabled && mu.file) {
    parts.push(`背景音乐（${mu.file}${mu.keepOriginalAudio === false ? " · 静音原声" : ""}）`);
  } else if (mu.enabled) {
    parts.push("音乐已开启（未选文件）");
  }
  $("previewEffectsSummary").textContent = parts.length
    ? `预览效果：${parts.join(" + ")}`
    : "当前未开启水印和音乐（直接下载原格式）";
}
function renderMusicList() {
  const list = $("musicList");
  const empty = $("musicEmpty");
  const tracks = exportState.music;
  list.hidden = !tracks.length;
  empty.hidden = tracks.length > 0;
  if (!tracks.length) {
    list.replaceChildren();
    return;
  }
  list.replaceChildren(
    ...tracks.map((track) => {
      const selected = exportState.draft.music.file === track.name;
      const playing =
        exportState.auditionName === track.name && !auditionAudio.paused;
      const item = el("div", `music-item${selected ? " is-selected" : ""}`);
      const selectBtn = el("button", "music-select");
      selectBtn.type = "button";
      selectBtn.setAttribute("role", "radio");
      selectBtn.setAttribute("aria-checked", String(selected));
      selectBtn.addEventListener("click", () => {
        exportState.draft.music.file = track.name;
        syncPreviewAudioSource();
        syncPreviewAudioPlayback();
        renderMusicList();
        renderExportStatus();
      });
      const radio = el("span", "music-radio");
      radio.setAttribute("aria-hidden", "true");
      const info = el("span", "music-item-info");
      const title = el("span", "music-item-name", track.name);
      title.title = track.name;
      const meta = el(
        "span",
        "music-item-meta",
        `${formatDuration(track.duration)} · ${formatSize(track.size)}`,
      );
      info.append(title, meta);
      selectBtn.append(radio, info);

      const actions = el("div", "music-item-actions");
      const playBtn = button(
        "",
        `icon-button music-item-btn${playing ? " is-playing" : ""}`,
        () => toggleAuditionMusic(track),
        playing ? "pause" : "play",
      );
      playBtn.setAttribute(
        "aria-label",
        `${playing ? "暂停试听" : "试听"} ${track.name}`,
      );
      playBtn.title = playing ? "暂停试听" : "试听 MP3";
      const delBtn = button(
        "",
        "icon-button music-item-btn danger-icon",
        () => deleteMusicFile(track.name),
        "trash",
      );
      delBtn.setAttribute("aria-label", `删除 ${track.name}`);
      delBtn.title = "删除此 MP3";
      actions.append(playBtn, delBtn);

      item.append(selectBtn, actions);
      return item;
    }),
  );
}
function toggleAuditionMusic(track) {
  if (exportState.auditionName === track.name && !auditionAudio.paused) {
    auditionAudio.pause();
    exportState.auditionName = "";
    renderMusicList();
    return;
  }
  $("previewVideo").pause();
  $("previewAudio").pause();
  exportState.auditionName = track.name;
  auditionAudio.src = track.url;
  auditionAudio.volume = Math.max(0, Math.min(1, exportState.draft.music.volume));
  auditionAudio
    .play()
    .then(() => renderMusicList())
    .catch(() => {
      exportState.auditionName = "";
      renderMusicList();
      showToast("无法试听此音频文件");
    });
}
async function deleteMusicFile(name) {
  if (exportState.uploadingMusic || exportState.saving) return;
  $("musicError").hidden = true;
  try {
    const data = await api("/api/music", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (exportState.auditionName === name) {
      auditionAudio.pause();
      exportState.auditionName = "";
    }
    if (data.settings) {
      exportState.saved = cloneExportSettings(data.settings);
      if (exportState.draft.music.file === name) {
        exportState.draft.music.file = "";
        exportState.draft.music.enabled = false;
      }
    }
    exportState.music = exportState.music.filter((t) => t.name !== name);
    downloads.clear();
    updateExportActiveBadge();
    renderExportPage();
    showToast(`已删除背景音乐 ${name}`);
  } catch (error) {
    $("musicError").textContent = error.message;
    $("musicError").hidden = false;
  }
}
function uploadSingleMusic(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const p = new URLSearchParams({ name: file.name });
    xhr.open("POST", `/api/music?${p}`);
    xhr.setRequestHeader("Content-Type", file.type || "audio/mpeg");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onerror = () => reject(new Error("网络连接中断，请重试"));
    xhr.onabort = () => reject(new Error("上传已取消"));
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
    xhr.send(file);
  });
}
async function uploadMusicFiles(fileList) {
  const files = [...fileList];
  if (!files.length || exportState.uploadingMusic) return;
  $("musicError").hidden = true;
  const rejected = [];
  const accepted = [];
  for (const file of files) {
    if (!/\.mp3$/i.test(file.name)) {
      rejected.push(`${file.name}：仅支持 MP3 格式`);
      continue;
    }
    if (!file.size) {
      rejected.push(`${file.name}：文件为空`);
      continue;
    }
    if (file.size > exportState.maxMusicBytes) {
      rejected.push(
        `${file.name}：超过 ${formatSize(exportState.maxMusicBytes)} 限制`,
      );
      continue;
    }
    accepted.push(file);
  }
  if (rejected.length) {
    $("musicError").textContent = rejected.join("；");
    $("musicError").hidden = false;
  }
  if (!accepted.length) return;

  exportState.uploadingMusic = true;
  $("musicDropZone").disabled = true;
  $("musicUploadStatus").hidden = false;
  let uploadedCount = 0;
  let lastTrack = null;
  try {
    for (let i = 0; i < accepted.length; i++) {
      const file = accepted[i];
      $("musicUploadStatus").textContent =
        `正在上传 ${i + 1} / ${accepted.length}：${file.name}…`;
      try {
        const res = await uploadSingleMusic(file, (loaded, total) => {
          const pct = Math.round((loaded / total) * 100);
          $("musicUploadStatus").textContent =
            pct >= 100
              ? `正在验证 ${file.name}…`
              : `正在上传 ${i + 1} / ${accepted.length}：${file.name}（${pct}%）`;
        });
        lastTrack = res.track;
        uploadedCount++;
      } catch (error) {
        $("musicError").textContent = `${file.name}：${error.message}`;
        $("musicError").hidden = false;
      }
    }
    const refreshed = await api("/api/music");
    exportState.music = refreshed.music || [];
    if (lastTrack && !exportState.draft.music.file) {
      exportState.draft.music.file = lastTrack.name;
    }
    if (uploadedCount) showToast(`已上传 ${uploadedCount} 首 MP3`);
  } catch (error) {
    $("musicError").textContent = error.message;
    $("musicError").hidden = false;
  } finally {
    exportState.uploadingMusic = false;
    $("musicDropZone").disabled = false;
    $("musicUploadStatus").hidden = true;
    renderExportPage();
  }
}
function renderExportStatus() {
  const dirty = isExportDirty();
  $("exportDirtyState").textContent = exportState.saving
    ? "正在保存…"
    : dirty
      ? "有未保存更改"
      : "已保存";
  $("exportDirtyState").classList.toggle("is-dirty", dirty && !exportState.saving);
  $("exportSave").disabled = exportState.saving;
  $("exportReset").disabled = exportState.saving;
  renderPreviewSummary();
}
function renderExportControls() {
  const wm = exportState.draft.watermark;
  const mu = exportState.draft.music;

  setSwitchState($("wmEnabled"), wm.enabled, wm.enabled ? "已开启" : "已关闭");
  $("wmFields").disabled = !wm.enabled;
  $("wmText").value = wm.text;
  $("wmColor").value = wm.color;
  $("wmColorHex").textContent = wm.color;
  setSwitchState($("wmBold"), wm.bold, wm.bold ? "加粗" : "常规");

  $("wmFontSize").value = String(wm.fontSize);
  $("wmFontSizeValue").textContent = `${wm.fontSize} px`;
  syncRangeSlider($("wmFontSize"), `${wm.fontSize} px`);

  $("wmBgColor").value = wm.backgroundColor;
  $("wmBgColorHex").textContent = wm.backgroundColor;

  const bgOpacityPct = Math.round(wm.backgroundOpacity * 100);
  $("wmBgOpacity").value = String(bgOpacityPct);
  $("wmBgOpacityValue").textContent = `${bgOpacityPct}%`;
  syncRangeSlider($("wmBgOpacity"), `${bgOpacityPct}%`);

  $("wmBorderRadius").value = String(wm.borderRadius);
  $("wmBorderRadiusValue").textContent = `${wm.borderRadius} px`;
  syncRangeSlider($("wmBorderRadius"), `${wm.borderRadius} px`);

  const opacityPct = Math.round(wm.opacity * 100);
  $("wmOpacity").value = String(opacityPct);
  $("wmOpacityValue").textContent = `${opacityPct}%`;
  syncRangeSlider($("wmOpacity"), `${opacityPct}%`);

  $("wmPaddingX").value = String(wm.paddingX);
  $("wmPaddingXValue").textContent = `${wm.paddingX} px`;
  syncRangeSlider($("wmPaddingX"), `${wm.paddingX} px`);

  $("wmPaddingY").value = String(wm.paddingY);
  $("wmPaddingYValue").textContent = `${wm.paddingY} px`;
  syncRangeSlider($("wmPaddingY"), `${wm.paddingY} px`);

  setSwitchState(
    $("musicEnabled"),
    mu.enabled,
    mu.enabled ? "已开启" : "已关闭",
  );
  $("musicFields").disabled = !mu.enabled;

  const volPct = Math.round(mu.volume * 100);
  $("musicVolume").value = String(volPct);
  $("musicVolumeValue").textContent = `${volPct}%`;
  syncRangeSlider($("musicVolume"), `${volPct}%`);

  const keepOrig = mu.keepOriginalAudio !== false;
  setSwitchState(
    $("musicKeepOriginal"),
    keepOrig,
    keepOrig ? "保留原声" : "静音原声",
  );

  setSwitchState($("musicLoop"), mu.loop, mu.loop ? "开启循环" : "单次播放");
}
function renderExportPage() {
  if (state.view !== "export") return;
  if (exportState.loadError) {
    $("exportError").textContent = exportState.loadError;
    $("exportError").hidden = false;
  } else {
    $("exportError").hidden = true;
  }
  syncPreviewVideo();
  renderExportControls();
  renderMusicList();
  syncPreviewAudioSource();
  drawPreviewWatermark();
  renderExportStatus();
}
async function loadExportSettings({ silent = false } = {}) {
  try {
    const wasDirty = isExportDirty();
    const data = await api("/api/export-settings");
    exportState.saved = cloneExportSettings(data.settings);
    if (!exportState.loaded || !wasDirty) {
      exportState.draft = cloneExportSettings(data.settings);
    }
    exportState.music = data.music || [];
    exportState.maxMusicBytes = data.maxMusicBytes || exportState.maxMusicBytes;
    if (
      exportState.draft.music.file &&
      !exportState.music.some((t) => t.name === exportState.draft.music.file)
    ) {
      exportState.draft.music.file = "";
    }
    exportState.loaded = true;
    exportState.loadError = "";
    updateExportActiveBadge();
    if (state.view === "export") renderExportPage();
  } catch (error) {
    exportState.loadError = error.message;
    if (!silent) showToast(`读取设置失败：${error.message}`);
    if (state.view === "export") renderExportPage();
  }
}
async function saveExportSettings() {
  if (exportState.saving) return;
  $("exportError").hidden = true;
  const wm = exportState.draft.watermark;
  const mu = exportState.draft.music;
  if (wm.enabled && !wm.text.trim()) {
    $("exportError").textContent = "开启文字水印时，请先输入水印内容。";
    $("exportError").hidden = false;
    $("wmText").focus();
    return;
  }
  if (mu.enabled && !mu.file) {
    $("exportError").textContent = "开启背景音乐前，请先上传并选择一首 MP3。";
    $("exportError").hidden = false;
    return;
  }

  exportState.saving = true;
  renderExportStatus();
  try {
    const payload = { settings: exportState.draft };
    if (wm.enabled && wm.text.trim()) {
      const overlay = exportWatermarkOverlayPng(wm);
      payload.overlayPng = overlay.overlayPng;
      payload.overlayScale = overlay.overlayScale;
    }
    const data = await api("/api/export-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    exportState.saved = cloneExportSettings(data.settings);
    exportState.draft = cloneExportSettings(data.settings);
    downloads.clear();
    updateExportActiveBadge();
    renderExportPage();
    showToast("水印与音乐设置已保存，所有下载将按新设置处理");
  } catch (error) {
    $("exportError").textContent = error.message;
    $("exportError").hidden = false;
  } finally {
    exportState.saving = false;
    renderExportStatus();
  }
}

window.addEventListener("beforeunload", (e) => {
  if (uploading || deleting || isExportDirty()) {
    e.preventDefault();
    e.returnValue = "";
  }
});
$("searchInput").value = state.search;
$("hideProcessed").checked = state.hideProcessed;
$("sortSelect").value = state.sort;
$("pageSizeSelect").value = String(state.pageSize);
renderGridLayout();
$("gridLayoutSwitch")
  .querySelectorAll("button")
  .forEach((toggle) => {
    toggle.addEventListener("click", () => {
      state.maxColumns = Number(toggle.dataset.columns);
      renderGridLayout();
      syncURL();
    });
  });
$("searchInput").addEventListener("input", () => {
  state.search = $("searchInput").value.trim();
  state.page = 1;
  renderLibrary();
});
$("hideProcessed").addEventListener("change", () => {
  state.hideProcessed = $("hideProcessed").checked;
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
$("manageRefresh").addEventListener("click", () => loadLibrary({ notify: true }));
$("manageSelectPage").addEventListener("change", () => {
  for (const checkbox of $("manageRows").querySelectorAll(".management-checkbox")) {
    if ($("manageSelectPage").checked) management.selected.add(checkbox.dataset.videoId);
    else management.selected.delete(checkbox.dataset.videoId);
  }
  syncManagementSelection();
});
$("manageClearSelection").addEventListener("click", () => {
  management.selected.clear();
  syncManagementSelection();
});
$("manageDeleteSelected").addEventListener("click", () => {
  openDelete(state.videos.filter((video) => management.selected.has(video.id)));
});
for (const [id, key, event] of [
  ["manageSearch", "search", "input"],
  ["manageUser", "user", "change"],
  ["manageProcessed", "processed", "change"],
  ["manageSort", "sort", "change"],
  ["managePageSize", "pageSize", "change"],
]) {
  $(id).addEventListener(event, () => {
    management[key] = key === "pageSize" ? Number($(id).value) : $(id).value.trim();
    if (["search", "user", "processed"].includes(key)) management.selected.clear();
    management.page = 1;
    renderManagement();
  });
}
$("confirmDelete").addEventListener("click", confirmDelete);
$("cancelDelete").addEventListener("click", closeDelete);
$("closeDelete").addEventListener("click", closeDelete);
$("deleteDialog").addEventListener("cancel", (event) => {
  if (deleting) event.preventDefault();
});
$("deleteDialog").addEventListener("close", () => { deleteTargets = []; });
closeOnBackdrop($("deleteDialog"), closeDelete);

// Export settings page events
$("previewPlayToggle").addEventListener("click", () => {
  const videoEl = $("previewVideo");
  if (!state.videos.length || videoEl.hidden) return;
  if (videoEl.paused || videoEl.ended) {
    videoEl.play().catch(() => {});
  } else {
    videoEl.pause();
  }
});
$("previewSeek").addEventListener("pointerdown", () => {
  previewScrubbing = true;
});
for (const ev of ["pointerup", "pointercancel"]) {
  $("previewSeek").addEventListener(ev, () => {
    previewScrubbing = false;
  });
}
$("previewSeek").addEventListener("input", () => {
  const videoEl = $("previewVideo");
  const dur = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
  if (!dur) return;
  const target = (Number($("previewSeek").value) / 1000) * dur;
  videoEl.currentTime = target;
  const timeText = `${formatClock(target)} / ${formatClock(dur)}`;
  $("previewTime").textContent = timeText;
  syncRangeSlider($("previewSeek"), timeText);
  syncPreviewAudioPlayback();
});
$("previewSeek").addEventListener("change", () => {
  previewScrubbing = false;
  syncPreviewPlaybackUI();
});
$("previewVideo").addEventListener("loadedmetadata", () => {
  const active = state.videos[0];
  if (active && $("previewVideo").videoWidth > 0) {
    $("previewVideoMeta").textContent =
      `${active.user} / ${active.name} · ${$("previewVideo").videoWidth}×${$("previewVideo").videoHeight}`;
  }
  syncPreviewPlaybackUI();
  drawPreviewWatermark();
});
for (const ev of ["timeupdate", "durationchange"]) {
  $("previewVideo").addEventListener(ev, syncPreviewPlaybackUI);
}
$("previewVideo").addEventListener("play", () => {
  syncPreviewPlaybackUI();
  syncPreviewAudioPlayback();
});
$("previewVideo").addEventListener("pause", () => {
  syncPreviewPlaybackUI();
  $("previewAudio").pause();
});
$("previewVideo").addEventListener("ended", () => {
  syncPreviewPlaybackUI();
  $("previewAudio").pause();
});
$("previewVideo").addEventListener("seeked", () => {
  syncPreviewPlaybackUI();
  syncPreviewAudioPlayback();
});
auditionAudio.addEventListener("ended", () => {
  exportState.auditionName = "";
  renderMusicList();
});
if (typeof ResizeObserver === "function") {
  previewResizeObserver = new ResizeObserver(() => {
    if (state.view === "export") drawPreviewWatermark();
  });
  previewResizeObserver.observe($("previewStage"));
}

function hitTestPreviewBadge(ptX, ptY, padding = 0) {
  if (!previewBadgeRect) return false;
  return (
    ptX >= previewBadgeRect.x - padding &&
    ptX <= previewBadgeRect.x + previewBadgeRect.w + padding &&
    ptY >= previewBadgeRect.y - padding &&
    ptY <= previewBadgeRect.y + previewBadgeRect.h + padding
  );
}
function canvasCssPoint(event) {
  const rect = $("previewCanvas").getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
$("previewCanvas").addEventListener("pointerdown", (e) => {
  const wm = exportState.draft.watermark;
  if (!wm.enabled || !wm.text.trim() || !previewBadgeRect) return;
  const pt = canvasCssPoint(e);
  if (!hitTestPreviewBadge(pt.x, pt.y, 8)) return;
  e.preventDefault();
  wmDrag.active = true;
  wmDrag.pointerId = e.pointerId;
  wmDrag.grabX = Math.max(0, Math.min(previewBadgeRect.w, pt.x - previewBadgeRect.x));
  wmDrag.grabY = Math.max(0, Math.min(previewBadgeRect.h, pt.y - previewBadgeRect.y));
  wmDrag.snapX = false;
  wmDrag.snapY = false;
  $("previewCanvas").classList.add("is-dragging");
  $("previewCanvas").setPointerCapture?.(e.pointerId);
  drawPreviewWatermark();
});
$("previewCanvas").addEventListener("pointermove", (e) => {
  const wm = exportState.draft.watermark;
  if (!wm.enabled || !wm.text.trim() || !previewBadgeRect) return;
  const pt = canvasCssPoint(e);
  if (!wmDrag.active) {
    const hover = hitTestPreviewBadge(pt.x, pt.y, 4);
    if (hover !== wmDrag.hovering) {
      wmDrag.hovering = hover;
      $("previewCanvas").classList.toggle("is-hovering", hover);
      drawPreviewWatermark();
    }
    return;
  }
  if (e.pointerId !== wmDrag.pointerId) return;
  const maxLeft = Math.max(0, previewBadgeRect.canvasW - previewBadgeRect.w);
  const maxTop = Math.max(0, previewBadgeRect.canvasH - previewBadgeRect.h);
  let left = Math.max(0, Math.min(maxLeft, pt.x - wmDrag.grabX));
  let top = Math.max(0, Math.min(maxTop, pt.y - wmDrag.grabY));
  const centerLeft = maxLeft / 2;
  const centerTop = maxTop / 2;
  wmDrag.snapX = maxLeft > 0 && Math.abs(left - centerLeft) <= 5;
  wmDrag.snapY = maxTop > 0 && Math.abs(top - centerTop) <= 5;
  if (wmDrag.snapX) left = centerLeft;
  if (wmDrag.snapY) top = centerTop;

  wm.x = maxLeft > 0 ? Math.round((left / maxLeft) * 10000) / 10000 : 0.5;
  wm.y = maxTop > 0 ? Math.round((top / maxTop) * 10000) / 10000 : 0.5;
  drawPreviewWatermark();
  renderExportStatus();
});
function endWatermarkDrag(e) {
  if (!wmDrag.active) return;
  if (e && wmDrag.pointerId !== null && e.pointerId !== wmDrag.pointerId) return;
  wmDrag.active = false;
  wmDrag.snapX = false;
  wmDrag.snapY = false;
  if (wmDrag.pointerId !== null) {
    try {
      if ($("previewCanvas").hasPointerCapture?.(wmDrag.pointerId)) {
        $("previewCanvas").releasePointerCapture(wmDrag.pointerId);
      }
    } catch {}
  }
  wmDrag.pointerId = null;
  $("previewCanvas").classList.remove("is-dragging");
  drawPreviewWatermark();
}
$("previewCanvas").addEventListener("pointerup", endWatermarkDrag);
$("previewCanvas").addEventListener("pointercancel", endWatermarkDrag);
$("previewCanvas").addEventListener("pointerleave", () => {
  if (!wmDrag.active && wmDrag.hovering) {
    wmDrag.hovering = false;
    $("previewCanvas").classList.remove("is-hovering");
    drawPreviewWatermark();
  }
});
$("previewCanvas").addEventListener("keydown", (e) => {
  const wm = exportState.draft.watermark;
  if (!wm.enabled || !wm.text.trim()) return;
  const step = e.shiftKey ? 0.005 : 0.02;
  let handled = true;
  if (e.key === "ArrowLeft") wm.x = Math.max(0, Math.round((wm.x - step) * 10000) / 10000);
  else if (e.key === "ArrowRight") wm.x = Math.min(1, Math.round((wm.x + step) * 10000) / 10000);
  else if (e.key === "ArrowUp") wm.y = Math.max(0, Math.round((wm.y - step) * 10000) / 10000);
  else if (e.key === "ArrowDown") wm.y = Math.min(1, Math.round((wm.y + step) * 10000) / 10000);
  else handled = false;
  if (handled) {
    e.preventDefault();
    drawPreviewWatermark();
    renderExportStatus();
  }
});

$("wmEnabled").addEventListener("click", () => {
  exportState.draft.watermark.enabled = !exportState.draft.watermark.enabled;
  renderExportControls();
  drawPreviewWatermark();
  renderExportStatus();
});
$("wmText").addEventListener("input", () => {
  exportState.draft.watermark.text = $("wmText").value;
  drawPreviewWatermark();
  renderExportStatus();
});
$("wmColor").addEventListener("input", () => {
  exportState.draft.watermark.color = $("wmColor").value.toLowerCase();
  $("wmColorHex").textContent = exportState.draft.watermark.color;
  drawPreviewWatermark();
  renderExportStatus();
});
$("wmBold").addEventListener("click", () => {
  exportState.draft.watermark.bold = !exportState.draft.watermark.bold;
  renderExportControls();
  drawPreviewWatermark();
  renderExportStatus();
});
$("wmBgColor").addEventListener("input", () => {
  exportState.draft.watermark.backgroundColor = $("wmBgColor").value.toLowerCase();
  $("wmBgColorHex").textContent = exportState.draft.watermark.backgroundColor;
  drawPreviewWatermark();
  renderExportStatus();
});
for (const [id, field, scale, unit] of [
  ["wmFontSize", "fontSize", 1, " px"],
  ["wmBgOpacity", "backgroundOpacity", 0.01, "%"],
  ["wmBorderRadius", "borderRadius", 1, " px"],
  ["wmOpacity", "opacity", 0.01, "%"],
  ["wmPaddingX", "paddingX", 1, " px"],
  ["wmPaddingY", "paddingY", 1, " px"],
]) {
  $(id).addEventListener("input", () => {
    const raw = Number($(id).value);
    exportState.draft.watermark[field] = scale === 1 ? Math.round(raw) : raw * scale;
    const text = `${raw}${unit}`;
    $(`${id}Value`).textContent = text;
    syncRangeSlider($(id), text);
    drawPreviewWatermark();
    renderExportStatus();
  });
}

$("musicEnabled").addEventListener("click", () => {
  exportState.draft.music.enabled = !exportState.draft.music.enabled;
  renderExportControls();
  syncPreviewAudioSource();
  syncPreviewAudioPlayback();
  renderExportStatus();
});
$("musicVolume").addEventListener("input", () => {
  const pct = Number($("musicVolume").value);
  exportState.draft.music.volume = pct / 100;
  const text = `${pct}%`;
  $("musicVolumeValue").textContent = text;
  syncRangeSlider($("musicVolume"), text);
  $("previewAudio").volume = exportState.draft.music.volume;
  if (!auditionAudio.paused) auditionAudio.volume = exportState.draft.music.volume;
  renderExportStatus();
});
$("musicKeepOriginal").addEventListener("click", () => {
  exportState.draft.music.keepOriginalAudio =
    exportState.draft.music.keepOriginalAudio === false;
  renderExportControls();
  syncPreviewAudioSource();
  renderExportStatus();
});
$("musicLoop").addEventListener("click", () => {
  exportState.draft.music.loop = !exportState.draft.music.loop;
  renderExportControls();
  syncPreviewAudioSource();
  syncPreviewAudioPlayback();
  renderExportStatus();
});

$("musicDropZone").addEventListener("click", () => $("musicFileInput").click());
$("musicFileInput").addEventListener("change", () => {
  uploadMusicFiles($("musicFileInput").files);
  $("musicFileInput").value = "";
});
for (const event of ["dragenter", "dragover"]) {
  $("musicDropZone").addEventListener(event, (e) => {
    e.preventDefault();
    if (!exportState.uploadingMusic) $("musicDropZone").classList.add("dragover");
  });
}
for (const event of ["dragleave", "drop"]) {
  $("musicDropZone").addEventListener(event, (e) => {
    e.preventDefault();
    $("musicDropZone").classList.remove("dragover");
  });
}
$("musicDropZone").addEventListener("drop", (e) => {
  uploadMusicFiles(e.dataTransfer.files);
});

$("exportSave").addEventListener("click", saveExportSettings);
$("exportReset").addEventListener("click", () => {
  const preservedFile = exportState.draft.music.file;
  exportState.draft = defaultExportSettings();
  if (preservedFile && exportState.music.some((t) => t.name === preservedFile)) {
    exportState.draft.music.file = preservedFile;
  }
  $("exportError").hidden = true;
  renderExportPage();
});

window.addEventListener("hashchange", route);
for (let i = 0; i < 8; i++)
  $("videoGrid").append(el("div", "loading-placeholder"));
route();
loadLibrary();
loadExportSettings({ silent: true });
