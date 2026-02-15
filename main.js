import * as THREE from "three";
import { GLTFLoader } from "https://unpkg.com/three@0.158.0/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "https://unpkg.com/three@0.158.0/examples/jsm/controls/OrbitControls.js";
import { GLTFExporter } from "https://unpkg.com/three@0.158.0/examples/jsm/exporters/GLTFExporter.js";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { initPlansOverlayControls } from "./js/Controls.js";
import { createPreview } from "./js/PreviewRenderer.js";
import { TexturePainter } from "./js/TexturePainter.js";

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
let showUVOverlay = true; // later we’ll toggle this
let uvOpacity = 0.25;
const paintedTextures = {};
const clock = new THREE.Clock();
const blendShapeMap = {};
const morphMeshes = [];
const morphValues = {};
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

    // Rebuild menu with user info + logout
    menu.innerHTML = `
      <span class="user-email">${user.email}</span>
      <button class="dropdown-item" id="logout-btn">Log Out</button>
    `;

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
    badge.style.cssText = "font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;margin-left:4px;vertical-align:middle;";
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
    buildBlendShapeUI();
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

    card.append(preview, name);
    panel.appendChild(card);

    // Fetch blob URL for preview thumbnail only — never cache blob URLs
    getAssetUrl("basemesh", mesh.r2Key).then(url => {
      preview.innerHTML = "";
      createPreview({ container: preview, gltfPath: url });
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
function buildBlendShapeUI() {
  const panel = document.getElementById("blendshape-panel");
  panel.innerHTML = "";

  const keys = Object.keys(blendShapeMap).sort();

  if (keys.length === 0) {
    panel.innerHTML = `
      <p style="color:#888;font-size:13px;">
        This base mesh has no blendshapes.
      </p>
    `;
    return;
  }

  keys.forEach(name => {
    // 🔑 READ CURRENT VALUE FROM MESH
    const entry = blendShapeMap[name][0];
    const currentValue =
      entry.mesh.morphTargetInfluences[entry.index] || 0;

    morphValues[name] = currentValue;

    const row = document.createElement("div");
    row.className = "blend-row";

    const label = document.createElement("label");
    label.textContent = name;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = 0;
    slider.max = 100;
    slider.value = Math.round(currentValue * 100);

    slider.oninput = () => {
      morphValues[name] = slider.value / 100;
    };

    row.append(label, slider);
    panel.appendChild(row);
  });
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
  // FBX export feature - Coming in v0.1.1
  showToast("FBX export available in Premium & Studio plans (coming in v0.1.1)");
  return Promise.resolve();
}

async function exportAnimationAsFBX() {
  // FBX animation export - Coming in v0.1.1
  showToast("FBX export available in Premium & Studio plans (coming in v0.1.1)");
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

window.selectFormat = function(format) {
  // Check if FBX requires premium/studio
  if (format === 'fbx') {
    // TODO: Add plan check when FBX is implemented in v0.1.1
    // For now, just show coming soon message
    showToast("FBX export coming in v0.1.1 - Premium & Studio feature");
    return;
  }
  
  selectedFormat = format;
  document.querySelectorAll('.format-btn').forEach(btn => {
    btn.style.borderColor = 'transparent';
    btn.style.background = '#2a2a2a';
  });
  event.currentTarget.style.borderColor = '#6c63ff';
  event.currentTarget.style.background = '#3a3a3a';
  updateExportButton();
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
    card.className = "base-mesh-card";

    const preview = document.createElement("div");
    preview.className = "preview-canvas";
    preview.innerHTML = "<div style='color:#555;font-size:11px;text-align:center;padding-top:30px'>...</div>";

    const label = document.createElement("div");
    label.className = "base-mesh-name";
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
      createPreview({
        container: preview,
        animationPath: animUrl,
        baseMeshPath: baseMeshUrl,
        autoRotate: false
      });
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
document
  .getElementById("open-texture-painter")
  .addEventListener("click", () => {

    const target = materialTargets[activeMaterialTarget];
    if (!target) {
      alert("No material selected");
      return;
    }

    // FIRST mesh of the material target
    painterTargetMesh = target.meshes[0];
    if (!painterTargetMesh) {
      alert("No mesh found for this material");
      return;
    }

    const material = painterTargetMesh.material;
    if (!material) {
      alert("Mesh has no material");
      return;
    }

    const key = activeMaterialTarget;

    // ---------------------------------------
    // CREATE OR RESTORE PAINT DATA PER TARGET
    // ---------------------------------------

    if (!paintedTextures[key]) {
      // Create OFFSCREEN canvas (REAL texture)
      const offscreenCanvas = document.createElement("canvas");
      const PAINT_RESOLUTION = 1024;
      offscreenCanvas.width = PAINT_RESOLUTION;
      offscreenCanvas.height = PAINT_RESOLUTION;

      const ctx = offscreenCanvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
ctx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);


      // If material already has a texture, copy it ONCE
      if (material.map?.image) {
        try {
          ctx.drawImage(
            material.map.image,
            0,
            0,
            offscreenCanvas.width,
            offscreenCanvas.height
          );
        } catch (e) {
          // ignore CORS or image errors
        }
      }

      const texture = new THREE.CanvasTexture(offscreenCanvas);
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      paintedTextures[key] = {
        canvas: offscreenCanvas,
        texture
      };

      material.map = texture;
      material.needsUpdate = true;
      showToast("Painter texture re-applied");
    }

    // ---------------------------------------
    // RESTORE STORED CANVAS + TEXTURE
    // ---------------------------------------

    const { canvas: storedCanvas, texture } = paintedTextures[key];

    material.map = texture;
    material.needsUpdate = true;
    painterCanvas = storedCanvas;

    // ---------------------------------------
    // CREATE PAINTER (NO TEXTURE OWNERSHIP)
    // ---------------------------------------

    texturePainter = new TexturePainter({
      canvas: painterCanvas,
      mesh: painterTargetMesh,
      material,
      texture
    });

    // ---------------------------------------
    // SETUP CANVAS DRAW EVENTS (ONCE)
    // ---------------------------------------

    const uiCanvas = document.getElementById("texture-canvas");

    // sync UI canvas size
    uiCanvas.width = painterCanvas.width;
    uiCanvas.height = painterCanvas.height;

    let isPaintingLocal = false;

uiCanvas.onpointerdown = e => {
  const { x, y } = getTextureCoordsFromMouse(e, uiCanvas);

  isPaintingLocal = true;
  texturePainter.startDraw(x, y);
};


uiCanvas.onpointermove = e => {
  if (!isPaintingLocal) return;

  const { x, y } = getTextureCoordsFromMouse(e, uiCanvas);
  texturePainter.draw(x, y);
  updateTextureView();
};


    window.onpointerup = () => {
      if (!isPaintingLocal) return;
      isPaintingLocal = false;
      texturePainter.endDraw();
    };
    texZoom = 1;
    texOffsetX = 0;
    texOffsetY = 0;
// ---------------------------------------
// LOAD UV OVERLAY (LOCKED PREVIEW)
// ---------------------------------------

uvOverlayImage = null;

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
  toggleUVBtn.classList.toggle("active", showUVOverlay);
  uvOpacitySlider.value = uvOpacity ;
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

document.querySelectorAll(".tool-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (!texturePainter) return;

    const tool = btn.dataset.tool;

    // UI active state
    document
      .querySelectorAll(".tool-btn")
      .forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    // Tell painter
    texturePainter.setTool(tool);
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
const launchCTA = document.querySelector("#launch-overlay .open-plans");

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
  
  if (launchCTA) {
    launchCTA.addEventListener("click", () => {
      closeLaunchOverlay();

      // Open plans overlay manually
      const plansOverlay = document.getElementById("plans-overlay");
      if (plansOverlay) {
        plansOverlay.classList.remove("hidden");
        document.body.style.overflow = "hidden";
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

document.getElementById("google-auth").addEventListener("click", async () => {
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin
    }
  });
});


document.getElementById("github-auth").addEventListener("click", async () => {
  await supabase.auth.signInWithOAuth({
    provider: "github",
    options: {
      redirectTo: window.location.origin
    }
  });
});
supabase.auth.onAuthStateChange((event, session) => {
  updateUserMenu(session ?? null);
});
