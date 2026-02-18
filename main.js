import * as THREE from "three";
import { GLTFLoader } from "https://esm.sh/three@0.158.0/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "https://esm.sh/three@0.158.0/examples/jsm/controls/OrbitControls.js";
import { GLTFExporter } from "https://esm.sh/three@0.158.0/examples/jsm/exporters/GLTFExporter.js";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { initPlansOverlayControls } from "./js/Controls.js";
import { createPreview } from "./js/PreviewRenderer.js";
import {
  TexturePainter,
  meshTextureData,
  ensureMeshTextureData,
  createTextureForMesh,
  selectTexture,
  applySelectedTexture,
  resetTexture,
  changeTextureResolution,
  updateMaterialProperty,
  saveToHistory,
  undo,
  redo
} from "./js/TexturePainter.js";

/* ---------------- WORKER & DATA CONFIG ---------------- */
const WORKER_URL = "https://morphara.maroukayuob.workers.dev";

// These are populated from Supabase on boot
let BASE_MESHES = [];
let CLOTHES     = [];
let ANIMATIONS  = [];

// Texture domains stay client-side (UI config, not assets)
// compatible_mesh on a texture row = the domain key ("skin", "fabric", etc.)
let TEXTURE_PRESETS = {};
/* ---------------- STARTUP CLEANUP ---------------- */
// Blob URLs are never cached — always fetched fresh from Worker

/* ---------------- GLOBAL STATE ---------------- */

let scene, camera, renderer, controls;
let loader;
let mixer = null;
let currentModel = null;
let currentBaseMesh = null;
let baseSkinnedMeshes = [];
let materialTargets = {};
let activeMaterialTarget = null;
let activeAction = null;
let isPainterMode = false;
let originalViewportParent = null;
let texturePainter = null;
let painterCanvas = null;
let painterTargetMesh = null;
let isPainting = false;
let uvOverlayImage = null;
let showUVOverlay = true;
let uvOpacity = 0.25;

// Texture Painter V2 state (meshTextureData imported from TexturePainter.js)
let currentPainterMesh = null;
let currentTextureName = null;
let maxAllowedResolution = 1024;
let painterControls = null;

// Brush cursor tracking
let canvasMouseX = null;
let canvasMouseY = null;

const paintedTextures = {};  // Keep for backward compatibility
const clock = new THREE.Clock();
const blendShapeMap = {};
const morphMeshes = [];
const morphValues = {};

// Track preview instances for cleanup
const activePreviews = new Map(); // Map<containerId, preview>
let equippedClothes = {
  shirts: null,
  pants: null,
  gloves: null,
  shoes: null,
  hair: null,
  jacket: null,
  facialHair: null,
  headwear: null,
  glasses: null,
  accessories: null
};
const randomizerConfig = {
  baseMesh: true,
  clothes: true,
  textures: true,
  colors: true,
  blendShapes: true,
  animation: true
};
  // Intitate Accounts
const SUPABASE_URL = "https://yjrqcmzkmfawwsppmnkl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_fIkpyaJmmkNhcB1HOeRrKw_xZ0c0miD";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let loadedClothingMeshes = {};

/* ---------------- Auth State ------------*/

async function checkSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    updateUserMenu(session);
    showToast("Welcome back 🎉");
  }
}

checkSession();

// Central function — handles BOTH logged-in and logged-out UI updates
function updateUserMenu(session) {
  const menu = document.getElementById("user-menu");
  const userBtn = document.getElementById("user-btn");

  if (session) {
    const user = session.user;
    const initial = (user.email?.[0] ?? "U").toUpperCase();

    // Update the 👤 button to show user initial
    userBtn.textContent = initial;
    userBtn.title = user.email;

    // Rebuild menu with user info + settings + logout
    menu.innerHTML = `
      <span class="user-email">${user.email}</span>
      <button class="dropdown-item" id="settings-btn">⚙️ Settings</button>
      <button class="dropdown-item" id="logout-btn">Log Out</button>
    `;

    document.getElementById("settings-btn").addEventListener("click", () => {
      document.getElementById("user-menu").classList.add("hidden");
      const so = document.getElementById("settings-overlay");
      so.style.display = "flex";
      // Populate email
      const emailEl = document.getElementById("settings-email");
      if (emailEl) emailEl.textContent = user.email;
      // Populate plan
      fetch(WORKER_URL + "/check-plan", {
        headers: { "Authorization": "Bearer " + session.access_token }
      }).then(r => r.json()).then(data => {
        const names = { free: "Free", premium: "Premium", studio: "Studio" };
        const planEl = document.getElementById("settings-plan");
        if (planEl) planEl.textContent = names[data.plan] || "Free";
      }).catch(() => {});
    });

    document.getElementById("logout-btn").addEventListener("click", async () => {
      await supabase.auth.signOut();
      // onAuthStateChange will fire and call updateUserMenu(null)
    });

    // Fetch or create credits
    ensureUserCredits(user);

  } else {
    // Logged out state
    userBtn.textContent = "👤";
    userBtn.title = "";

    menu.innerHTML = `
      <button class="dropdown-item" data-auth-open="signup">Sign Up</button>
      <button class="dropdown-item" data-auth-open="login">Log In</button>
    `;

    // Re-bind auth open buttons
    menu.querySelectorAll("[data-auth-open]").forEach(btn => {
      btn.addEventListener("click", () => {
        authMode = btn.dataset.authOpen;
        updateAuthUI();
        document.getElementById("auth-overlay").classList.remove("hidden");
        menu.classList.add("hidden");
      });
    });

    document.getElementById("credits-count").textContent = "0";
  }
}

// Fetches credits + subscription plan
async function ensureUserCredits(user) {
  // Fetch credits
  const { data, error } = await supabase
    .from("users")
    .select("credits")
    .eq("id", user.id)
    .single();

  if (error) {
    console.error("Error fetching credits:", error);
  } else {
    document.getElementById("credits-count").textContent = data.credits;
  }

  // Fetch active subscription
  await fetchAndDisplayPlan(user.id);
}

// Expose globally so Controls.js can call it after Stripe return
window.fetchAndDisplayPlan = fetchAndDisplayPlan;

// Fetches the user current plan and updates UI
async function fetchAndDisplayPlan(userId) {
  let planName  = "free";
  let planLabel = "FREE";

  try {
    // Use Worker /check-plan — reliable price ID matching via secrets
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      const res  = await fetch(`${WORKER_URL}/check-plan`, {
        headers: { "Authorization": `Bearer ${session.access_token}` }
      });
      const data = await res.json();
      planName  = data.plan || "free";
      planLabel = planName.toUpperCase();
    }
  } catch(e) {
    console.warn("fetchAndDisplayPlan failed:", e.message);
  }

  // Store globally so Controls.js can read it
  window._currentPlan = planName;

  // Update plan badge next to user button
  let badge = document.getElementById("plan-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.id = "plan-badge";
    document.getElementById("user-btn")?.after(badge);
  }

  const badgeColors = { free: "#444", premium: "#6c63ff", studio: "#f59e0b" };
  badge.textContent      = planLabel;
  badge.style.background = badgeColors[planName] || "#444";
  badge.style.color      = "#fff";

  // Reset all plan cards first
  document.querySelectorAll(".plan-card").forEach(card => {
    card.classList.remove("active-plan");
    const btn = card.querySelector(".plan-btn");
    if (btn) {
      btn.textContent = "Subscribe";
      btn.disabled    = false;
      btn.classList.remove("disabled");
    }
  });

  // Free card always says "Current Plan" only if actually on free
  const freeBtn = document.querySelector(".plan-card.free .plan-btn");
  if (freeBtn) {
    freeBtn.textContent = planName === "free" ? "Current Plan" : "Free";
    freeBtn.disabled    = true; // free is always disabled (cant subscribe to free)
  }

  // Mark the actual active paid plan card
  if (planName !== "free") {
    const activeCard = document.querySelector(`.plan-card.${planName}`);
    if (activeCard) {
      activeCard.classList.add("active-plan");
      const btn = activeCard.querySelector(".plan-btn");
      if (btn) {
        btn.textContent = "Current Plan";
        btn.disabled    = true;
        btn.classList.add("disabled");
      }
    }
  }
}

/* ---------------- ASSET DATA LAYER ---------------- */

// Fetches asset from Worker and returns a blob:// URL.
// Always fetches as blob first — validates content-type BEFORE handing
// to GLTFLoader. This is the only way to prevent the "Unexpected token <"
// crash when Cloudflare or the Worker returns an HTML error page,
// because GLTFLoader's onError is never called for 200-OK HTML responses.
async function getAssetUrl(bucket, filename, mode = "public") {
  let res;

  if (mode === "private") {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("Not authenticated");
    res = await fetch(
      `${WORKER_URL}/asset?bucket=${bucket}&file=${encodeURIComponent(filename)}`,
      { headers: { "Authorization": `Bearer ${session.access_token}` } }
    );
  } else {
    res = await fetch(
      `${WORKER_URL}/public-asset?bucket=${bucket}&file=${encodeURIComponent(filename)}`
    );
  }

  if (!res.ok) throw new Error(`Worker ${res.status} for ${filename}`);

  // If Cloudflare returned an HTML error page (status 200 but wrong content)
  // reject it NOW before GLTFLoader tries to parse it as JSON and crashes
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/html")) {
    throw new Error(`Got HTML instead of GLB for ${filename} — Cloudflare error page`);
  }

  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// Fetches all assets from Supabase and populates BASE_MESHES, CLOTHES,
// ANIMATIONS, TEXTURE_PRESETS — then builds the UI
async function loadAllAssets() {
  const panel = document.getElementById("basemesh-panel");
  panel.innerHTML = "<p style='color:#888;font-size:13px;padding:16px'>Loading assets...</p>";

  try {
    const { data: assets, error } = await supabase
      .from("assets")
      .select("id, name, type, r2_key, price_credits, compatible_mesh, uv_map")
      .order("name");

    if (error) throw error;

    // ── Base Meshes ──
    BASE_MESHES = assets
      .filter(a => a.type === "basemesh")
      .map(a => ({
        id:            a.id,
        name:          a.name,
        r2Key:         a.r2_key,
        priceCredits:  a.price_credits ?? 1,
        uv_map:        a.uv_map,  // UV map filename for texture painter
        // path is resolved async via getAssetUrl — stored per-use
      }));

    // ── Clothing (all non-basemesh, non-texture, non-animation, non-uvmap) ──
    const clothingTypes = ["shirts","pants","shoes","gloves","hair",
                           "accessories","headwear","glasses","facialHair","jacket"];
    CLOTHES = assets
      .filter(a => clothingTypes.includes(a.type))
      .map(a => ({
        id:             a.id,
        name:           a.name,
        category:       a.type,       // type = bucket = category
        baseMesh:       a.compatible_mesh,
        r2Key:          a.r2_key,
        materialDomain: "fabric",     // default; override per-item if needed
        priceCredits:   a.price_credits ?? 0,
        uv_map:         a.uv_map       // UV map filename for texture painter
      }));

    // ── Animations ──
    ANIMATIONS = assets
      .filter(a => a.type === "animation")
      .map(a => ({
        id:       a.id,
        name:     a.name,
        baseMesh: a.compatible_mesh,
        r2Key:    a.r2_key,
        loop:     true
      }));

    // ── Textures → grouped by domain (compatible_mesh = domain name) ──
    const textureAssets = assets.filter(a => a.type === "textures");
    TEXTURE_PRESETS = {};
    for (const t of textureAssets) {
      const domain = t.compatible_mesh || "fabric";
      if (!TEXTURE_PRESETS[domain]) TEXTURE_PRESETS[domain] = [];
      TEXTURE_PRESETS[domain].push({
        id:     t.id,
        label:  t.name,
        r2Key:  t.r2_key,
        map:    null // loaded on demand via getAssetUrl
      });
    }

    // Build the UI now that data is ready
    buildBaseMeshUI();

  } catch (err) {
    console.error("Failed to load assets:", err);
    panel.innerHTML = "<p style='color:#e55;font-size:13px;padding:16px'>Failed to load assets. Please refresh.</p>";
  }
}

/* ---------------- UI MODES ---------------- */

const topButtons = document.querySelectorAll(".top-btn[data-mode]");
const allPanels = [
  "basemesh-panel",
  "blendshape-panel",
  "clothes-panel",
  "clothes-items-panel",
  "material-panel",
  "animations-panel",
  "randomizer-panel"
];

const MODE_PANELS = {
  base: ["basemesh-panel"],
  customize: ["blendshape-panel"],
  clothes: ["clothes-panel", "clothes-items-panel"],
  materials: ["material-panel"],
  animations: ["animations-panel"],
  randomizer: ["randomizer-panel"]
};

topButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    setUIMode(btn.dataset.mode);
  });
});

function setUIMode(mode) {
  // Button active state
  topButtons.forEach(b => b.classList.remove("active"));
  document
    .querySelector(`.top-btn[data-mode="${mode}"]`)
    ?.classList.add("active");

  // Hide all panels
  allPanels.forEach(id => {
    const panel = document.getElementById(id);
    if (panel) panel.classList.remove("active");
  });

  // Show panels for mode
  MODE_PANELS[mode]?.forEach(id => {
    const panel = document.getElementById(id);
    if (panel) panel.classList.add("active");
  });
    if (mode === "materials") {
      rebuildMaterialTargets();
  rebuildMaterialTargetsUI();
  syncMaterialUI();
  buildTextureGrid();
  }
  if (mode === "animations") {
  buildAnimationUI();
}
if(mode === "customize"){
    buildCategorizedBlendShapesUI();
}
if(mode === "clothes")
{
  updateCategoryCounts(currentBaseMesh.id);
}
}

/* ---------------- BOOT ---------------- */

init();
setUIMode("base");
initPlansOverlayControls();
loadAllAssets(); // fetches from Supabase then builds UI

/* ---------------- INIT ---------------- */

function init() {

  //
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1e1e1e);

  camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.01,
    1000
  );
  camera.position.set(0, 1.5, 3);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  document.getElementById("viewport").appendChild(renderer.domElement);

  setupLights();
  setupControls();
  addGroundGrid();

  loader = new GLTFLoader();

  window.addEventListener("resize", onResize);
  onResize();
  animate();
}
/* ---------------- BASE MESH UI ---------------- */
function buildBaseMeshUI() {
  const panel = document.getElementById("basemesh-panel");
  panel.innerHTML = "";

  if (!BASE_MESHES.length) {
    panel.innerHTML = "<p style='color:#888;font-size:13px;padding:16px'>No base meshes found.</p>";
    return;
  }

  BASE_MESHES.forEach(mesh => {
    const card = document.createElement("div");
    card.className = "base-mesh-card";
    card.dataset.id = mesh.id;

    const preview = document.createElement("div");
    preview.className = "preview-canvas";
    preview.innerHTML = "<div style='color:#555;font-size:11px;text-align:center;padding-top:30px'>Loading...</div>";

    const name = document.createElement("div");
    name.className = "base-mesh-name";
    name.textContent = mesh.name;

    // Add credit badge
    const creditBadge = document.createElement("div");
    creditBadge.className = "credit-badge";
    creditBadge.textContent = mesh.priceCredits || 1;
    
    card.append(preview, name, creditBadge);
    panel.appendChild(card);

    // Fetch blob URL for preview thumbnail only — never cache blob URLs
    getAssetUrl("basemesh", mesh.r2Key).then(url => {
      preview.innerHTML = "";
      const previewInstance = createPreview({ container: preview, gltfPath: url });
      activePreviews.set(preview, previewInstance);
    }).catch(() => {
      preview.innerHTML = "<div style='color:#555;font-size:11px;text-align:center'>Preview unavailable</div>";
    });

    card.onclick = () => {
      document.querySelectorAll(".base-mesh-card")
        .forEach(c => c.classList.remove("active"));
      card.classList.add("active");
      loadBaseMesh(mesh);
      updateResetButton();
    };
  });
}

/* ---------------- LOAD BASE MESH ---------------- */
async function loadBaseMesh(meshData, onLoaded = null) {
  if (!meshData) return;

  resetClothingUI();
  currentBaseMesh = meshData;

  // Highlight active card
  document.querySelectorAll(".base-mesh-card").forEach(c => {
    c.classList.toggle("active", c.dataset.id === meshData.id);
  });

  // Update category counts for this base mesh
  updateCategoryCounts(meshData.r2Key);

  try {
    const url = await getAssetUrl("basemesh", meshData.r2Key);
    loader.load(
      url,
      gltf => {
        onModelLoaded(gltf);
        if (onLoaded) onLoaded(); // resolve promise for randomizer await
      },
      undefined,
      err => {
        console.error("Failed to load GLB:", err?.message || err);
        showToast("Failed to load mesh — please try again");
        currentBaseMesh = null;
        if (onLoaded) onLoaded();
      }
    );
  } catch (err) {
    console.error("Failed to load base mesh:", err);
    showToast("Failed to load mesh — please try again");
    if (onLoaded) onLoaded();
  }
}
function onModelLoaded(gltf) {
  cleanupPreviousModel();

  currentModel = gltf.scene;
  scene.add(currentModel);

  normalizeModel(currentModel);
  collectMeshes(currentModel);
  setupAnimation(gltf);
  collectBlendShapes(currentModel);
  frameCameraToObject(currentModel);
  rebuildMaterialTargets();
}
/* ---------------- MODEL HELPERS ---------------- */
function cleanupPreviousModel() {
  if (!currentModel) return;

  scene.remove(currentModel);

  if (mixer) {
    mixer.stopAllAction();
    mixer = null;
  }

  morphMeshes.length = 0;
  baseSkinnedMeshes.length = 0;

  Object.keys(morphValues).forEach(k => delete morphValues[k]);

  equippedClothes = {
    shirts: null,
    pants: null,
    gloves: null,
    shoes: null,
    hair: null,
    jacket: null,
    facialHair: null,
    headwear: null,
    glasses: null,
    accessories: null
  };
  activeAction = null;

  loadedClothingMeshes = {};
}
function normalizeModel(root) {
  root.rotation.y = Math.PI;
  root.scale.setScalar(1);
}
function collectMeshes(root) {
  root.traverse(obj => {
    if (obj.isSkinnedMesh) {
      obj.frustumCulled = false;
      baseSkinnedMeshes.push(obj);

      if (obj.morphTargetDictionary) {
        morphMeshes.push(obj);
      }
    }
  });
}
function setupAnimation(gltf) {
  if (!gltf.animations.length) return;

  mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(gltf.animations[0]).play();
}
/* ---------------- BLEND SHAPES ---------------- */
function collectBlendShapes(root) {
  Object.keys(blendShapeMap).forEach(k => delete blendShapeMap[k]);

  root.traverse(obj => {
    if (!obj.isSkinnedMesh || !obj.morphTargetDictionary) return;

    for (const [name, index] of Object.entries(obj.morphTargetDictionary)) {
      if (!blendShapeMap[name]) blendShapeMap[name] = [];
      blendShapeMap[name].push({ mesh: obj, index });
    }
  });
}
function applyMorphsPerFrame() {
  for (const name in morphValues) {
    blendShapeMap[name]?.forEach(({ mesh, index }) => {
      mesh.morphTargetInfluences[index] = morphValues[name];
    });
  }
}
function collectBlendShapesFromObject(root) {
  root.traverse(obj => {
    if (!obj.isSkinnedMesh || !obj.morphTargetDictionary) return;

    for (const [name, index] of Object.entries(obj.morphTargetDictionary)) {
      if (!blendShapeMap[name]) blendShapeMap[name] = [];
      blendShapeMap[name].push({ mesh: obj, index });
    }
  });
}

/* ---------------- UI: BLEND SHAPES ---------------- */
// ============================================================================
// BLEND SHAPE CATEGORIZATION SYSTEM
// Add these functions to main.js
// ============================================================================

/**
 * Categorize blend shapes by prefix (before underscore)
 * Example: "Eyes_Width" → category "Eyes"
 */
function categorizeBlendShapes(blendShapeNames) {
  const categories = {};
  const specialCategories = ['Gender']; // Always first, highlighted
  
  blendShapeNames.forEach(name => {
    let category = 'Other';
    
    // Check if it's a special category (exact match)
    if (specialCategories.includes(name)) {
      category = name;
    } else if (name.includes('_')) {
      // Extract prefix before underscore
      category = name.split('_')[0];
    }
    
    if (!categories[category]) {
      categories[category] = [];
    }
    
    categories[category].push(name);
  });
  
  return categories;
}

function getBlendShapeCategoryIcon(categoryName) {
  const baseUrl = 'icons/blend_shape/';
  const iconName = categoryName.toLowerCase() + '.png';
  return baseUrl + iconName;
}

function buildCategorizedBlendShapesUI() {
  const panel = document.getElementById('blendshape-panel');
  if (!panel) return;
  
  panel.innerHTML = '';
  
  // Get all blend shape names from blendShapeMap
  const allNames = [];
  for (const [name] of Object.entries(blendShapeMap)) {
    allNames.push(name);
    // Initialize morphValues if not set
    if (morphValues[name] === undefined) {
      morphValues[name] = 0;
    }
  }
  
  if (allNames.length === 0) {
    panel.innerHTML = '<p style="color: #888; padding: 20px; text-align: center;">No blend shapes available</p>';
    return;
  }
  
  // Categorize
  const categorized = categorizeBlendShapes(allNames);
  
  // Render Gender first (if exists)
  if (categorized['Gender']) {
    renderBlendShapeCategory(panel, 'Gender', categorized['Gender'], true);
    delete categorized['Gender'];
  }
  
  // Then render other categories alphabetically
  const sortedCategories = Object.keys(categorized).sort();
  sortedCategories.forEach(categoryName => {
    renderBlendShapeCategory(panel, categoryName, categorized[categoryName], false);
  });
  
  console.log(`✅ Built categorized blend shapes: ${sortedCategories.length} categories`);
}

/**
 * Render a single blend shape category panel
 */
function renderBlendShapeCategory(panel, categoryName, blendShapeNames, isSpecial = false) {
  // Create category container
  const categoryDiv = document.createElement('div');
  categoryDiv.className = `blend-category${isSpecial ? ' special' : ''} collapsed`;
  
  // Create header
  const header = document.createElement('div');
  header.className = 'blend-category-header';
  
  const iconUrl = getBlendShapeCategoryIcon(categoryName);
  
  header.innerHTML = `
    <img src="${iconUrl}" class="blend-category-icon" onerror="this.style.display='none'" alt="${categoryName}">
    <span class="blend-category-name">${categoryName}</span>
    <span class="blend-category-chevron">▼</span>
  `;
  
  // Create content container
  const content = document.createElement('div');
  content.className = 'blend-category-content';
  
  // Add blend shape sliders to content
  blendShapeNames.forEach(shapeName => {
    const sliderItem = createBlendShapeSliderItem(shapeName);
    content.appendChild(sliderItem);
  });
  
  // Toggle collapse on header click
  header.addEventListener('click', () => {
    categoryDiv.classList.toggle('collapsed');
  });
  
  // Assemble and add to panel
  categoryDiv.appendChild(header);
  categoryDiv.appendChild(content);
  panel.appendChild(categoryDiv);
}

/**
 * Create a blend shape slider item (individual slider)
 */
function createBlendShapeSliderItem(shapeName) {
  const item = document.createElement('div');
  item.className = 'blend-shape-item';
  
  const label = document.createElement('label');
  label.className = 'blend-shape-label';
  label.textContent = shapeName;
  
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'blend-shape-slider';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.01';
  slider.value = morphValues[shapeName] || 0;
  
  slider.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    morphValues[shapeName] = value;
    
    // Apply to all meshes with this blend shape
    if (blendShapeMap[shapeName]) {
      blendShapeMap[shapeName].forEach(({ mesh, index }) => {
        if (mesh.morphTargetInfluences) {
          mesh.morphTargetInfluences[index] = value;
        }
      });
    }
  });
  
  item.appendChild(label);
  item.appendChild(slider);
  
  return item;
}

/* ---------------- CLOTHES UI ---------------- */
const clothesCategoryButtons = document.querySelectorAll(".clothes-category");
const clothesItemsTitle = document.getElementById("clothes-items-title");
const clothesItemsGrid = document.querySelector(".clothes-items-grid");
const clothesItemsPanel = document.getElementById("clothes-items-panel");

clothesCategoryButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const category = btn.dataset.category;

    clothesCategoryButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    clothesItemsPanel.classList.add("active"); // ✅ ADD THIS
    clothesItemsTitle.textContent = category;

    buildClothingList(category);
  });
});

// Update category counts based on current base mesh
function updateCategoryCounts(baseMeshId) {
  const categories = ["shirts", "jacket", "pants", "shoes", "gloves", "hair", "facialHair", "headwear", "glasses", "accessories"];
  
  categories.forEach(category => {
    const count = CLOTHES.filter(c => 
      c.baseMesh === baseMeshId && c.category === category
    ).length;
    
    // Update the count span for this category
    const button = document.querySelector(`.clothes-category[data-category="${category}"]`);
    if (button) {
      const countSpan = button.querySelector('.item-count');
      if (countSpan) {
        countSpan.textContent = `(${count})`;
        
        // Optional: dim button if no items
        if (count === 0) {
          button.style.opacity = '0.5';
          button.style.cursor = 'default';
        } else {
          button.style.opacity = '1';
          button.style.cursor = 'pointer';
        }
      }
    }
  });
}

function getClothesFor(baseMeshId, category) {
  return CLOTHES.filter(c =>
    c.baseMesh === baseMeshId &&
    c.category === category
  );
}
function buildClothingList(category) {
  const panel = clothesItemsGrid;
  panel.innerHTML = "";

  if (!currentBaseMesh) {
    panel.innerHTML = "<p>Select a base mesh first.</p>";
    return;
  }

  // 🔹 NONE OPTION
const noneCard = document.createElement("div");
noneCard.className = "clothing-card none-card";

const preview = document.createElement("div");
preview.className = "clothing-preview";

const text = document.createElement("span");
text.textContent = "None";
text.style.fontSize = "12px";
text.style.color = "#777";

preview.appendChild(text);
noneCard.appendChild(preview);

const label = document.createElement("div");
label.className = "clothing-label";
label.textContent = "None";
noneCard.appendChild(label);

noneCard.className = "clothing-card clothing-card-none";
noneCard.onclick = () => {
  panel.querySelectorAll(".clothing-card, .clothing-card-none")
    .forEach(c => c.classList.remove("active"));
  noneCard.classList.add("active");
  unequipClothing(category);
};
panel.appendChild(noneCard);


  const items = getClothesFor(currentBaseMesh.id, category);

  if (items.length === 0) return;

  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "clothing-card";

    const preview = document.createElement("div");
    preview.className = "clothing-preview";
    preview.innerHTML = "<div style='color:#555;font-size:11px;text-align:center;padding-top:24px'>...</div>";

    card.appendChild(preview);

    const label = document.createElement("div");
    label.className = "clothing-label";
    label.textContent = item.name;

    card.appendChild(label);

    // Fetch blob URL for thumbnail — never cache blob URLs
    getAssetUrl(item.category, item.r2Key).then(url => {
      preview.innerHTML = "";
      createPreview({ container: preview, gltfPath: url });
    }).catch(() => {
      preview.innerHTML = "<div style='color:#555;font-size:11px;text-align:center'>N/A</div>";
    });

    card.dataset.itemId = item.id;
    card.onclick = () => {
      // Highlight this card, remove from others
      panel.querySelectorAll(".clothing-card, .clothing-card-none")
        .forEach(c => c.classList.remove("active"));
      card.classList.add("active");
      equipClothing(item);
    };
    panel.appendChild(card);
  });

  // Highlight whichever card is currently equipped (or none)
  const equipped = equippedClothes[category];
  if (equipped) {
    const activeCard = panel.querySelector(`[data-item-id="${equipped.id}"]`);
    activeCard?.classList.add("active");
  } else {
    panel.querySelector(".clothing-card-none")?.classList.add("active");
  }
}
async function equipClothing(item) {
  // Unequip existing
  if (equippedClothes[item.category]) {
    unequipClothing(item.category);
  }

  // Always get a fresh URL — presigned URLs expire in 60s
  try {
    item.path = await getAssetUrl(item.category, item.r2Key);
  } catch (err) {
    console.error("Failed to get clothing URL:", err);
    showToast("Failed to load item — please try again");
    return;
  }

  let gltf;
  try {
    gltf = await loader.loadAsync(item.path);
  } catch(err) {
    console.error("Failed to load clothing GLB:", err?.message || err);
    showToast("Failed to load item — please try again");
    return;
  }
  const clothingRoot = gltf.scene;

  const characterSkinnedMesh = getFirstSkinnedMesh(currentModel);
  if (!characterSkinnedMesh) {
    console.error("Character has no skinned mesh");
    return;
  }

  const characterSkeleton = characterSkinnedMesh.skeleton;
  const bindMatrix = characterSkinnedMesh.bindMatrix.clone();

  clothingRoot.traverse(obj => {
    if (obj.isSkinnedMesh) {
      // 🔑 CRITICAL FIX
      obj.bind(characterSkeleton, bindMatrix);
      obj.frustumCulled = false;
    }
  });

  currentModel.add(clothingRoot);
// 🔑 REGISTER CLOTHING BLEND SHAPES
collectBlendShapesFromObject(clothingRoot);

// 🔑 SYNC CLOTHING TO CURRENT MORPH VALUES
Object.entries(morphValues).forEach(([name, value]) => {
  blendShapeMap[name]?.forEach(({ mesh, index }) => {
    mesh.morphTargetInfluences[index] = value;
  });
});

  equippedClothes[item.category] = item.id;
  loadedClothingMeshes[item.id] = {
  root: clothingRoot,
  materialDomain: item.materialDomain || "fabric",
  clothing: item  // Store clothing reference for UV map access
};
}
function getFirstSkinnedMesh(root) {
  let found = null;
  root.traverse(obj => {
    if (obj.isSkinnedMesh && !found) {
      found = obj;
    }
  });
  return found;
}
function unequipClothing(category) {
  const id = equippedClothes[category];
  if (!id) return;

  const data = loadedClothingMeshes[id];
  if (!data || !data.root) return;

  const root = data.root;

  if (root.parent === currentModel) {
    currentModel.remove(root);
  }
// 🔑 REMOVE CLOTHING FROM BLENDSHAPE MAP
Object.keys(blendShapeMap).forEach(name => {
  blendShapeMap[name] = blendShapeMap[name].filter(
    entry => entry.mesh.parent !== root
  );

  if (blendShapeMap[name].length === 0) {
    delete blendShapeMap[name];
  }
});

  root.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach(m => m?.dispose());
      } else {
        obj.material.dispose();
      }
    }
  });

  delete loadedClothingMeshes[id];
  equippedClothes[category] = null;

  rebuildMaterialTargets();
  syncMaterialUI();
  buildTextureGrid();
}
function resetClothingUI() {
  clothesItemsGrid.innerHTML = `
    <div class="clothes-placeholder">
      Select a category
    </div>
  `;
  clothesItemsTitle.textContent = "Select a category";

  document
    .querySelectorAll(".clothes-category")
    .forEach(b => b.classList.remove("active"));
}
function unequipAllClothes() {
  if (!currentModel) return;

  Object.entries(loadedClothingMeshes).forEach(([id, data]) => {
    if (!data || !data.root || !data.root.isObject3D) return;

    const root = data.root;

    if (root.parent === currentModel) {
      currentModel.remove(root);
    }

    root.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();

      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m?.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
  });

  loadedClothingMeshes = {};

  equippedClothes = {
    shirts: null,
    pants: null,
    gloves: null,
    shoes: null,
    hair: null,
    jacket: null,
    facialHair: null,
    headwear: null,
    glasses: null,
    accessories: null
  };

  rebuildMaterialTargets();
  syncMaterialUI();
  buildTextureGrid();
}


/* ---------------- EXPORT UI ---------------- */
const exportBtn = document.getElementById("export-btn");

if (exportBtn) {
  exportBtn.addEventListener("click", async () => {
  if (!currentModel) {
    showToast("Load a character first!");
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    showToast("Sign in to export");
    document.getElementById("auth-overlay").classList.remove("hidden");
    return;
  }

  if (!currentBaseMesh) {
    showToast("Select a base mesh first");
    return;
  }

  document.getElementById("export-panel-overlay").classList.remove("hidden");
  renderExportPreview();
  });
} else {
  console.warn("Export button not found - check HTML");
}

function renderExportPreview() {
  const container = document.getElementById("export-preview-container");
  if (!container || !currentModel) return;
  
  // Clear previous preview
  container.innerHTML = "";
  
  // Create dedicated preview scene
  const previewScene = new THREE.Scene();
  previewScene.background = new THREE.Color(0x1e1e1e);
  
  // Clone current model with all modifications
  const modelClone = currentModel.clone(true);
  
  // Copy morph target influences
  modelClone.traverse(obj => {
    if (obj.isSkinnedMesh && obj.morphTargetInfluences) {
      const original = currentModel.getObjectByProperty('uuid', obj.uuid);
      if (original?.morphTargetInfluences) {
        obj.morphTargetInfluences = [...original.morphTargetInfluences];
      }
    }
  });
  
  previewScene.add(modelClone);
  
  // Add lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  previewScene.add(ambientLight);
  
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 10, 7.5);
  previewScene.add(dirLight);
  
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
  fillLight.position.set(-5, 0, -5);
  previewScene.add(fillLight);
  
  // Camera
  const previewCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  
  // Auto-frame model
  const box = new THREE.Box3().setFromObject(modelClone);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  
  previewCamera.position.set(
    center.x,
    center.y + maxDim * 0.3,
    center.z + maxDim * 2
  );
  previewCamera.lookAt(center);
  
  // Renderer
  const previewRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  previewRenderer.setSize(400, 400);
  previewRenderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(previewRenderer.domElement);
  
  // Animate preview
  let animFrameId;
  function animatePreview() {
    animFrameId = requestAnimationFrame(animatePreview);
    modelClone.rotation.y += 0.005;
    previewRenderer.render(previewScene, previewCamera);
  }
  animatePreview();
  
  // Store cleanup function
  container._cleanup = () => {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    previewRenderer.dispose();
    previewScene.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
  };
}

document.getElementById("export-panel-close")?.addEventListener("click", () => {
  const container = document.getElementById("export-preview-container");
  if (container?._cleanup) {
    container._cleanup();
  }
  document.getElementById("export-panel-overlay").classList.add("hidden");
});

async function handleExport(type, format) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;

  const currentCredits = parseInt(document.getElementById("credits-count").textContent, 10) || 0;
  
  let cost = 0;
  let exportName = "";

  if (type === "full") {
    cost = currentBaseMesh.priceCredits || 1;
    exportName = "Full Character";
  } else if (type === "animation") {
    cost = 0;
    exportName = "Animation Only";
  }

  if (cost > 0 && currentCredits < cost) {
    showToast(`Need ${cost} credit(s) — you have ${currentCredits}`);
    document.getElementById("export-panel-overlay").classList.add("hidden");
    document.getElementById("plans-overlay").classList.remove("hidden");
    const creditsTab = document.querySelector(".tab-btn[data-tab='credits']");
    creditsTab?.click();
    return;
  }

  const overlay = document.getElementById("export-panel-overlay");
  overlay.querySelector(".export-panel-content").style.opacity = "0.5";
  overlay.querySelector(".export-panel-content").style.pointerEvents = "none";

  try {
    if (cost > 0) {
      const configuration = {
        baseMesh: currentBaseMesh?.id,
        baseMeshName: currentBaseMesh?.name,
        format,
        exportType: type,
        equippedClothes: Object.fromEntries(
          Object.entries(equippedClothes).filter(([, v]) => v).map(([k, v]) => [k, v.id ?? v.name])
        ),
        blendShapes: { ...morphValues }
      };

      const { data, error } = await supabase.rpc("use_export_credit", {
        p_user_id: session.user.id,
        p_asset_id: currentBaseMesh.id,
        p_format: format,
        p_configuration: configuration
      });

      if (error) throw error;

      if (!data.success) {
        showToast(data.error ?? "Export failed");
        return;
      }

      document.getElementById("credits-count").textContent = data.credits_remaining;
    }

    if (type === "full") {
      await exportFullCharacter(format);
    } else if (type === "animation") {
      await exportAnimationOnly(format);
    }

    showToast(`${exportName} exported as ${format.toUpperCase()}!`);
    overlay.classList.add("hidden");

  } catch (err) {
    console.error("Export error:", err);
    showToast("Export failed — check console");
  } finally {
    overlay.querySelector(".export-panel-content").style.opacity = "1";
    overlay.querySelector(".export-panel-content").style.pointerEvents = "auto";
  }
}
window.handleExport = handleExport;


async function exportFullCharacter(format) {
  if (format === "fbx") {
    await exportAsFBX();
  } else {
    await exportAsGLTF(format, true);
  }
}

async function exportAnimationOnly(format) {
  if (format === "fbx") {
    await exportAnimationAsFBX();
  } else {
    await exportAnimationAsGLTF(format);
  }
}

function exportAsGLTF(format, includeModel = true) {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();

    currentModel.traverse(obj => {
      if (obj.isSkinnedMesh && obj.morphTargetInfluences) {
        obj.morphTargetInfluences = obj.morphTargetInfluences.map(v => v);
      }
    });

    const options = {
      binary: format === "glb",
      trs: false,
      onlyVisible: true,
      embedImages: true,
      includeCustomExtensions: true,
      animations: activeAction ? [activeAction.getClip()] : []
    };

    exporter.parse(
      currentModel,
      result => {
        try {
          let blob;
          const filename = `morphara_${currentBaseMesh?.id || "character"}.${format}`;

          if (format === "glb") {
            blob = new Blob([result], { type: "model/gltf-binary" });
          } else {
            blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
          }

          downloadBlob(blob, filename);
          resolve();
        } catch (err) {
          reject(err);
        }
      },
      error => {
        console.error("GLTF export error:", error);
        showToast("Export failed");
        reject(error);
      },
      options
    );
  });
}

function exportAnimationAsGLTF(format) {
  return new Promise((resolve, reject) => {
    if (!activeAction) {
      showToast("No animation loaded");
      reject(new Error("No animation"));
      return;
    }

    const exporter = new GLTFExporter();
    
    const skeletonRoot = new THREE.Group();
    const firstMesh = currentModel.children.find(c => c.isSkinnedMesh);
    if (firstMesh?.skeleton) {
      skeletonRoot.add(firstMesh.skeleton.bones[0].clone(true));
    }

    const options = {
      binary: format === "glb",
      trs: false,
      animations: [activeAction.getClip()]
    };

    exporter.parse(
      skeletonRoot,
      result => {
        try {
          const filename = `morphara_animation_${Date.now()}.${format}`;
          let blob;

          if (format === "glb") {
            blob = new Blob([result], { type: "model/gltf-binary" });
          } else {
            blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
          }

          downloadBlob(blob, filename);
          resolve();
        } catch (err) {
          reject(err);
        }
      },
      error => {
        console.error("Animation export error:", error);
        showToast("Animation export failed");
        reject(error);
      },
      options
    );
  });
}

async function exportAsFBX() {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session?.access_token) {
    showToast("Please sign in to export FBX");
    return;
  }

  try {
    showToast("Preparing FBX export...");

    // Export current model as GLB first
    const glbBlob = await new Promise((resolve, reject) => {
      if (!currentModel) {
        reject(new Error("No model loaded"));
        return;
      }

      const exporter = new GLTFExporter();
      const options = {
        binary: true,
        animations: mixer && mixer._actions ? Array.from(mixer._actions).map(a => a._clip) : [], // Export all animations
        maxTextureSize: 4096
      };

      exporter.parse(
        currentModel,
        (result) => {
          resolve(new Blob([result], { type: 'application/octet-stream' }));
        },
        (error) => reject(error),
        options
      );
    });

    console.log(`GLB prepared: ${(glbBlob.size / 1024).toFixed(2)} KB`);

    // Send to conversion service
    showToast("Converting to FBX (this may take 30-60 seconds)...");
    
    const formData = new FormData();
    formData.append('file', glbBlob, 'character.glb');

    const response = await fetch(`${WORKER_URL}/convert-to-fbx`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`
      },
      body: formData
    });

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
        console.error('Worker error response:', errorData);
        
        // Check if credit was refunded
        if (errorData.creditRefunded) {
          showToast(`Export failed: ${errorData.error || 'Unknown error'}. Credit refunded.`, 4000);
        } else {
          showToast(`Export failed: ${errorData.error || 'Unknown error'}`, 3000);
        }
      } catch (e) {
        console.error('Could not parse error:', e);
        showToast('Export failed - server error');
      }
      return;
    }

    // Check response headers for metadata
    const textureCount = response.headers.get('X-Textures-Count');
    const fbxSize = response.headers.get('X-FBX-Size');
    
    console.log(`FBX exported: ${fbxSize ? (parseInt(fbxSize) / 1024).toFixed(2) + ' KB' : 'unknown size'}`);
    console.log(`Textures included: ${textureCount || '0'}`);

    // Download ZIP file (contains FBX + textures)
    const zipBlob = await response.blob();
    const filename = `character_${Date.now()}_fbx.zip`;
    downloadBlob(zipBlob, filename);
    
    // Show success with details
    const message = textureCount > 0 
      ? `FBX exported! ${textureCount} texture${textureCount > 1 ? 's' : ''} included. Extract the ZIP to use.`
      : "FBX exported successfully!";
    
    showToast(message, 4000);
    
    // Refresh credits display
    const { data: userData } = await supabase
      .from('users')
      .select('credits')
      .eq('id', session.user.id)
      .single();
    
    if (userData) {
      const creditsEl = document.getElementById('credits-count');
      if (creditsEl) creditsEl.textContent = userData.credits;
    }
    
  } catch (error) {
    console.error('FBX export error:', error);
    
    // Check if error response indicates refund
    if (error.message?.includes('creditRefunded')) {
      showToast("Export failed. Credit refunded.", 3000);
    } else {
      showToast("Export failed. Please try again.", 2500);
    }
  }
}

async function exportAnimationAsFBX() {
  // Animation-only FBX export
  showToast("Animation-only FBX export coming soon!");
  // TODO: Implement animation-only export
  return Promise.resolve();
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

// ============================================================
// EXPORT PANEL STATE & HANDLERS
// ============================================================
let selectedExportType = null;
let selectedFormat = null;

window.selectExportType = function(type) {
  selectedExportType = type;
  document.querySelectorAll('.export-type-card').forEach(card => {
    card.style.borderColor = 'transparent';
  });
  event.currentTarget.style.borderColor = '#6c63ff';
  const cost = type === 'full' ? (currentBaseMesh?.priceCredits || 1) : 0;
  document.getElementById('full-cost').textContent = cost;
  updateExportButton();
};

window.selectFormat = async function(format, buttonElement) {
  console.log('selectFormat called with:', format, 'button:', buttonElement);
  
  // Store the button reference BEFORE any async operations
  const clickedButton = buttonElement;
  
  // Check if FBX requires premium/studio
  if (format === 'fbx') {
    // Get current session
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      showToast("Please sign in to export FBX");
      return;
    }
    
    try {
      const planResponse = await fetch(`${WORKER_URL}/check-plan`, {
        headers: { 'Authorization': `Bearer ${session.access_token}` }
      });
      
      if (planResponse.ok) {
        const planData = await planResponse.json();
        console.log('Plan data:', planData);
        
        if (!planData.features.fbxExport) {
          showToast("FBX export not available for Free plan");
          return;
        }
        
        console.log('✅ FBX export allowed for user');
      } else {
        showToast("Failed to verify plan");
        return;
      }
    } catch (error) {
      console.error('Plan check failed:', error);
      showToast("Failed to verify plan");
      return;
    }
  }
  
  // If we got here, format is allowed - select it
  console.log('Setting selectedFormat to:', format);
  selectedFormat = format;
  
  // Update button styles - clear all first
  document.querySelectorAll('.format-btn').forEach(btn => {
    btn.style.borderColor = 'transparent';
    btn.style.background = '#2a2a2a';
  });
  
  // Highlight the selected button
  if (clickedButton) {
    clickedButton.style.borderColor = '#6c63ff';
    clickedButton.style.background = '#3a3a3a';
    console.log('✅ Button highlighted');
  } else {
    console.warn('⚠️ No button reference');
  }
  
  // Update the export button text
  updateExportButton();
  console.log('✅ Export button updated');
};

function updateExportButton() {
  const btn = document.getElementById('final-export-btn');
  if (!btn) return;
  
  if (selectedExportType && selectedFormat) {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
    const typeLabel = selectedExportType === 'full' ? 'Full Character' : 'Animation Only';
    const formatLabel = selectedFormat.toUpperCase();
    const cost = selectedExportType === 'full' ? (currentBaseMesh?.priceCredits || 1) : 0;
    const costText = cost > 0 ? ` (${cost} Credit${cost > 1 ? 's' : ''})` : ' (FREE)';
    btn.textContent = `Export ${typeLabel} as ${formatLabel}${costText}`;
    btn.onclick = () => handleExport(selectedExportType, selectedFormat);
  } else {
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
    btn.textContent = 'Select options above';
    btn.onclick = null;
  }
}

/* ---------------- LOOP ---------------- */
function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(clock.getDelta(), 0.033);
  if (mixer) mixer.update(delta);

  applyMorphsPerFrame();
  controls.update();
  renderer.render(scene, camera);
}
/* ---------------- MATERIALS ---------------- */
const textureLoader = new THREE.TextureLoader();
const baseColorPicker = document.getElementById("baseColorPicker");
const textureGrid = document.getElementById("texture-grid");
const materialTargetsContainer = document.getElementById("material-targets");
async function applyTexturePreset(preset) {
  const target = materialTargets[activeMaterialTarget];
  if (!target) return;

  target.materialState.texture = preset;

  // Always fetch fresh — never use cached blob URL (they die on refresh)
  let mapUrl = null;
  if (preset.r2Key) {
    try {
      mapUrl = await getAssetUrl("textures", preset.r2Key);
    } catch (err) {
      console.error("Failed to load texture URL:", err);
    }
  }

  target.meshes.forEach(mesh => {
    const mats = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];

    mats.forEach(mat => {
      if (!mat) return;

      if (mapUrl) {
        mat.map = textureLoader.load(mapUrl);
        mat.map.colorSpace = THREE.SRGBColorSpace;
      } else {
        mat.map = null;
      }

      if (preset.normal) mat.normalMap = textureLoader.load(preset.normal);
      if (preset.roughness !== undefined) mat.roughness = preset.roughness;
      if (preset.metalness !== undefined) mat.metalness = preset.metalness;

      mat.needsUpdate = true;
    });
  });
}

if (baseColorPicker) {
baseColorPicker.addEventListener("input", e => {
  const target = materialTargets[activeMaterialTarget];
  if (!target) return;

  const color = new THREE.Color(e.target.value);
  target.materialState.color = color;

  target.meshes.forEach(mesh => {
    const mats = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];

    mats.forEach(mat => mat?.color?.copy(color));
  });
});

}
function rebuildMaterialTargetsUI() {
  materialTargetsContainer.innerHTML = "";

  Object.entries(materialTargets).forEach(([key, target]) => {
    const btn = document.createElement("button");
    btn.className = "material-target-btn";
    btn.textContent = target.label;

    if (key === activeMaterialTarget) {
      btn.classList.add("active");
    }

    btn.onclick = () => {
      activeMaterialTarget = key;
      rebuildMaterialTargetsUI();
      syncMaterialUI();
      buildTextureGrid();
      
      // FIX: Update texture dropdown when switching materials
      if (meshTextureData[key]) {
        currentPainterMesh = key;
        updateTextureUI(key);
      }
    };

    materialTargetsContainer.appendChild(btn);
  });
}

function rebuildMaterialTargets() {
  materialTargets = {};

  // Base mesh → skin — read ACTUAL current color from mesh material
  if (baseSkinnedMeshes.length) {
    // Get real current color from the mesh, not a hardcoded white
    let currentColor = new THREE.Color("#ffffff");
    const firstMesh = baseSkinnedMeshes[0];
    if (firstMesh?.material) {
      const mat = Array.isArray(firstMesh.material) ? firstMesh.material[0] : firstMesh.material;
      if (mat?.color) currentColor = mat.color.clone();
    }

    materialTargets.base = {
      label: "Skin",
      meshes: baseSkinnedMeshes,
      domain: "skin",
      materialState: {
        color: currentColor,
        texture: null
      }
    };
  }

  // Clothes
Object.entries(loadedClothingMeshes).forEach(([id, data]) => {
  const { root, materialDomain } = data;

  const meshes = [];
  root.traverse(o => o.isSkinnedMesh && meshes.push(o));
  if (!meshes.length) return;

  materialTargets[id] = {
    label: id,
    meshes,
    domain: materialDomain || "fabric", // 🔑 NOW DYNAMIC
    clothing: data.clothing,  // Reference to clothing object (has uv_map)
    materialState: {
      color: new THREE.Color("#ffffff"),
      texture: null
    }
  };
});


  if (!activeMaterialTarget || !materialTargets[activeMaterialTarget]) {
    activeMaterialTarget = Object.keys(materialTargets)[0] || null;
  }
}

function syncMaterialUI() {
  const target = materialTargets[activeMaterialTarget];
  if (!target) return;
  baseColorPicker.value = `#${target.materialState.color.getHexString()}`;
}
function buildTextureGrid() {
  textureGrid.innerHTML = "";

  const target = materialTargets[activeMaterialTarget];
  if (!target) return;

  const presets = TEXTURE_PRESETS[target.domain] || [];

  if (!presets.length) {
    textureGrid.innerHTML = `
      <div style="color:#777;font-size:12px;">
        No presets for this material
      </div>
    `;
    return;
  }

  presets.forEach(preset => {
    const item = document.createElement("div");
    item.className = "texture-item";
    item.title = preset.label;
    item.innerText = preset.label;

    // Load thumbnail if we have a cached URL
    if (preset.map) {
      item.style.backgroundImage = `url(${preset.map})`;
      item.innerText = "";
    } else if (preset.r2Key) {
      // Fetch URL and apply as background
      getAssetUrl("textures", preset.r2Key).then(url => {
        // Don't cache on preset.map — blob URLs die on refresh
        item.style.backgroundImage = `url(${url})`;
        item.innerText = "";
      }).catch(() => {});
    }

    item.onclick = () => applyTexturePreset(preset);
    textureGrid.appendChild(item);
  });
}
/* ---------------- Randomisation Configartion ---------------- */
document.querySelectorAll('[data-rand]').forEach(input => {
  const key = input.dataset.rand;
  input.addEventListener('change', () => {
    randomizerConfig[key] = input.checked;
  });
});
document.getElementById('randomize-btn')
  .addEventListener('click', () => {
    const overlay = document.getElementById('randomizer-loading');
    if (overlay) {
      overlay.classList.remove('hidden');
      setTimeout(async () => {
        await randomizeCharacter();
        overlay.classList.add('hidden');
      }, 50);
    } else {
      randomizeCharacter();
    }
  });

document.getElementById('reset-btn')
  .addEventListener('click', resetCharacter);

function updateResetButton() {
  const resetBtn = document.getElementById('reset-btn');
  if (!resetBtn) return;
  resetBtn.disabled = !currentBaseMesh;
}
async function randomizeCharacter() {

  /* ---------- BASE MESH ---------- */
  // If baseMesh is checked, load a random mesh and WAIT for it to finish
  // before randomizing everything else — no more early return
  if (randomizerConfig.baseMesh && BASE_MESHES.length) {
    const mesh = BASE_MESHES[Math.floor(Math.random() * BASE_MESHES.length)];
    // Wait for the model to fully load before continuing
    await new Promise(resolve => {
      loadBaseMesh(mesh, resolve); // resolve called inside onModelLoaded
    });
  }

  if (!currentBaseMesh) return;

  /* ---------- BASE COLOR ---------- */
  if (randomizerConfig.colors) {
    // Randomize base mesh skin color
    const baseTarget = materialTargets["base"];
    if (baseTarget) {
      const randColor = new THREE.Color().setHSL(
        Math.random(),
        0.3 + Math.random() * 0.4,
        0.4 + Math.random() * 0.3
      );
      baseTarget.materialState.color.copy(randColor);
      baseTarget.meshes.forEach(mesh => {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach(mat => mat?.color?.copy(randColor));
      });
      // Sync color picker if base is active target
      if (activeMaterialTarget === "base") {
        baseColorPicker.value = `#${randColor.getHexString()}`;
      }
    }
  }

  /* ---------- CLOTHES ---------- */
  if (randomizerConfig.clothes) {
    unequipAllClothes();

    const categories = [...new Set(CLOTHES.map(c => c.category))];

    for (const category of categories) {
      if (Math.random() > 0.5) continue;

      const items = CLOTHES.filter(
        c => c.baseMesh === currentBaseMesh.id &&
             c.category === category
      );

      if (!items.length) continue;

      const item = items[Math.floor(Math.random() * items.length)];
      await equipClothing(item);
    }
  }

  /* ---------- BLEND SHAPES ---------- */
  if (randomizerConfig.blendShapes && Object.keys(morphValues).length > 0) {
    Object.keys(morphValues).forEach(key => {
      morphValues[key] = Math.random() * 0.6;
    });
    // Morphs are applied every frame via applyMorphsPerFrame() in animate()
  }

  /* ---------- CLOTHING MATERIAL COLORS ---------- */
  Object.entries(materialTargets).forEach(([key, target]) => {
    if (key === "base") return; // already handled above
    activeMaterialTarget = key;

    if (randomizerConfig.colors) {
      const randColor = new THREE.Color().setHSL(
        Math.random(),
        0.4 + Math.random() * 0.3,
        0.4 + Math.random() * 0.3
      );
      target.materialState.color.copy(randColor);
      target.meshes.forEach(mesh => {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach(mat => mat?.color?.copy(randColor));
      });
    }

    if (randomizerConfig.textures) {
      const presets = TEXTURE_PRESETS[target.domain];
      if (presets?.length) {
        const preset = presets[Math.floor(Math.random() * presets.length)];
        applyTexturePreset(preset);
      }
    }
  });

  // Restore activeMaterialTarget to base and sync UI
  activeMaterialTarget = Object.keys(materialTargets)[0] || "base";
  syncMaterialUI();
  rebuildMaterialTargetsUI();

  /* ---------- ANIMATION ---------- */
  if (randomizerConfig.animation) {
    const anims = ANIMATIONS.filter(
      a => a.baseMesh === currentBaseMesh.id
    );
    if (anims.length) {
      loadAnimation(anims[Math.floor(Math.random() * anims.length)]);
    }
  }
}
function resetCharacter() {
  if (!currentBaseMesh) return;

  unequipAllClothes();

  /* ---------- RESET BLEND SHAPES ---------- */
  Object.keys(morphValues).forEach(k => {
    morphValues[k] = 0;
  });

  /* ---------- RESET ANIMATION ---------- */
  if (mixer) {
    mixer.stopAllAction();
    activeAction = null;
  }

  /* ---------- RESET SKIN ---------- */
  rebuildMaterialTargets();
  activeMaterialTarget = "base";

  const skinPresets = TEXTURE_PRESETS.skin || [];
  const warm = skinPresets.find(p => p.id === "skin_warm");

  if (warm) {
    applyTexturePreset(warm);
  }

  syncMaterialUI();
  buildTextureGrid();
}


/* ---------------- ANIMATION UI ---------------- */
const animationsList = document.getElementById("animations-list");
function buildAnimationUI() {
  animationsList.innerHTML = "";

  if (!currentBaseMesh) {
    animationsList.innerHTML = "<p style='color:#888'>Select a base mesh first</p>";
    return;
  }

  const items = ANIMATIONS.filter(
    a => a.baseMesh === currentBaseMesh.id
  );

  items.forEach(anim => {
    const card = document.createElement("div");
    card.className = "animation-card";

    const preview = document.createElement("div");
    preview.className = "preview-canvas";
    preview.innerHTML = "<div style='color:#555;font-size:11px;text-align:center;padding-top:30px'>...</div>";

    const label = document.createElement("div");
    label.className = "animation-name";
    label.textContent = anim.name;

    card.append(preview, label);
    animationsList.appendChild(card);

    // Fetch animation URL + base mesh URL for preview
    // Fetch blob URLs for thumbnail — never cache blob URLs
    Promise.all([
      getAssetUrl("animation", anim.r2Key),
      currentBaseMesh ? getAssetUrl("basemesh", currentBaseMesh.r2Key) : Promise.resolve(null)
    ]).then(([animUrl, baseMeshUrl]) => {
      preview.innerHTML = "";
      const previewInstance = createPreview({
        container: preview,
        animationPath: animUrl,
        baseMeshPath: baseMeshUrl,
        autoRotate: false
      });
      activePreviews.set(preview, previewInstance);
    }).catch(() => {
      preview.innerHTML = "<div style='color:#555;font-size:11px;text-align:center'>N/A</div>";
    });

    card.onclick = () => loadAnimation(anim);
  });
}

async function loadAnimation(animData) {
  if (!currentModel) return;

  try {
    animData.path = await getAssetUrl("animation", animData.r2Key);
  } catch (err) {
    console.error("Failed to get animation URL:", err);
    showToast("Failed to load animation");
    return;
  }

  const gltf = await loader.loadAsync(animData.path);
  if (!gltf.animations.length) return;

  if (!mixer) {
    mixer = new THREE.AnimationMixer(currentModel);
  }

  // 🔑 HARD STOP ALL PREVIOUS ACTIONS
  mixer.stopAllAction();

  activeAction = mixer.clipAction(gltf.animations[0]);

  activeAction.reset();
  activeAction.setEffectiveWeight(1);
  activeAction.setEffectiveTimeScale(1);

  activeAction.loop = animData.loop
    ? THREE.LoopRepeat
    : THREE.LoopOnce;

  activeAction.play();
}

/* ---------------- SCENE HELPERS ---------------- */
function addGroundGrid() {
  scene.add(new THREE.GridHelper(10, 20, 0x444444, 0x222222));
}
function setupLights() {
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(5, 10, 5);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-5, 5, -5);
  scene.add(fill);
}
function setupControls() {
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.2;
controls.maxDistance = 6;
}
/* ---------------- CAMERA ---------------- */
function frameCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object);

  const size = box.getSize(new THREE.Vector3());
  const height = size.y;

  const center = box.getCenter(new THREE.Vector3());

  // Character-focused target (upper body)
  const targetY = box.min.y + height * 0.6;

  const target = new THREE.Vector3(
    center.x,
    targetY,
    center.z
  );

  const distance = height * 8;

  // 📸 Camera in FRONT of character, slightly above, tilted down
  camera.position.set(
    center.x,
    targetY + height * 7, // height gives downward angle
    center.z - distance      // FRONT (important)
  );

  controls.target.copy(target);
  controls.update();

  camera.lookAt(target);
}

function framePainterCamera() {
  if (!currentModel) return;

  const box = new THREE.Box3().setFromObject(currentModel);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const height = size.y;

  const target = new THREE.Vector3(
    center.x,
    center.y + height * 0.55,
    center.z
  );

  camera.position.set(
    center.x,
    target.y + height * 7,
    center.z - height * 10
  );

  controls.target.copy(target);
  controls.update();
}

function onResize() {
  let width, height;

  if (isPainterMode) {
    const rect = document
      .getElementById("painter-viewport")
      .getBoundingClientRect();
    width = rect.width;
    height = rect.height;
  } else {
    const viewport = document.getElementById("viewport");
    width = viewport.clientWidth;
    height = viewport.clientHeight;
  }

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

/* ================= Texture Painter Mode ================= */
const painterMode = document.getElementById("texture-painter-mode");
const painterViewport = document.getElementById("painter-viewport");
const exitPainterBtn = document.getElementById("exit-painter");

let previousUIMode = "materials";

function enterPainterMode() {
  if (!currentModel || !activeMaterialTarget) return;
  isPainterMode = true;

  // remember where we came from
  const activeBtn = document.querySelector(".top-btn.active");
  previousUIMode = activeBtn?.dataset.mode || "materials";

  // hide customization UI (CLASS-BASED, not style)
  document.getElementById("top-panel").classList.add("hidden");
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.getElementById("clothes-items-panel")?.classList.remove("active");
  painterControls = controls;
  // show painter
  painterMode.classList.remove("hidden");

  // move renderer
  originalViewportParent = renderer.domElement.parentElement;
  painterViewport.appendChild(renderer.domElement);

  framePainterCamera();
  onResize();
}
function exitPainterMode() {
    if (texturePainter) {
    texturePainter = null;
  }

  painterTargetMesh = null;
  painterCanvas = null;
  isPainterMode = false;

  // restore renderer
  if (originalViewportParent) {
    originalViewportParent.appendChild(renderer.domElement);
  }

  painterMode.classList.add("hidden");

  // restore UI (NO inline styles)
  document.getElementById("top-panel").classList.remove("hidden");

  // restore previous mode cleanly
  setUIMode(previousUIMode);

  onResize();
}
document.getElementById("open-texture-painter").addEventListener("click", () => {
  const target = materialTargets[activeMaterialTarget];
  if (!target) {
    alert("No material selected");
    return;
  }

  // Get mesh ID
  const meshId = activeMaterialTarget;
  
  // Ensure texture data exists for this mesh
  ensureMeshTextureData(meshId, maxAllowedResolution);
  
  // Set current mesh
  currentPainterMesh = meshId;
  
  // Get mesh data
  const meshData = meshTextureData[meshId];
  
  // If no textures exist, create the first one
  if (Object.keys(meshData.textures).length === 0) {
    createTextureForMesh(meshId, 'custom_1', 'Custom Texture 1', true);
    meshData.selectedTexture = 'custom_1';
  }
  
  currentTextureName = meshData.selectedTexture;
  
  // Get the texture data
  const texData = meshData.textures[currentTextureName];
  
  // Set painter canvas
  painterCanvas = texData.canvas;
  painterTargetMesh = target.meshes[0];
  
  // Create TexturePainter instance
  texturePainter = new TexturePainter({
    canvas: painterCanvas,
    mesh: painterTargetMesh,
    material: painterTargetMesh.material,
    texture: texData.texture
  });
  
  // Sync color picker with current brush color
  const currentColor = texturePainter.color || '#ffffff';
  document.getElementById('paint-color').value = currentColor;
  
  // Update UI
  updateTextureUI(meshId);
  updateResetButtonState();
  
  // Load UV map
  getUVMapForActiveTarget().then(uvPath => {
    if (!uvPath) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = uvPath;
    img.onload = () => {
      uvOverlayImage = img;
      updateTextureView();
    };
  });
  
  showUVOverlay = true;
  document.getElementById("toggle-uv").classList.toggle("active", showUVOverlay);
  document.getElementById("uv-opacity").value = uvOpacity * 100;
  
  enterPainterMode();
  updateTextureView();
  texturePainter.setTool("draw");
  
  document.querySelectorAll(".tool-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tool === "draw")
  );
});


exitPainterBtn.addEventListener("click", exitPainterMode);
/* ================= Texture Painter Logic ================= */
let texZoom = 1;
let texOffsetX = 0;
let texOffsetY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;

document.querySelectorAll(".tool-btn").forEach(b => {
  b.addEventListener('click', () => {
    const tool = b.dataset.tool;
    texturePainter.setTool(tool);
    
    // Update active state
    document.querySelectorAll(".tool-btn").forEach(btn =>
      btn.classList.toggle("active", btn === b)
    );
    
    // Enable/disable camera controls based on tool
    if (tool === 'move' && painterControls) {
      painterControls.enabled = true;
    } else if (painterControls) {
      painterControls.enabled = false;
    }
  });
});
const paintColorInput = document.getElementById("paint-color");
paintColorInput.addEventListener("input", e => {
  if (!texturePainter) return;
  texturePainter.setColor(e.target.value);
});
const brushSizeInput = document.getElementById("brush-size");
brushSizeInput.addEventListener("input", e => {
  if (!texturePainter) return;
  texturePainter.setBrushSize(parseInt(e.target.value, 10));
  updateTextureView();  // Update cursor size preview
});
function updateTextureView() {
  // UI canvas (the visible one on the right)
  const uiCanvas = document.getElementById("texture-canvas");
  if (!uiCanvas) return;

  const uiCtx = uiCanvas.getContext("2d");

  // Offscreen canvas (the real texture data)
  if (!painterCanvas) return;

  // Ensure UI canvas matches texture resolution
  if (
    uiCanvas.width !== painterCanvas.width ||
    uiCanvas.height !== painterCanvas.height
  ) {
    uiCanvas.width = painterCanvas.width;
    uiCanvas.height = painterCanvas.height;
  }

  // Clear preview
  uiCtx.setTransform(1, 0, 0, 1, 0, 0);
  uiCtx.clearRect(0, 0, uiCanvas.width, uiCanvas.height);

  // Apply pan + zoom (PREVIEW ONLY)
  uiCtx.translate(
    uiCanvas.width / 2 + texOffsetX,
    uiCanvas.height / 2 + texOffsetY
  );
  uiCtx.scale(texZoom, texZoom);
  uiCtx.translate(
    -painterCanvas.width / 2,
    -painterCanvas.height / 2
  );

  // Draw texture preview
  uiCtx.drawImage(painterCanvas, 0, 0);
  // ---------------------------------------
// UV OVERLAY (PREVIEW ONLY, LOCKED)
// ---------------------------------------
if (showUVOverlay && uvOverlayImage) {
  uiCtx.save();

  uiCtx.globalAlpha = uvOpacity; // adjust opacity here
  uiCtx.drawImage(
    uvOverlayImage,
    0,
    0,
    painterCanvas.width,
    painterCanvas.height
  );

  uiCtx.restore();
}
}

function drawBrushCursor(uiCanvas, uiCtx) {
  if (!texturePainter || canvasMouseX === null || canvasMouseY === null) return;
  
  const tool = texturePainter.tool;
  
  // Different cursors for different tools
  if (tool === "move") {
    // Move tool uses native grab cursor
    return;
  }
  
  if (tool === "draw" || tool === "erase") {
    // Draw circle showing brush size
    const brushSize = texturePainter.brushSize || 10;
    
    uiCtx.save();
    uiCtx.strokeStyle = tool === "erase" ? "#ff5555" : "#7c5cff";
    uiCtx.lineWidth = 2;
    uiCtx.setLineDash([4, 4]);
    
    // Draw circle at mouse position (in screen space, not texture space)
    uiCtx.beginPath();
    uiCtx.arc(canvasMouseX, canvasMouseY, brushSize * texZoom / 2, 0, Math.PI * 2);
    uiCtx.stroke();
    
    uiCtx.restore();
  } else if (tool === "bucket") {
    // Draw crosshair for bucket tool
    uiCtx.save();
    uiCtx.strokeStyle = "#7c5cff";
    uiCtx.lineWidth = 2;
    
    const size = 10;
    uiCtx.beginPath();
    uiCtx.moveTo(canvasMouseX - size, canvasMouseY);
    uiCtx.lineTo(canvasMouseX + size, canvasMouseY);
    uiCtx.moveTo(canvasMouseX, canvasMouseY - size);
    uiCtx.lineTo(canvasMouseX, canvasMouseY + size);
    uiCtx.stroke();
    
    uiCtx.restore();
  }
}

function getTextureCoordsFromMouse(e, uiCanvas) {
  const rect = uiCanvas.getBoundingClientRect();

  // Mouse position in UI canvas space
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  // Move origin to canvas center
  let x = mx - uiCanvas.width / 2;
  let y = my - uiCanvas.height / 2;

  // Undo pan
  x -= texOffsetX;
  y -= texOffsetY;

  // Undo zoom
  x /= texZoom;
  y /= texZoom;

  // Move origin to texture space
  x += painterCanvas.width / 2;
  y += painterCanvas.height / 2;

  return { x, y };
}

const uiCanvas = document.getElementById("texture-canvas");

uiCanvas.addEventListener("wheel", e => {
  e.preventDefault();

  texZoom += e.deltaY * -0.001;
  texZoom = Math.min(Math.max(0.25, texZoom), 8);

  updateTextureView();
});

uiCanvas.addEventListener("pointerdown", e => {
  if (e.button !== 1 && e.button !== 2) return;

  isPanning = true;
  panStartX = e.clientX;
  panStartY = e.clientY;
  uiCanvas.style.cursor = "grabbing";
});

window.addEventListener("pointermove", e => {
  if (!isPanning) return;

  texOffsetX += e.clientX - panStartX;
  texOffsetY += e.clientY - panStartY;

  panStartX = e.clientX;
  panStartY = e.clientY;

  updateTextureView();
});

window.addEventListener("pointerup", () => {
  isPanning = false;
  uiCanvas.style.cursor = "grab";
});

// ============================================================================
// TEXTURE PAINTER - DRAWING MOUSE EVENTS
// ============================================================================

let isPaintingLocal = false;
let lastPaintX = null;
let lastPaintY = null;

// Mouse down - start painting
uiCanvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return; // Only left click
  if (!texturePainter) return;
  
  const tool = texturePainter.tool;
  
  // Move tool uses different behavior
  if (tool === "move") {
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    uiCanvas.style.cursor = "grabbing";
    return;
  }
  
  // Get texture coordinates
  const coords = getTextureCoordsFromMouse(e, uiCanvas);
  if (!coords) return;
  
  // CRITICAL: Save history BEFORE painting starts (for undo)
  if (currentPainterMesh && currentTextureName) {
    saveToHistory(currentPainterMesh, currentTextureName);
  }
  
  isPaintingLocal = true;
  lastPaintX = coords.x;
  lastPaintY = coords.y;
  
  // Start drawing on the actual texture canvas
  texturePainter.startDraw(coords.x, coords.y);
  
  // Update view
  updateTextureView();
});

// Mouse move - continue painting
uiCanvas.addEventListener("mousemove", (e) => {
  if (!texturePainter) return;
  
  const tool = texturePainter.tool;
  
  // Handle panning for move tool
  if (tool === "move" && isPanning) {
    texOffsetX += e.clientX - panStartX;
    texOffsetY += e.clientY - panStartY;
    panStartX = e.clientX;
    panStartY = e.clientY;
    updateTextureView();
    return;
  }
  
  // Handle painting
  if (!isPaintingLocal) return;
  
  const coords = getTextureCoordsFromMouse(e, uiCanvas);
  if (!coords) return;
  
  // Draw on texture canvas
  texturePainter.draw(coords.x, coords.y);
  
  lastPaintX = coords.x;
  lastPaintY = coords.y;
  
  // Update view
  updateTextureView();
});

// Mouse up - stop painting
uiCanvas.addEventListener("mouseup", (e) => {
  if (e.button !== 0) return;
  
  if (texturePainter?.tool === "move") {
    isPanning = false;
    uiCanvas.style.cursor = "grab";
  }
  
  if (isPaintingLocal && texturePainter) {
    texturePainter.endDraw();
    isPaintingLocal = false;
    lastPaintX = null;
    lastPaintY = null;
    updateTextureView();
  }
});

// Mouse leave - stop painting
uiCanvas.addEventListener("mouseleave", () => {
  if (isPaintingLocal && texturePainter) {
    texturePainter.endDraw();
    isPaintingLocal = false;
    lastPaintX = null;
    lastPaintY = null;
  }
  
  if (isPanning) {
    isPanning = false;
    uiCanvas.style.cursor = "grab";
  }
  
  // Clear cursor position
  canvasMouseX = null;
  canvasMouseY = null;
  updateTextureView();
});

function showToast(message, duration = 1500) {
  const toast = document.getElementById("toast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.classList.add("show");

  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.classList.add("hidden"), 300);
  }, duration);
}
/* ------------------ UV MAPS ---------- */
// UV maps are stored in the uvmaps bucket with compatible_mesh = baseMesh id
async function getUVMapForActiveTarget() {
  // Determine which asset we're painting (shirt, pants, or base mesh)
  let targetAsset = null;
  let assetType = "base mesh";
  
  // Check if we're editing a clothing item
  const target = materialTargets[activeMaterialTarget];
  if (target && target.clothing) {
    // We're editing clothing (shirt, pants, etc.)
    targetAsset = target.clothing;
    assetType = target.clothing.type || "clothing";
  } else {
    // We're editing the base mesh
    targetAsset = currentBaseMesh;
  }
  
  // Check if this asset has a UV map defined
  if (!targetAsset?.uv_map) {
    console.warn(`No UV map defined for ${assetType}:`, targetAsset?.id);
    return null;
  }

  try {
    // Fetch UV map from uvmaps bucket
    const uvMapUrl = await getAssetUrl("uvmaps", targetAsset.uv_map, "public");
    console.log(`✓ Loaded UV map for ${assetType}:`, targetAsset.uv_map);
    return uvMapUrl;
  } catch (err) {
    console.error(`✗ Failed to load UV map for ${assetType}:`, err);
    return null;
  }
}

const toggleUVBtn = document.getElementById("toggle-uv");
const uvOpacitySlider = document.getElementById("uv-opacity");
toggleUVBtn.onclick = () => {
  showUVOverlay = !showUVOverlay;
  toggleUVBtn.classList.toggle("active", showUVOverlay);
  updateTextureView();
};
uvOpacitySlider.oninput = e => {
  uvOpacity = parseInt(e.target.value, 10) / 100;
  updateTextureView();
};
/* ---------------- User Menus ---------------- */
/* ---------------- User & Credits Menus ---------------- */

const userBtn = document.getElementById("user-btn");
const creditsBtn = document.getElementById("credits-btn");

const userMenu = document.getElementById("user-menu");
const creditsMenu = document.getElementById("credits-menu");

userBtn.onclick = (e) => {
  e.stopPropagation();
  userMenu.classList.toggle("hidden");
  creditsMenu.classList.add("hidden");
};

creditsBtn.onclick = (e) => {
  e.stopPropagation();
  creditsMenu.classList.toggle("hidden");
  userMenu.classList.add("hidden");
};

document.addEventListener("click", () => {
  userMenu.classList.add("hidden");
  creditsMenu.classList.add("hidden");
});

[userMenu, creditsMenu].forEach(menu => {
  menu.addEventListener("click", e => e.stopPropagation());
});
/* ================= Launch Overlay ================= */

/* ================= Launch Overlay ================= */

const launchOverlay = document.getElementById("launch-overlay");
const closeLaunch = document.getElementById("close-launch");
const launchSignupBtn = document.querySelector("#launch-signup-btn");

if (launchOverlay && closeLaunch) {

  const hasSeenLaunch = localStorage.getItem("morphara_launch_seen");

  if (hasSeenLaunch) {
    launchOverlay.style.display = "none";
  }

  function closeLaunchOverlay() {
    launchOverlay.style.display = "none";
    localStorage.setItem("morphara_launch_seen", "true");
  }

  closeLaunch.addEventListener("click", closeLaunchOverlay);
  
  if (launchSignupBtn) {
    launchSignupBtn.addEventListener("click", () => {
      closeLaunchOverlay();

      // Open signup modal
      const authOverlay = document.getElementById("auth-overlay");
      if (authOverlay) {
        authOverlay.classList.remove("hidden");
        document.body.style.overflow = "hidden";
        // Switch to signup tab
        document.querySelectorAll("[data-auth-tab]").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".auth-panel").forEach(p => p.classList.remove("active"));
        document.querySelector("[data-auth-tab='signup']")?.classList.add("active");
        document.getElementById("signup-panel")?.classList.add("active");
      }
    });
  }
}
// ================= AUTH UI =================

const authOverlay = document.getElementById("auth-overlay");
const closeAuthBtn = document.getElementById("close-auth");

const authTabs = document.querySelectorAll(".auth-tab");
const authSubmit = document.getElementById("auth-submit");
const authTitle = document.getElementById("auth-title");
const authError = document.getElementById("auth-error");

let authMode = "signup"; // default

// Auth open buttons are dynamically bound inside updateUserMenu()

// Close overlay
closeAuthBtn.addEventListener("click", () => {
  authOverlay.classList.add("hidden");
});

// Switch tabs
authTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    authMode = tab.dataset.auth;
    updateAuthUI();
  });
});

function updateAuthUI() {
  authTabs.forEach(t => t.classList.remove("active"));
  document.querySelector(`[data-auth="${authMode}"]`).classList.add("active");

  authTitle.textContent =
    authMode === "signup" ? "Create Account" : "Login";

  authSubmit.textContent =
    authMode === "signup" ? "Create Account" : "Login";
}

// ================= EMAIL AUTH =================


authSubmit.addEventListener("click", async () => {
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;

  authError.textContent = "";

  if (!email || !password) {
    authError.textContent = "Please enter your email and password.";
    return;
  }

  try {
    if (authMode === "signup") {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;

      // Supabase may require email confirmation — session may be null
      if (!data.session) {
        authError.style.color = "#4caf50";
        authError.textContent = "Check your email to confirm your account!";
        return;
      }

      // onAuthStateChange will fire and call updateUserMenu automatically
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      // onAuthStateChange will handle the rest
    }

    document.getElementById("auth-overlay").classList.add("hidden");
    showToast("Welcome to Morphara 🎉");

  } catch (err) {
    authError.style.color = "";
    authError.textContent = err.message;
  }
});

// ================= OAUTH =================

document.getElementById("github-auth").addEventListener("click", async () => {
  await supabase.auth.signInWithOAuth({
    provider: "github",
    options: {
      redirectTo: window.location.origin
    }
  });
});

// ================= SETTINGS OVERLAY =================

const settingsOverlay = document.getElementById("settings-overlay");
const closeSettingsBtn = document.getElementById("close-settings");

if (closeSettingsBtn) {
  closeSettingsBtn.addEventListener("click", () => {
    settingsOverlay.style.display = "none";
  });
}

// Close on backdrop click
settingsOverlay?.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.style.display = "none";
});

// Cancel Subscription
document.getElementById("cancel-subscription-btn")?.addEventListener("click", async () => {
  if (!confirm("Are you sure you want to cancel your subscription? You'll lose access to Premium features at the end of your billing period.")) {
    return;
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    // Call worker to cancel subscription
    const response = await fetch(`${WORKER_URL}/cancel-subscription`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      const result = await response.json();
      const msg = result.expiryDate
        ? `Subscription cancelled. Access continues until ${result.expiryDate}.`
        : "Subscription cancelled. Access continues until end of billing period.";
      showToast(msg, 4000);
      settingsOverlay.style.display = "none";
      // Refresh plan badge to show it's cancelling
      const { data: { session: s } } = await supabase.auth.getSession();
      if (s) await fetchAndDisplayPlan(s.user.id);
    } else {
      const error = await response.json();
      showToast(`Failed to cancel: ${error.error || 'Unknown error'}`);
    }
  } catch (error) {
    console.error('Cancel subscription error:', error);
    showToast("Failed to cancel subscription");
  }
});

// Delete Account (Disable)
document.getElementById("delete-account-btn")?.addEventListener("click", async () => {
  const confirmed = prompt('Type "DELETE" to confirm account deletion:');
  
  if (confirmed !== "DELETE") {
    showToast("Account deletion cancelled");
    return;
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    // Call worker to disable account
    const response = await fetch(`${WORKER_URL}/disable-account`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      showToast("Account disabled. Signing you out...");
      setTimeout(async () => {
        await supabase.auth.signOut();
        settingsOverlay.style.display = "none";
      }, 2000);
    } else {
      const error = await response.json();
      showToast(`Failed to disable account: ${error.error || 'Unknown error'}`);
    }
  } catch (error) {
    console.error('Delete account error:', error);
    showToast("Failed to disable account");
  }
});

supabase.auth.onAuthStateChange((event, session) => {
  updateUserMenu(session ?? null);
});
// ============================================================================
// TEXTURE PAINTER V2 - INIT & EVENT LISTENERS (data/undo/redo in TexturePainter.js)
// ============================================================================

async function initializeTexturePainterV2() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      const response = await fetch(`${WORKER_URL}/check-plan`, {
        headers: { 'Authorization': `Bearer ${session.access_token}` }
      });
      const data = await response.json();
      const plan = data.plan || 'free';

      if (plan === 'studio') {
        maxAllowedResolution = 4096;
        document.querySelector('#texture-resolution-select option[value="2048"]').disabled = false;
        document.querySelector('#texture-resolution-select option[value="4096"]').disabled = false;
      } else if (plan === 'premium') {
        maxAllowedResolution = 2048;
        document.querySelector('#texture-resolution-select option[value="2048"]').disabled = false;
      } else {
        maxAllowedResolution = 1024;
        document.getElementById('resolution-upgrade-hint').style.display = 'block';
      }
    }
  } catch (err) {
    console.error('Failed to check plan:', err);
  }

  setupTexturePainterListeners();
}

function setupTexturePainterListeners() {
  // Resolution
  document.getElementById('texture-resolution-select')
    .addEventListener('change', async (e) => {
      const newRes = parseInt(e.target.value);
      if (!currentPainterMesh) { showToast('No mesh selected'); e.target.value = 1024; return; }
      if (newRes > maxAllowedResolution) { showToast('Upgrade for higher resolutions'); e.target.value = maxAllowedResolution; return; }
      if (isPainterMode) { showToast('Exit texture painter before changing resolution'); e.target.value = meshTextureData[currentPainterMesh]?.resolution || 1024; return; }
      await changeTextureResolution(currentPainterMesh, newRes, materialTargets);
      showToast(`Resolution changed to ${newRes}x${newRes}`);
    });

  // Active texture selector
  document.getElementById('active-texture-select')
    .addEventListener('change', (e) => {
      if (!currentPainterMesh) return;
      selectTexture(currentPainterMesh, e.target.value, materialTargets, (name) => {
        currentTextureName = name;
        updateTextureUI(currentPainterMesh);
        showToast(`Switched to ${meshTextureData[currentPainterMesh].textures[name].name}`);
      });
    });

  // Create new texture
  document.getElementById('create-new-texture-btn')
    .addEventListener('click', () => {
      if (!currentPainterMesh) { showToast('No mesh selected'); return; }
      const meshData = meshTextureData[currentPainterMesh];
      let counter = Object.keys(meshData.textures).filter(k => k.startsWith('custom_')).length + 1;
      const newName = `custom_${counter}`;
      createTextureForMesh(currentPainterMesh, newName, `Custom Texture ${counter}`, true);
      selectTexture(currentPainterMesh, newName, materialTargets, (name) => {
        currentTextureName = name;
        updateTextureUI(currentPainterMesh);
        showToast(`Created Custom Texture ${counter}`);
      });
    });

  // Reset texture
  document.getElementById('reset-texture-btn')
    .addEventListener('click', () => {
      if (!currentPainterMesh || !currentTextureName) return;
      const texData = meshTextureData[currentPainterMesh]?.textures[currentTextureName];
      if (!texData?.isCustom) { showToast('Cannot reset preset textures'); return; }
      if (confirm('Reset this texture? This will clear all painting.')) {
        resetTexture(currentPainterMesh, currentTextureName);
        updateTextureView();
        showToast('Texture reset');
      }
    });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (!isPainterMode) return;
    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(currentPainterMesh, currentTextureName, () => updateTextureView()); }
    if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(currentPainterMesh, currentTextureName, () => updateTextureView()); }
  });

  // Roughness
  document.getElementById('roughness-slider').addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    document.getElementById('roughness-value').textContent = value.toFixed(2);
    if (currentPainterMesh && currentTextureName)
      updateMaterialProperty(currentPainterMesh, currentTextureName, 'roughness', value, materialTargets);
  });

  // Metalness
  document.getElementById('metalness-slider').addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    document.getElementById('metalness-value').textContent = value.toFixed(2);
    if (currentPainterMesh && currentTextureName)
      updateMaterialProperty(currentPainterMesh, currentTextureName, 'metalness', value, materialTargets);
  });
}

function updateTextureUI(meshId) {
  const meshData = meshTextureData[meshId];
  if (!meshData) return;

  const select = document.getElementById('active-texture-select');
  select.innerHTML = '';

  if (Object.keys(meshData.textures).length === 0) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = 'No textures (click + to create)';
    select.appendChild(opt);
  } else {
    Object.entries(meshData.textures).forEach(([key, texData]) => {
      const opt = document.createElement('option');
      opt.value = key; opt.textContent = texData.name;
      if (key === meshData.selectedTexture) opt.selected = true;
      select.appendChild(opt);
    });
  }

  updateResetButtonState();
  document.getElementById('texture-resolution-select').value = meshData.resolution;

  const texData = meshData.textures[meshData.selectedTexture];
  if (texData) {
    document.getElementById('roughness-slider').value    = texData.roughness || 0.5;
    document.getElementById('roughness-value').textContent = (texData.roughness || 0.5).toFixed(2);
    document.getElementById('metalness-slider').value    = texData.metalness || 0.0;
    document.getElementById('metalness-value').textContent = (texData.metalness || 0.0).toFixed(2);
  }
}

function updateResetButtonState() {
  const resetBtn = document.getElementById('reset-texture-btn');
  if (!currentPainterMesh || !currentTextureName) { resetBtn.disabled = true; return; }
  const texData = meshTextureData[currentPainterMesh]?.textures[currentTextureName];
  resetBtn.disabled = !texData?.isCustom;
}

window.addEventListener('DOMContentLoaded', () => {
  initializeTexturePainterV2();
});