import { Niivue, DRAG_MODE } from "@niivue/niivue";
import { apiFetch } from "./auth";

const WINDOWS = {
  brain: { min: 0, max: 80 },
  subdural: { min: -32.5, max: 182.5 },
  bone: { min: -800, max: 2000 },
};

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.15;

const state = {
  cases: [],
  filteredCases: [],
  activeCase: null,
  activeWindow: "brain",
  window: { ...WINDOWS.brain },
  sliceType: "axial",
  loadToken: 0,
  reviews: new Map(),
  sort: "case",
};

const MOUSE_CONFIG = {
  leftButton: {
    primary: DRAG_MODE.crosshair,
    withShift: DRAG_MODE.pan,
    withCtrl: DRAG_MODE.measurement,
  },
  // Right drag adjusts window level/width live instead of drawing a contrast rectangle.
  rightButton: DRAG_MODE.windowing,
  centerButton: DRAG_MODE.pan,
};

const priorViewer = new Niivue({
  backColor: [0, 0, 0, 1],
  crosshairColor: [0.2, 0.8, 1, 0.8],
  scrollRequiresFocus: false,
  dragMode: DRAG_MODE.windowing,
  dragModePrimary: DRAG_MODE.crosshair,
  mouseEventConfig: MOUSE_CONFIG,
});
const laterViewer = new Niivue({
  backColor: [0, 0, 0, 1],
  crosshairColor: [0.2, 1, 0.7, 0.8],
  scrollRequiresFocus: false,
  dragMode: DRAG_MODE.windowing,
  dragModePrimary: DRAG_MODE.crosshair,
  mouseEventConfig: MOUSE_CONFIG,
});

const panels = [
  { key: "prior", viewer: priorViewer, canvasId: "prior-canvas" },
  { key: "later", viewer: laterViewer, canvasId: "later-canvas" },
];

const elements = {
  caseCount: document.querySelector("#case-count"),
  caseList: document.querySelector("#case-list"),
  caseSearch: document.querySelector("#case-search"),
  caseSort: document.querySelector("#case-sort"),
  reviewNote: document.querySelector("#review-note"),
  reviewStatus: document.querySelector("#review-status"),
  clearScore: document.querySelector("#clear-score"),
  caseTitle: document.querySelector("#case-title"),
  caseSubtitle: document.querySelector("#case-subtitle"),
  priorDate: document.querySelector("#prior-date"),
  laterDate: document.querySelector("#later-date"),
  priorSeries: document.querySelector("#prior-series"),
  laterSeries: document.querySelector("#later-series"),
  priorMetadata: document.querySelector("#prior-metadata"),
  laterMetadata: document.querySelector("#later-metadata"),
  priorSlice: document.querySelector("#prior-slice"),
  laterSlice: document.querySelector("#later-slice"),
  priorWindow: document.querySelector("#prior-window"),
  laterWindow: document.querySelector("#later-window"),
  priorZoom: document.querySelector("#prior-zoom"),
  laterZoom: document.querySelector("#later-zoom"),
  priorError: document.querySelector("#prior-error"),
  laterError: document.querySelector("#later-error"),
  resetView: document.querySelector("#reset-view"),
  patientSummary: document.querySelector("#patient-summary"),
  patientTotals: document.querySelector("#patient-totals"),
  patientStudies: document.querySelector("#patient-studies"),
  status: document.querySelector("#status"),
  reviewFlags: document.querySelector("#review-flags"),
  previousCase: document.querySelector("#previous-case"),
  nextCase: document.querySelector("#next-case"),
  sliceType: document.querySelector("#slice-type"),
};

function valueOrDash(value) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function metadataItem(label, value) {
  const item = document.createElement("div");
  item.className = "metadata-item";
  const labelElement = document.createElement("span");
  labelElement.className = "metadata-label";
  labelElement.textContent = label;
  const valueElement = document.createElement("p");
  valueElement.className = "metadata-value";
  valueElement.textContent = valueOrDash(value);
  item.append(labelElement, valueElement);
  return item;
}

function reportBlock(label, value, extraClass = "") {
  const block = document.createElement("section");
  block.className = `report-block ${extraClass}`.trim();
  const labelElement = document.createElement("span");
  labelElement.className = "metadata-label";
  labelElement.textContent = label;
  const valueElement = document.createElement("p");
  valueElement.textContent = valueOrDash(value);
  block.append(labelElement, valueElement);
  return block;
}

function renderStudyMetadata(container, study) {
  container.replaceChildren();
  const grid = document.createElement("div");
  grid.className = "metadata-grid";
  grid.append(
    metadataItem("Examination", study.examination),
    metadataItem("Indication", study.indication),
    metadataItem("Study ID", study.study_id),
    metadataItem("Comparison", study.comparison),
    metadataItem("Series", study.volume.series_description),
    metadataItem(
      "Acquisition",
      [
        study.volume.contrast || "unknown contrast",
        `${valueOrDash(study.volume.slice_thickness_mm)} mm`,
        `${valueOrDash(study.volume.number_of_slices)} slices`,
        study.volume.kernel || "unknown kernel",
      ].join(" | "),
    ),
  );
  container.append(
    reportBlock("Findings", study.findings),
    reportBlock("Impression", study.impression, "impression"),
    grid,
  );
}

function clearVolumes(viewer) {
  while (viewer.volumes.length > 0) {
    viewer.removeVolumeByIndex(viewer.volumes.length - 1);
  }
}

// Our NIfTI files are stored as int32, which Niivue widens to Float64Array
// (8 bytes/voxel). CT Hounsfield values fit in int16, so narrowing the array
// cuts both RAM and the per-window texture upload by 4x. Lossless: we only
// convert when every voxel is an integer inside the int16 range.
function compactVoxelData(viewer) {
  const volume = viewer.volumes[0];
  if (!volume || volume.img.BYTES_PER_ELEMENT <= 2) {
    return;
  }
  const source = volume.img;
  const narrowed = new Int16Array(source.length);
  for (let i = 0; i < source.length; i++) {
    const value = source[i];
    if (!Number.isInteger(value) || value < -32768 || value > 32767) {
      return;
    }
    narrowed[i] = value;
  }
  volume.img = narrowed;
  volume.hdr.datatypeCode = 4; // DT_INT16
  volume.hdr.numBitsPerVoxel = 16;
}

function selectedSliceType(viewer) {
  const mapping = {
    axial: viewer.sliceTypeAxial,
    coronal: viewer.sliceTypeCoronal,
    sagittal: viewer.sliceTypeSagittal,
    multiplanar: viewer.sliceTypeMultiplanar,
  };
  return mapping[state.sliceType];
}

// Niivue re-bakes the whole volume inside refreshLayers, which is expensive
// (~250 ms for 512x512x68 on integrated graphics). It also does this
// synchronously on every pointermove, so events queue up faster than they drain.
//
// We keep the real bake - it is what makes the dragged image correct and
// identical to the released image - but coalesce it to at most one per animation
// frame, always using the newest window and dropping stale intermediate values.
function installWindowingThrottle(viewer) {
  const refreshLayers = viewer.refreshLayers.bind(viewer);
  const drawScene = viewer.drawScene.bind(viewer);
  let frame = 0;
  let needsRefresh = false;
  let needsDraw = false;
  let lastMin = NaN;
  let lastMax = NaN;

  const flush = () => {
    const volume = viewer.volumes[0];
    if (needsRefresh && volume && (volume.cal_min !== lastMin || volume.cal_max !== lastMax)) {
      lastMin = volume.cal_min;
      lastMax = volume.cal_max;
      refreshLayers(volume, 0);
      needsDraw = true;
    }
    needsRefresh = false;
    if (needsDraw) {
      needsDraw = false;
      drawScene();
    }
  };

  const schedule = () => {
    if (frame !== 0) {
      return;
    }
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      flush();
      updateWindowReadouts();
    });
  };

  viewer.__beginWindowing = () => {
    viewer.__windowing = true;
    lastMin = NaN;
    lastMax = NaN;
  };

  viewer.refreshLayers = (...args) => {
    if (!viewer.__windowing) {
      return refreshLayers(...args);
    }
    needsRefresh = true;
    schedule();
    return undefined;
  };

  // Niivue redraws synchronously on every pointermove; during a drag we only
  // need one paint per frame.
  viewer.drawScene = (...args) => {
    if (!viewer.__windowing) {
      return drawScene(...args);
    }
    needsDraw = true;
    schedule();
    return undefined;
  };

  viewer.__endWindowing = () => {
    if (frame !== 0) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    viewer.__windowing = false;
    flush();
    updateWindowReadouts();
  };
}

function applyWindow(viewer, window = state.window) {
  if (viewer.volumes.length === 0) {
    return;
  }
  viewer.volumes[0].cal_min = window.min;
  viewer.volumes[0].cal_max = window.max;
  viewer.updateGLVolume();
}

async function loadVolume(viewer, caseId, phase, study, errorElement) {
  clearVolumes(viewer);
  errorElement.hidden = true;
  errorElement.textContent = "";
  const response = await apiFetch(`/volumes/${encodeURIComponent(caseId)}/${phase}`, {
    cache: "force-cache",
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const message = detail.detail || detail.error || `HTTP ${response.status}`;
    errorElement.textContent = message;
    errorElement.hidden = false;
    throw new Error(message);
  }
  const volumeUrl = URL.createObjectURL(await response.blob());
  try {
    await viewer.loadVolumes([
      {
        url: volumeUrl,
        name: `${study.study_id}.nii.gz`,
        colormap: "gray",
        cal_min: state.window.min,
        cal_max: state.window.max,
        trustCalMinMax: true,
      },
    ]);
  } finally {
    URL.revokeObjectURL(volumeUrl);
  }
  compactVoxelData(viewer);
  viewer.setSliceType(selectedSliceType(viewer));
  // Each study has its own geometry, so always start from this volume's own centre.
  viewer.scene.crosshairPos = [0.5, 0.5, 0.5];
  viewer.scene.pan2Dxyzmm = [0, 0, 0, 1];
  viewer.drawScene();
}

function sliceCounts(viewer) {
  const volume = viewer.volumes[0];
  if (!volume) {
    return null;
  }
  const dims = [volume.hdr.dims[1], volume.hdr.dims[2], volume.hdr.dims[3]];
  const axis = { axial: 2, coronal: 1, sagittal: 0 }[state.sliceType];
  if (axis === undefined) {
    return null;
  }
  const total = dims[axis];
  const fraction = viewer.scene.crosshairPos[axis];
  const index = Math.min(total, Math.max(1, Math.round(fraction * total - 0.5) + 1));
  return { index, total };
}

function updateSliceReadouts() {
  for (const panel of panels) {
    const target = elements[`${panel.key}Slice`];
    const counts = sliceCounts(panel.viewer);
    target.textContent = counts
      ? `Slice ${counts.index} / ${counts.total}`
      : `${panel.viewer.volumes[0]?.hdr.dims[3] ?? "-"} slices`;
  }
}

function updateWindowReadouts() {
  for (const panel of panels) {
    const volume = panel.viewer.volumes[0];
    const target = elements[`${panel.key}Window`];
    if (!volume) {
      target.textContent = "";
      continue;
    }
    const width = volume.cal_max - volume.cal_min;
    const level = volume.cal_min + width / 2;
    target.textContent = `W ${Math.round(width)} / L ${Math.round(level)}`;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function viewerZoom(viewer) {
  return viewer.scene.pan2Dxyzmm[3];
}

function updateZoomReadouts() {
  for (const panel of panels) {
    const target = elements[`${panel.key}Zoom`];
    const zoom = viewerZoom(panel.viewer);
    // Only worth showing once the view is no longer the default framing.
    const panned = panel.viewer.scene.pan2Dxyzmm.slice(0, 3).some((v) => Math.abs(v) > 0.01);
    target.hidden = Math.abs(zoom - 1) < 0.01 && !panned;
    target.textContent = `${zoom.toFixed(1)}x`;
  }
}

// Zoom about the point under the cursor: keep the anchor's mm position fixed by
// shifting pan by the change in zoom, which is how Niivue compensates internally.
function zoomAtPoint(viewer, canvas, clientX, clientY, factor) {
  const pan = viewer.scene.pan2Dxyzmm;
  const oldZoom = pan[3];
  const newZoom = clamp(oldZoom * factor, ZOOM_MIN, ZOOM_MAX);
  if (Math.abs(newZoom - oldZoom) < 1e-6) {
    return;
  }
  const anchor = anchorMillimetres(viewer, canvas, clientX, clientY);
  const zoomChange = oldZoom - newZoom;
  viewer.setPan2Dxyzmm([
    pan[0] + zoomChange * anchor[0],
    pan[1] + zoomChange * anchor[1],
    pan[2] + zoomChange * anchor[2],
    newZoom,
  ]);
  updateZoomReadouts();
}

function anchorMillimetres(viewer, canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const dpr = viewer.uiData?.dpr ?? 1;
  const frac = viewer.canvasPos2frac([
    (clientX - rect.left) * dpr,
    (clientY - rect.top) * dpr,
  ]);
  // canvasPos2frac returns negative components when the point is off-slice.
  if (frac[0] >= 0 && frac[1] >= 0 && frac[2] >= 0) {
    return viewer.frac2mm(frac);
  }
  return viewer.frac2mm(viewer.scene.crosshairPos);
}

function resetView(viewer) {
  viewer.setPan2Dxyzmm([0, 0, 0, 1]);
  updateZoomReadouts();
}

function resetAllViews() {
  for (const panel of panels) {
    resetView(panel.viewer);
  }
}

function clearActiveWindowPreset() {
  clearAppliedSeriesPreset();
  if (state.activeWindow === null) {
    return;
  }
  state.activeWindow = null;
  for (const item of document.querySelectorAll("[data-window]")) {
    item.classList.remove("active");
  }
}

// The highlight on a DICOM preset chip only means "this is the window on screen
// right now", so any other change to the window must clear it.
function clearAppliedSeriesPreset() {
  for (const chip of document.querySelectorAll(".window-preset.applied")) {
    chip.classList.remove("applied");
  }
}

function rememberWindowFrom(viewer) {
  const volume = viewer.volumes[0];
  if (!volume) {
    return;
  }
  // Keep the hand-tuned window when moving between cases.
  state.window = { min: volume.cal_min, max: volume.cal_max };
  updateWindowReadouts();
}

function summaryStat(label, value) {
  const item = document.createElement("div");
  item.className = "summary-stat";
  const valueElement = document.createElement("strong");
  valueElement.textContent = String(value);
  const labelElement = document.createElement("span");
  labelElement.textContent = label;
  item.append(valueElement, labelElement);
  return item;
}

function formatNumber(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return Number(value).toFixed(digits);
}

function formatPixelSpacing(value) {
  if (!value) {
    return null;
  }
  // Raw DICOM strings vary ("0.376" vs "0.376000"); normalise for scanning.
  const parts = String(value)
    .split("|")
    .map((part) => Number.parseFloat(part))
    .filter((part) => Number.isFinite(part));
  if (parts.length === 0) {
    return null;
  }
  const formatted = parts.map((part) => part.toFixed(3).replace(/\.?0+$/, ""));
  const unique = [...new Set(formatted)];
  return `${unique.length === 1 ? `${unique[0]} x ${unique[0]}` : formatted.join(" x ")} mm px`;
}

// A series can carry several scanner-recommended window presets, e.g.
// WindowWidth "80|3200" with WindowCenter "35|700" is a brain window plus a
// bone window. Show them all - they are the acquisition's own guidance on how
// this reconstruction is meant to be viewed.
function dicomWindowPresets(width, center) {
  if (!width || !center) {
    return [];
  }
  const widths = String(width).split("|");
  const centers = String(center).split("|");
  const presets = [];
  for (let i = 0; i < Math.min(widths.length, centers.length); i++) {
    const w = Number.parseFloat(widths[i]);
    const c = Number.parseFloat(centers[i]);
    if (Number.isFinite(w) && Number.isFinite(c)) {
      presets.push({ width: Math.round(w), level: Math.round(c) });
    }
  }
  return presets;
}

function seriesDetailCell(item) {
  const cell = document.createElement("td");
  const parts = [
    item.kernel ? `kernel ${item.kernel}` : null,
    item.kvp ? `${formatNumber(item.kvp)} kVp` : null,
    formatPixelSpacing(item.pixel_spacing),
    item.rows && item.columns ? `${formatNumber(item.rows)}x${formatNumber(item.columns)}` : null,
  ].filter(Boolean);
  cell.textContent = parts.join(" | ") || "-";
  return cell;
}

function panelForRole(role) {
  return panels.find((panel) => panel.key === role) ?? null;
}

// DICOM stores window as width/level; Niivue wants min/max intensities.
function presetToWindow(preset) {
  return {
    min: preset.level - preset.width / 2,
    max: preset.level + preset.width / 2,
  };
}

function applySeriesPreset(role, preset, chip) {
  const panel = panelForRole(role);
  if (!panel) {
    return;
  }
  const window = presetToWindow(preset);
  state.window = window;
  // Clears the toolbar selection and any previously applied chip.
  clearActiveWindowPreset();
  applyWindow(panel.viewer, window);
  updateWindowReadouts();
  if (chip) {
    chip.classList.add("applied");
  }
}

function seriesWindowCell(item, study) {
  const cell = document.createElement("td");
  cell.className = "window-presets";
  const presets = dicomWindowPresets(item.window_width, item.window_center);
  if (presets.length === 0) {
    cell.textContent = "-";
    return cell;
  }
  // Only the series actually on screen can be re-windowed by clicking.
  const target = item.is_selected ? panelForRole(study.role) : null;

  for (const preset of presets) {
    const label = `W ${preset.width} / L ${preset.level}`;
    if (!target) {
      const chip = document.createElement("span");
      chip.className = "window-preset";
      chip.textContent = label;
      cell.append(chip);
      continue;
    }
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "window-preset actionable";
    chip.textContent = label;
    chip.title = `Apply ${label} to the ${study.role} panel`;
    chip.addEventListener("click", () => {
      applySeriesPreset(study.role, preset, chip);
    });
    cell.append(chip);
  }
  return cell;
}

function seriesTable(study) {
  const table = document.createElement("table");
  table.className = "series-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Series", "Thickness", "Slices", "Acquisition detail", "DICOM window"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    if (label === "Thickness" || label === "Slices") {
      cell.className = "numeric";
    }
    headRow.append(cell);
  }
  head.append(headRow);

  const body = document.createElement("tbody");
  for (const item of study.series) {
    const row = document.createElement("tr");
    if (item.is_selected) {
      row.classList.add("series-selected");
    }
    if (item.is_localizer) {
      row.classList.add("series-localizer");
    }

    const nameCell = document.createElement("td");
    const name = document.createElement("span");
    name.className = "series-name";
    name.textContent = valueOrDash(item.series_description);
    nameCell.append(name);
    if (item.is_selected) {
      const tag = document.createElement("span");
      tag.className = "series-tag";
      tag.textContent = "viewing";
      nameCell.append(" ", tag);
    }
    if (item.is_localizer) {
      const tag = document.createElement("span");
      tag.className = "series-tag muted-tag";
      tag.textContent = "localizer";
      nameCell.append(" ", tag);
    }

    const thicknessCell = document.createElement("td");
    thicknessCell.className = "numeric";
    thicknessCell.textContent =
      item.slice_thickness_mm === null || item.slice_thickness_mm === undefined
        ? "-"
        : `${formatNumber(item.slice_thickness_mm, 1)} mm`;

    const slicesCell = document.createElement("td");
    slicesCell.className = "numeric";
    slicesCell.textContent = formatNumber(item.number_of_slices);

    row.append(nameCell, thicknessCell, slicesCell, seriesDetailCell(item), seriesWindowCell(item, study));
    body.append(row);
  }

  table.append(head, body);
  return table;
}

function studyRows(study, index) {
  const rows = [];
  const hasSeries = Array.isArray(study.series) && study.series.length > 0;
  const detailId = `series-${index}`;

  const row = document.createElement("tr");
  row.className = "study-row";
  if (study.role) {
    row.classList.add(`role-${study.role}`);
  }

  const dateCell = document.createElement("td");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "series-toggle";
  toggle.disabled = !hasSeries;
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", detailId);
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = hasSeries ? "\u25B8" : "\u00B7";
  const dateText = document.createElement("span");
  dateText.textContent = valueOrDash(study.date);
  toggle.append(caret, dateText);
  dateCell.append(toggle);
  if (study.role) {
    const tag = document.createElement("span");
    tag.className = "role-tag";
    tag.textContent = study.role;
    dateCell.append(" ", tag);
  }

  const examCell = document.createElement("td");
  const exam = document.createElement("strong");
  exam.textContent = valueOrDash(study.examination);
  examCell.append(exam);
  if (study.description) {
    const description = document.createElement("p");
    description.className = "study-description";
    description.textContent = study.description;
    examCell.append(description);
  }

  const seriesCell = document.createElement("td");
  seriesCell.className = "numeric";
  seriesCell.textContent = valueOrDash(study.series_count);

  const slicesCell = document.createElement("td");
  slicesCell.className = "numeric";
  slicesCell.textContent = valueOrDash(study.slice_count);

  const detailCell = document.createElement("td");
  detailCell.textContent = [
    study.modality,
    study.contrast ? `${study.contrast} contrast` : null,
    (study.body_regions || []).join("/") || null,
  ]
    .filter(Boolean)
    .join(" | ");

  row.append(dateCell, examCell, seriesCell, slicesCell, detailCell);
  rows.push(row);

  if (hasSeries) {
    // Collapsed by default; the toggle flips this row's hidden state.
    const detailRow = document.createElement("tr");
    detailRow.className = "series-row";
    detailRow.id = detailId;
    detailRow.hidden = true;
    const wrapper = document.createElement("td");
    wrapper.colSpan = 5;
    wrapper.append(seriesTable(study));
    detailRow.append(wrapper);
    rows.push(detailRow);

    toggle.addEventListener("click", () => {
      const expanded = detailRow.hidden;
      detailRow.hidden = !expanded;
      toggle.setAttribute("aria-expanded", String(expanded));
      caret.textContent = expanded ? "\u25BE" : "\u25B8";
      row.classList.toggle("expanded", expanded);
    });
  }

  return rows;
}

function renderPatientSummary(candidate) {
  const patient = candidate.patient;
  elements.patientTotals.replaceChildren();
  elements.patientStudies.replaceChildren();

  if (!patient) {
    elements.patientSummary.hidden = true;
    return;
  }
  elements.patientSummary.hidden = false;

  elements.patientTotals.append(
    summaryStat("studies for patient", patient.total_studies),
    summaryStat("series across studies", patient.total_series),
    summaryStat("slices across studies", patient.total_slices),
    summaryStat("studies in this pair", patient.selected_studies),
  );

  const table = document.createElement("table");
  table.className = "study-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Date", "Examination", "Series", "Slices", "Detail"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    if (label === "Series" || label === "Slices") {
      cell.className = "numeric";
    }
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  patient.studies.forEach((study, index) => {
    body.append(...studyRows(study, index));
  });
  table.append(head, body);
  elements.patientStudies.append(table);
}

function reviewFor(caseId) {
  return state.reviews.get(caseId) ?? { score: null, note: "" };
}

function setSaveStatus(text, tone = "") {
  elements.reviewStatus.textContent = text;
  elements.reviewStatus.className = `review-save ${tone}`.trim();
}

async function persistReview(caseId, score, note) {
  const response = await apiFetch(`/reviews/${caseId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ score, note }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail || detail.error || `HTTP ${response.status}`);
  }
  return response.json();
}

let saveTimer = 0;
let saveChain = Promise.resolve();

function queueReviewSave(caseId, score, note) {
  // Keep the local view authoritative so the UI never flickers back while a
  // request is in flight.
  if (score === null && !note) {
    state.reviews.delete(caseId);
  } else {
    state.reviews.set(caseId, { score, note });
  }
  renderReviewControls();
  renderCaseList();
  setSaveStatus("Saving...");
  // Serialise writes for a case so rapid edits cannot land out of order.
  saveChain = saveChain
    .then(() => persistReview(caseId, score, note))
    .then(() => setSaveStatus("Saved", "ok"))
    .catch((error) => {
      console.error(error);
      setSaveStatus(`Not saved: ${error.message}`, "error");
    });
  return saveChain;
}

function applyScore(score) {
  const candidate = state.activeCase;
  if (!candidate) {
    return;
  }
  const current = reviewFor(candidate.id);
  // Clicking the active score clears it, so one key can toggle.
  const next = current.score === score ? null : score;
  queueReviewSave(candidate.id, next, current.note);
}

function scheduleNoteSave() {
  const candidate = state.activeCase;
  if (!candidate) {
    return;
  }
  window.clearTimeout(saveTimer);
  setSaveStatus("Saving...");
  saveTimer = window.setTimeout(() => {
    const current = reviewFor(candidate.id);
    queueReviewSave(candidate.id, current.score, elements.reviewNote.value.trim());
  }, 500);
}

function flushNoteSave() {
  const candidate = state.activeCase;
  if (!candidate) {
    return;
  }
  window.clearTimeout(saveTimer);
  const current = reviewFor(candidate.id);
  const note = elements.reviewNote.value.trim();
  if (note !== current.note) {
    queueReviewSave(candidate.id, current.score, note);
  }
}

function renderReviewControls() {
  const candidate = state.activeCase;
  const review = candidate ? reviewFor(candidate.id) : { score: null, note: "" };
  for (const button of document.querySelectorAll("[data-score]")) {
    button.classList.toggle("active", Number(button.dataset.score) === review.score);
  }
  elements.clearScore.disabled = review.score === null && !review.note;
  if (document.activeElement !== elements.reviewNote) {
    elements.reviewNote.value = review.note;
  }
}

async function persistSort(sort) {
  try {
    await apiFetch("/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sort }),
    });
  } catch (error) {
    console.error(error);
  }
}

function sortedCases(cases) {
  const items = [...cases];
  const score = (item) => reviewFor(item.id).score;
  if (state.sort === "case") {
    return items.sort((a, b) => a.case_number - b.case_number);
  }
  if (state.sort === "unscored-first") {
    return items.sort((a, b) => {
      const left = score(a);
      const right = score(b);
      if ((left === null) !== (right === null)) {
        return left === null ? -1 : 1;
      }
      return a.case_number - b.case_number;
    });
  }
  const direction = state.sort === "score-desc" ? -1 : 1;
  return items.sort((a, b) => {
    const left = score(a);
    const right = score(b);
    // Unscored cases always sit at the end of a score-ordered list.
    if (left === null && right === null) {
      return a.case_number - b.case_number;
    }
    if (left === null) {
      return 1;
    }
    if (right === null) {
      return -1;
    }
    if (left !== right) {
      return (left - right) * direction;
    }
    return a.case_number - b.case_number;
  });
}

function renderCaseList() {
  elements.caseList.replaceChildren();
  for (const candidate of sortedCases(state.filteredCases)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "case-button";
    if (candidate.id === state.activeCase?.id) {
      button.classList.add("active");
    }
    button.dataset.caseId = candidate.id;

    const review = reviewFor(candidate.id);
    const title = document.createElement("strong");
    title.textContent = `Case ${String(candidate.case_number).padStart(3, "0")}`;
    if (review.score !== null) {
      const badge = document.createElement("span");
      badge.className = `score-badge score-${review.score}`;
      badge.textContent = review.score;
      badge.title = `Score ${review.score}`;
      title.append(" ", badge);
    }
    if (review.note) {
      const marker = document.createElement("span");
      marker.className = "note-marker";
      marker.textContent = "\u270E";
      marker.title = review.note;
      title.append(" ", marker);
    }
    const patient = document.createElement("span");
    patient.textContent = candidate.patient_id;
    const dates = document.createElement("span");
    dates.textContent = `${candidate.prior.date} -> ${candidate.later.date} (${candidate.days_apart}d)`;
    button.append(title, patient, dates);

    if (candidate.review_flags.length > 0) {
      const warning = document.createElement("span");
      warning.className = "warning-marker";
      warning.textContent = "Review series selection";
      button.append(warning);
    }

    button.addEventListener("click", () => loadCase(candidate.id));
    elements.caseList.append(button);
  }
  elements.caseCount.textContent = `${state.filteredCases.length} of ${state.cases.length} cases`;
}

function updateNavigation() {
  const ordered = sortedCases(state.filteredCases);
  const index = ordered.findIndex((item) => item.id === state.activeCase?.id);
  elements.previousCase.disabled = index <= 0;
  elements.nextCase.disabled = index < 0 || index >= ordered.length - 1;
}

async function loadCase(caseId) {
  const candidate = state.cases.find((item) => item.id === caseId);
  if (!candidate) {
    return;
  }
  state.activeCase = candidate;
  const token = ++state.loadToken;
  renderCaseList();
  updateNavigation();

  elements.caseTitle.textContent = `Case ${String(candidate.case_number).padStart(3, "0")}`;
  elements.caseSubtitle.textContent =
    `${candidate.patient_id} | ${candidate.patient_age || "age unknown"} | ` +
    `${candidate.patient_sex || "sex unknown"} | ${candidate.days_apart} day interval`;
  elements.priorDate.textContent = candidate.prior.date;
  elements.laterDate.textContent = candidate.later.date;
  elements.priorSeries.textContent = candidate.prior.volume.series_description || "Selected series";
  elements.laterSeries.textContent = candidate.later.volume.series_description || "Selected series";
  renderStudyMetadata(elements.priorMetadata, candidate.prior);
  renderStudyMetadata(elements.laterMetadata, candidate.later);
  renderPatientSummary(candidate);
  renderReviewControls();
  setSaveStatus("");

  if (candidate.review_flags.length > 0) {
    elements.reviewFlags.hidden = false;
    elements.reviewFlags.textContent = candidate.review_flags.join(" ");
  } else {
    elements.reviewFlags.hidden = true;
    elements.reviewFlags.textContent = "";
  }

  elements.status.hidden = false;
  elements.status.textContent = "Loading paired NIfTI volumes...";
  elements.priorError.hidden = true;
  elements.laterError.hidden = true;
  try {
    await Promise.all([
      loadVolume(priorViewer, candidate.id, "prior", candidate.prior, elements.priorError),
      loadVolume(laterViewer, candidate.id, "later", candidate.later, elements.laterError),
    ]);
    if (token !== state.loadToken) {
      return;
    }
    updateSliceReadouts();
    updateWindowReadouts();
    updateZoomReadouts();
    elements.status.hidden = true;
  } catch (error) {
    console.error(error);
    elements.status.hidden = false;
    elements.status.textContent = `Unable to load this case: ${error.message}`;
  }
}

function moveCase(offset) {
  const ordered = sortedCases(state.filteredCases);
  const index = ordered.findIndex((item) => item.id === state.activeCase?.id);
  const next = ordered[index + offset];
  if (next) {
    loadCase(next.id);
  }
}

function filterCases() {
  const term = elements.caseSearch.value.trim().toLowerCase();
  if (!term) {
    state.filteredCases = [...state.cases];
  } else {
    state.filteredCases = state.cases.filter((candidate) => {
      const searchable = [
        candidate.patient_id,
        candidate.prior.examination,
        candidate.prior.indication,
        candidate.prior.findings,
        candidate.prior.impression,
        candidate.prior.volume.series_description,
        candidate.later.examination,
        candidate.later.indication,
        candidate.later.findings,
        candidate.later.impression,
        candidate.later.volume.series_description,
      ].join(" ").toLowerCase();
      return searchable.includes(term);
    });
  }
  renderCaseList();
  updateNavigation();
}

async function initialize() {
  await Promise.all([
    priorViewer.attachToCanvas(document.querySelector("#prior-canvas")),
    laterViewer.attachToCanvas(document.querySelector("#later-canvas")),
  ]);

  // The constructor silently ignores mouseEventConfig, so apply it explicitly;
  // without this, shift+left and middle drags fall back to the default drag mode
  // and never pan.
  priorViewer.setMouseEventConfig(MOUSE_CONFIG);
  laterViewer.setMouseEventConfig(MOUSE_CONFIG);

  for (const panel of panels) {
    const canvas = document.querySelector(`#${panel.canvasId}`);
    const wrap = canvas.closest(".canvas-wrap");
    // Wheel over a panel should scroll that volume only, never the page.
    canvas.addEventListener("mouseenter", () => canvas.focus());
    // Ctrl/Cmd + wheel zooms. Niivue registers its own wheel listener on the
    // canvas first, so intercept on the wrapper during capture and stop the
    // event before it can be treated as a slice scroll.
    wrap.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.metaKey) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        canvas.focus();
        zoomAtPoint(
          panel.viewer,
          canvas,
          event.clientX,
          event.clientY,
          event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
        );
      },
      { capture: true, passive: false },
    );
    canvas.addEventListener("wheel", (event) => event.preventDefault(), {
      passive: false,
    });
    canvas.addEventListener("wheel", () => {
      window.requestAnimationFrame(updateSliceReadouts);
    });
    // Suppress the browser menu so a right drag is a pure windowing gesture.
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button === 2) {
        clearActiveWindowPreset();
        panel.viewer.__beginWindowing();
      }
    });
    canvas.addEventListener("pointermove", (event) => {
      if ((event.buttons & 2) !== 0) {
        window.requestAnimationFrame(updateWindowReadouts);
      }
      // Middle-drag and shift+left-drag pan; keep the zoom badge in sync.
      if ((event.buttons & 4) !== 0 || (event.shiftKey && (event.buttons & 1) !== 0)) {
        window.requestAnimationFrame(updateZoomReadouts);
      }
    });
    canvas.addEventListener("pointerup", (event) => {
      if (event.button === 2) {
        panel.viewer.__endWindowing();
        rememberWindowFrom(panel.viewer);
      }
    });
    // A right-drag that ends outside the canvas must not leave the LUT preview on.
    canvas.addEventListener("pointerleave", () => {
      if (panel.viewer.__windowing) {
        panel.viewer.__endWindowing();
        rememberWindowFrom(panel.viewer);
      }
    });
    installWindowingThrottle(panel.viewer);
    panel.viewer.onLocationChange = updateSliceReadouts;
  }

  const response = await apiFetch("/manifest", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Manifest request failed with HTTP ${response.status}`);
  }
  const manifest = await response.json();
  state.cases = manifest.cases;
  state.filteredCases = [...state.cases];
  await loadReviews();
  renderCaseList();
  await loadCase(state.cases[0].id);
}

async function loadReviews() {
  try {
    const response = await apiFetch("/reviews", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const document_ = await response.json();
    state.reviews = new Map(
      (document_.reviews || []).map((item) => [
        item.case_id,
        { score: item.score ?? null, note: item.note ?? "" },
      ]),
    );
    state.sort = document_.preferences?.sort ?? "case";
    elements.caseSort.value = state.sort;
  } catch (error) {
    // The viewer still works read-only if the review API is unavailable.
    console.error(error);
    setSaveStatus("Review API unavailable; labels will not persist", "error");
  }
}

elements.caseSearch.addEventListener("input", filterCases);
elements.previousCase.addEventListener("click", () => moveCase(-1));
elements.nextCase.addEventListener("click", () => moveCase(1));
elements.resetView.addEventListener("click", resetAllViews);

for (const button of document.querySelectorAll("[data-score]")) {
  button.addEventListener("click", () => applyScore(Number(button.dataset.score)));
}

elements.clearScore.addEventListener("click", () => {
  const candidate = state.activeCase;
  if (!candidate) {
    return;
  }
  window.clearTimeout(saveTimer);
  elements.reviewNote.value = "";
  queueReviewSave(candidate.id, null, "");
});

elements.reviewNote.addEventListener("input", scheduleNoteSave);
elements.reviewNote.addEventListener("blur", flushNoteSave);

elements.caseSort.addEventListener("change", () => {
  state.sort = elements.caseSort.value;
  renderCaseList();
  updateNavigation();
  persistSort(state.sort);
});
elements.sliceType.addEventListener("change", () => {
  state.sliceType = elements.sliceType.value;
  priorViewer.setSliceType(selectedSliceType(priorViewer));
  laterViewer.setSliceType(selectedSliceType(laterViewer));
  updateSliceReadouts();
});

for (const button of document.querySelectorAll("[data-window]")) {
  button.addEventListener("click", () => {
    state.activeWindow = button.dataset.window;
    state.window = { ...WINDOWS[state.activeWindow] };
    clearAppliedSeriesPreset();
    document.querySelectorAll("[data-window]").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    applyWindow(priorViewer);
    applyWindow(laterViewer);
    updateWindowReadouts();
  });
}

document.addEventListener("keydown", (event) => {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement ||
    event.target instanceof HTMLTextAreaElement
  ) {
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (event.key === "ArrowLeft") {
    moveCase(-1);
  } else if (event.key === "ArrowRight") {
    moveCase(1);
  } else if (/^[1-5]$/.test(event.key)) {
    event.preventDefault();
    applyScore(Number(event.key));
  } else if (event.key === "0") {
    event.preventDefault();
    const candidate = state.activeCase;
    if (candidate) {
      queueReviewSave(candidate.id, null, reviewFor(candidate.id).note);
    }
  }
});

initialize().catch((error) => {
  console.error(error);
  elements.status.hidden = false;
  elements.status.textContent = `Viewer initialization failed: ${error.message}`;
});
