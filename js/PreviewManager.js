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

    // 🔒 Attach canvas ONCE
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

// ============================================================================
// HELPER: Check if element or any parent is hidden
// ============================================================================
function isElementVisible(element) {
  if (!element) return false;
  
  // Walk up the DOM tree checking visibility
  let current = element;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    
    // Check if element is hidden
    if (style.display === 'none' || 
        style.visibility === 'hidden' || 
        style.opacity === '0') {
      return false;
    }
    
    // Check if element has .panel class and no .active class
    if (current.classList && current.classList.contains('panel')) {
      if (!current.classList.contains('active')) {
        return false;
      }
    }
    
    current = current.parentElement;
  }
  
  return true;
}

function animate() {
  requestAnimationFrame(animate);

  if (!renderer || previews.length === 0) return;

  const canvas = renderer.domElement;
  const canvasRect = canvas.getBoundingClientRect();

  renderer.setClearColor(0x000000, 0);
  renderer.clear();

  previews.forEach(p => {
    // ✅ FIX 1: Check if container or parent panel is visible
    if (!isElementVisible(p.container)) {
      return; // Skip rendering if hidden
    }
    
    const rect = p.container.getBoundingClientRect();

    // ✅ FIX 2: Skip if offscreen OR if rect is zero (hidden)
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

    const width = rect.width;
    const height = rect.height;

    if (width === 0 || height === 0) return;

    const left = rect.left - canvasRect.left;
    const bottom = canvasRect.bottom - rect.bottom;

    renderer.setViewport(left, bottom, width, height);
    renderer.setScissor(left, bottom, width, height);

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