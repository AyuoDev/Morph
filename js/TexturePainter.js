// js/TexturePainter.js
// ============================================================================
// TEXTURE PAINTER CLASS — Core drawing engine (tools, brush, bucket fill)
// ============================================================================
import * as THREE from "three";

export class TexturePainter {
  constructor({ canvas, mesh, material, texture }) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext("2d");
    this.mesh     = mesh;
    this.material = material;
    this.texture  = texture;

    this.tool      = "draw"; // draw | erase | move | bucket
    this.color     = "#ffffff";
    this.brushSize = 10;
    this.opacity   = 1.0;
    this.isDrawing = false;

    this._bindDefaults();
  }

  /* ── Setup ─────────────────────────────────────────────────────────── */

  _bindDefaults() {
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.lineCap  = "round";
    this.ctx.lineJoin = "round";
  }

  /* ── Texture loading ────────────────────────────────────────────────── */

  loadFromTexture(texture) {
    const image = texture.image;
    if (!image) return;
    this.canvas.width  = image.width;
    this.canvas.height = image.height;
    this.ctx.clearRect(0, 0, image.width, image.height);
    this.ctx.drawImage(image, 0, 0);
    this.applyToMaterial();
  }

  createBlank(width = 1024, height = 1024) {
    this.canvas.width  = width;
    this.canvas.height = height;
    this.ctx.clearRect(0, 0, width, height);
    this.applyToMaterial();
  }

  /* ── Tool setters ───────────────────────────────────────────────────── */

  setTool(tool)      { this.tool      = tool; }
  setColor(color)    { this.color     = color; }
  setBrushSize(size) { this.brushSize = size; }
  setOpacity(value)  { this.opacity   = value; }

  /* ── Drawing ────────────────────────────────────────────────────────── */

  startDraw(x, y) {
    if (this.tool === "move") return;

    if (this.tool === "bucket") {
      this.bucketFill(Math.floor(x), Math.floor(y));
      if (this.material.map) this.material.map.needsUpdate = true;
      return;
    }

    this.isDrawing = true;
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
  }

  draw(x, y) {
    if (!this.isDrawing || this.tool === "move") return;

    if (this.tool === "erase") {
      this.ctx.globalCompositeOperation = "destination-out";
      this.ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      this.ctx.globalCompositeOperation = "source-over";
      this.ctx.strokeStyle = this.color;
    }

    this.ctx.globalAlpha = this.opacity;
    this.ctx.lineWidth   = this.brushSize;
    this.ctx.lineTo(x, y);
    this.ctx.stroke();

    if (this.material.map) this.material.map.needsUpdate = true;
  }

  endDraw() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.ctx.closePath();
    this.ctx.globalAlpha              = 1;
    this.ctx.globalCompositeOperation = "source-over";
  }

  /* ── Bucket fill ────────────────────────────────────────────────────── */

  bucketFill(startX, startY) {
    const ctx = this.ctx;
    const w   = this.canvas.width;
    const h   = this.canvas.height;

    const imageData   = ctx.getImageData(0, 0, w, h);
    const data        = imageData.data;
    const idx         = (x, y) => (y * w + x) * 4;
    const si          = idx(startX, startY);
    const targetColor = [data[si], data[si + 1], data[si + 2], data[si + 3]];
    const fillColor   = this._hexToRgba(this.color, this.opacity);

    if (
      targetColor[0] === fillColor[0] && targetColor[1] === fillColor[1] &&
      targetColor[2] === fillColor[2] && targetColor[3] === fillColor[3]
    ) return;

    const stack = [[startX, startY]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = idx(x, y);
      if (
        data[i]   !== targetColor[0] || data[i+1] !== targetColor[1] ||
        data[i+2] !== targetColor[2] || data[i+3] !== targetColor[3]
      ) continue;
      data[i]   = fillColor[0];
      data[i+1] = fillColor[1];
      data[i+2] = fillColor[2];
      data[i+3] = fillColor[3];
      stack.push([x+1,y], [x-1,y], [x,y+1], [x,y-1]);
    }
    ctx.putImageData(imageData, 0, 0);
  }

  /* ── Material ───────────────────────────────────────────────────────── */

  applyToMaterial() {
    this.material.map = this.texture;
    this.material.needsUpdate = true;
  }

  /* ── Private helpers ────────────────────────────────────────────────── */

  _hexToRgba(hex, opacity = 1) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b, Math.floor(opacity * 255)];
  }

  // kept for backward compat
  hexToRgba(hex, opacity = 1) { return this._hexToRgba(hex, opacity); }
}


// ============================================================================
// MESH TEXTURE DATA MANAGEMENT
// Manages per-mesh texture canvases stored in main.js's meshTextureData object.
// All functions receive meshTextureData by reference via the import.
// ============================================================================

// Singleton store — main.js imports and mutates this directly
export const meshTextureData = {};

const MAX_HISTORY = 20;

export function ensureMeshTextureData(meshId, resolution = 1024) {
  if (!meshTextureData[meshId]) {
    meshTextureData[meshId] = {
      resolution,
      selectedTexture: null,
      textures: {}
    };
  }
  return meshTextureData[meshId];
}

export function createTextureForMesh(meshId, textureName, displayName, isCustom = true) {
  const meshData = meshTextureData[meshId];
  if (!meshData) return null;

  const canvas = document.createElement("canvas");
  canvas.width  = meshData.resolution;
  canvas.height = meshData.resolution;

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY      = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  meshData.textures[textureName] = {
    name: displayName,
    canvas,
    texture,
    isCustom,
    history:      [],
    historyIndex: -1,
    roughness:    0.5,
    metalness:    0.0
  };

  return meshData.textures[textureName];
}

export function selectTexture(meshId, textureName, materialTargets, onSelected) {
  const meshData = meshTextureData[meshId];
  if (!meshData || !meshData.textures[textureName]) return;

  meshData.selectedTexture = textureName;
  applySelectedTexture(meshId, materialTargets);
  onSelected?.(textureName);
}

export function applySelectedTexture(meshId, materialTargets) {
  const meshData = meshTextureData[meshId];
  if (!meshData) return;

  const texData = meshData.textures[meshData.selectedTexture];
  if (!texData) return;

  const target = materialTargets[meshId];
  if (!target?.meshes?.length) return;

  target.meshes.forEach(mesh => {
    if (mesh.material) {
      mesh.material.map = texData.texture;
      mesh.material.needsUpdate = true;
    }
  });
}

export function resetTexture(meshId, textureName) {
  const texData = meshTextureData[meshId]?.textures[textureName];
  if (!texData) return;

  const ctx = texData.canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, texData.canvas.width, texData.canvas.height);

  texData.history      = [];
  texData.historyIndex = -1;
  texData.texture.needsUpdate = true;
}

export async function changeTextureResolution(meshId, newResolution, materialTargets) {
  const meshData = meshTextureData[meshId];
  if (!meshData) return;

  meshData.resolution = newResolution;

  for (const [, texData] of Object.entries(meshData.textures)) {
    const newCanvas = document.createElement("canvas");
    newCanvas.width  = newResolution;
    newCanvas.height = newResolution;
    const ctx = newCanvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, newResolution, newResolution);
    ctx.drawImage(texData.canvas, 0, 0, newResolution, newResolution);
    texData.canvas = newCanvas;

    const newTex = new THREE.CanvasTexture(newCanvas);
    newTex.flipY      = false;
    newTex.colorSpace = THREE.SRGBColorSpace;
    newTex.needsUpdate = true;
    texData.texture = newTex;
  }

  applySelectedTexture(meshId, materialTargets);
}

export function updateMaterialProperty(meshId, textureName, property, value, materialTargets) {
  const texData = meshTextureData[meshId]?.textures[textureName];
  if (!texData) return;
  texData[property] = value;

  const target = materialTargets[meshId];
  if (!target?.meshes) return;
  target.meshes.forEach(mesh => {
    if (mesh.material) {
      mesh.material[property] = value;
      mesh.material.needsUpdate = true;
    }
  });
}


// ============================================================================
// UNDO / REDO
// ============================================================================

export function saveToHistory(meshId, textureName) {
  const texData = meshTextureData[meshId]?.textures[textureName];
  if (!texData) return;

  const snapshot = texData.canvas.toDataURL("image/png");

  if (texData.historyIndex < texData.history.length - 1) {
    texData.history = texData.history.slice(0, texData.historyIndex + 1);
  }

  texData.history.push(snapshot);
  texData.historyIndex = texData.history.length - 1;

  if (texData.history.length > MAX_HISTORY) {
    texData.history.shift();
    texData.historyIndex = texData.history.length - 1;
  }
}

export function undo(meshId, textureName, onDone) {
  const texData = meshTextureData[meshId]?.textures[textureName];
  if (!texData || texData.historyIndex < 0) {
    _toast("Nothing to undo");
    return;
  }

  texData.historyIndex--;

  if (texData.historyIndex < 0) {
    const ctx = texData.canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, texData.canvas.width, texData.canvas.height);
    texData.texture.needsUpdate = true;
    onDone?.();
    return;
  }

  _restoreSnapshot(texData, texData.history[texData.historyIndex], onDone);
}

export function redo(meshId, textureName, onDone) {
  const texData = meshTextureData[meshId]?.textures[textureName];
  if (!texData || texData.historyIndex >= texData.history.length - 1) {
    _toast("Nothing to redo");
    return;
  }

  texData.historyIndex++;
  _restoreSnapshot(texData, texData.history[texData.historyIndex], onDone);
}

function _restoreSnapshot(texData, snapshot, onDone) {
  const img = new Image();
  img.onload = () => {
    const ctx = texData.canvas.getContext("2d");
    ctx.clearRect(0, 0, texData.canvas.width, texData.canvas.height);
    ctx.drawImage(img, 0, 0);
    texData.texture.needsUpdate = true;
    onDone?.();
  };
  img.src = snapshot;
}

function _toast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.remove("hidden");
  t.classList.add("show");
  clearTimeout(t._tid);
  t._tid = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.classList.add("hidden"), 300);
  }, 1500);
}