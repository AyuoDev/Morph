// js/TexturePainter.js
import * as THREE from "three";

export class TexturePainter {
constructor({ canvas, mesh, material, texture }) {
  this.canvas = canvas;
  this.ctx = canvas.getContext("2d");

  this.mesh = mesh;

this.material = material;

  // 🔑 DO NOT CREATE TEXTURE HERE ANYMORE
  // Texture is now OWNED by main.js and passed in
  this.texture = texture;

  this.tool = "draw"; // draw | erase | move
  this.color = "#ffffff";
  this.brushSize = 10;
  this.opacity = 1.0;

  this.isDrawing = false;

  this._bindDefaults();
}


  /* ================= SETUP ================= */

  _bindDefaults() {
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
  }

  /* ================= TEXTURE LOADING ================= */

  loadFromTexture(texture) {
    const image = texture.image;
    if (!image) return;

    this.canvas.width = image.width;
    this.canvas.height = image.height;

    this.ctx.clearRect(0, 0, image.width, image.height);
    this.ctx.drawImage(image, 0, 0);

    this.applyToMaterial();
  }

  createBlank(width = 1024, height = 1024) {
    this.canvas.width = width;
    this.canvas.height = height;

    this.ctx.clearRect(0, 0, width, height);

    this.applyToMaterial();
  }

  /* ================= TOOLS ================= */

  setTool(tool) {
    this.tool = tool;
  }

  setColor(color) {
    this.color = color;
  }

  setBrushSize(size) {
    this.brushSize = size;
  }

  setOpacity(value) {
    this.opacity = value;
  }

  /* ================= DRAWING ================= */

startDraw(x, y) {
  if (this.tool === "move") return;

  if (this.tool === "bucket") {
    this.bucketFill(Math.floor(x), Math.floor(y));
    if (this.material.map) {
      this.material.map.needsUpdate = true;
    }
    return;
  }

  this.isDrawing = true;
  this.ctx.beginPath();
  this.ctx.moveTo(x, y);
}
bucketFill(startX, startY) {
  const ctx = this.ctx;
  const w = this.canvas.width;
  const h = this.canvas.height;

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  const stack = [[startX, startY]];

  const idx = (x, y) => (y * w + x) * 4;

  const startIndex = idx(startX, startY);
  const targetColor = [
    data[startIndex],
    data[startIndex + 1],
    data[startIndex + 2],
    data[startIndex + 3]
  ];

  const fillColor = this.hexToRgba(this.color, this.opacity);

  // If same color → do nothing
  if (
    targetColor[0] === fillColor[0] &&
    targetColor[1] === fillColor[1] &&
    targetColor[2] === fillColor[2] &&
    targetColor[3] === fillColor[3]
  ) {
    return;
  }

  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;

    const i = idx(x, y);

    if (
      data[i] !== targetColor[0] ||
      data[i + 1] !== targetColor[1] ||
      data[i + 2] !== targetColor[2] ||
      data[i + 3] !== targetColor[3]
    ) {
      continue;
    }

    data[i] = fillColor[0];
    data[i + 1] = fillColor[1];
    data[i + 2] = fillColor[2];
    data[i + 3] = fillColor[3];

    stack.push([x + 1, y]);
    stack.push([x - 1, y]);
    stack.push([x, y + 1]);
    stack.push([x, y - 1]);
  }

  ctx.putImageData(imageData, 0, 0);
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
    this.ctx.lineWidth = this.brushSize;

    this.ctx.lineTo(x, y);
    this.ctx.stroke();

    if (this.material.map) {
  this.material.map.needsUpdate = true;
}

  }

  endDraw() {
    if (!this.isDrawing) return;

    this.isDrawing = false;
    this.ctx.closePath();
    this.ctx.globalAlpha = 1;
    this.ctx.globalCompositeOperation = "source-over";
  }

  /* ================= APPLY ================= */

  applyToMaterial() {
    this.material.map = this.texture;
    this.material.needsUpdate = true;
  }
  hexToRgba(hex, opacity = 1) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b, Math.floor(opacity * 255)];
}

}