import * as THREE from "three";

let renderer = null;
let previews = [];
let isRunning = false;

let resizeBound = false;

export function getPreviewRenderer() {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true
    });

    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.setScissorTest(true);


renderer.domElement.style.position = "fixed";
renderer.domElement.style.top = "0";
renderer.domElement.style.left = "0";
renderer.domElement.style.width = "100vw";
renderer.domElement.style.height = "100vh";
renderer.domElement.style.pointerEvents = "none";
renderer.domElement.style.zIndex = "999";

    document.body.appendChild(renderer.domElement);
  }

  if (!resizeBound) {
    resizeBound = true;
    window.addEventListener("resize", () => {
      renderer.setSize(window.innerWidth, window.innerHeight, false);
    });
  }

  return renderer;
}


export function registerPreview(preview) {
  previews.push(preview);

  if (!isRunning) {
    isRunning = true;
    animate();
  }
}

export function unregisterPreview(preview) {
  previews = previews.filter(p => p !== preview);
}




function isElementVisible(element) {
  if (!element) return false;


  let current = element;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);


    if (style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0') {
      return false;
    }


    if (current.classList && current.classList.contains('panel')) {
      if (!current.classList.contains('active')) {
        return false;
      }
    }

    current = current.parentElement;
  }

  return true;
}

function getVisiblePreviewRect(element, rect, canvasRect) {
  const visible = {
    left: Math.max(rect.left, canvasRect.left),
    top: Math.max(rect.top, canvasRect.top),
    right: Math.min(rect.right, canvasRect.right),
    bottom: Math.min(rect.bottom, canvasRect.bottom)
  };

  let parent = element.parentElement;
  while (parent && parent !== document.body) {
    const style = window.getComputedStyle(parent);
    const clipsX = /hidden|clip|auto|scroll/.test(style.overflowX);
    const clipsY = /hidden|clip|auto|scroll/.test(style.overflowY);
    if (clipsX || clipsY) {
      const bounds = parent.getBoundingClientRect();
      if (clipsX) {
        visible.left = Math.max(visible.left, bounds.left);
        visible.right = Math.min(visible.right, bounds.right);
      }
      if (clipsY) {
        visible.top = Math.max(visible.top, bounds.top);
        visible.bottom = Math.min(visible.bottom, bounds.bottom);
      }
    }
    parent = parent.parentElement;
  }

  return visible;
}

function animate() {
  requestAnimationFrame(animate);

  if (!renderer || previews.length === 0) return;

  const canvas = renderer.domElement;
  const canvasRect = canvas.getBoundingClientRect();

  renderer.setClearColor(0x000000, 0);
  renderer.setScissor(0, 0, canvasRect.width, canvasRect.height);
  renderer.clear();

  previews.forEach(p => {

    if (!isElementVisible(p.container)) {
      return;
    }

    const rect = p.container.getBoundingClientRect();


    if (
      rect.width === 0 ||
      rect.height === 0 ||
      rect.bottom < canvasRect.top ||
      rect.top > canvasRect.bottom ||
      rect.right < canvasRect.left ||
      rect.left > canvasRect.right
    ) {
      return;
    }

    const clipRect = getVisiblePreviewRect(p.container, rect, canvasRect);
    const width = rect.width;
    const height = rect.height;

    if (width === 0 || height === 0 || clipRect.right <= clipRect.left || clipRect.bottom <= clipRect.top) return;

    const left = rect.left - canvasRect.left;
    const bottom = canvasRect.bottom - rect.bottom;
    const clipLeft = clipRect.left - canvasRect.left;
    const clipBottom = canvasRect.bottom - clipRect.bottom;

    renderer.setViewport(left, bottom, width, height);
    renderer.setScissor(
      clipLeft,
      clipBottom,
      clipRect.right - clipRect.left,
      clipRect.bottom - clipRect.top
    );

    renderer.clearDepth();

    if (p.mixer) {
      p.mixer.update(p.clock.getDelta());
    }

    if (p.root && p.autoRotate) {
      p.root.rotation.y += 0.005;
    }

    renderer.render(p.scene, p.camera);
  });
}
