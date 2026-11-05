import * as THREE from "three";
import { GLTFLoader } from "https://esm.sh/three@0.158.0/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "https://esm.sh/three@0.158.0/examples/jsm/controls/OrbitControls.js";
import { GLTFExporter } from "https://esm.sh/three@0.158.0/examples/jsm/exporters/GLTFExporter.js";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { PresetOverlay } from "./js/PresetOverlay.js?v=20261105-preview-fix-2";
import { PresetSystem } from "./js/PresetSystem.js";
import { createPreview } from "./js/PreviewRenderer.js?v=20261105-preview-fix-2";
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


const WORKER_URL = "https://morphara.maroukayuob.workers.dev";


let BASE_MESHES = [];
let CLOTHES     = [];
let ANIMATIONS  = [];
let TEXTURE_PRESETS = {};
let TEXTURES = [];



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


let presetOverlay;
let presetSystem;


let currentPainterMesh = null;
let currentTextureName = null;
let maxAllowedResolution = 1024;
let painterControls = null;


let canvasMouseX = null;
let canvasMouseY = null;

const paintedTextures = {};
const clock = new THREE.Clock();
const blendShapeMap = {};
const morphMeshes = [];
const morphValues = {};


const activePreviews = new Map();
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

const SUPABASE_URL = "https://yjrqcmzkmfawwsppmnkl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_fIkpyaJmmkNhcB1HOeRrKw_xZ0c0miD";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


let sessionStartTime = Date.now();

let loadedClothingMeshes = {};



async function checkSession() {
  const { data: { session } } = await supabase.auth.getSession();


  if (window.posthog) {
    posthog.capture('app_loaded', {
      url: window.location.href,
      referrer: document.referrer,
      user_agent: navigator.userAgent,
      screen_width: window.innerWidth,
      screen_height: window.innerHeight
    });
  }

  if (session) {

    if (window.posthog) {
      posthog.identify(session.user.id, {
        email: session.user.email,
        user_id: session.user.id
      });
      posthog.capture('session_started', {
        user_id: session.user.id
      });
    }
    updateUserMenu(session);
    showToast("Welcome back 🎉");
  } else {

    if (window.posthog) {
      posthog.capture('session_guest');
    }
  }
}

checkSession();


function updateUserMenu(session) {
  const menu = document.getElementById("user-menu");
  const userBtn = document.getElementById("user-btn");

  if (session) {
    const user = session.user;
    const initial = (user.email?.[0] ?? "U").toUpperCase();


    userBtn.textContent = initial;
    userBtn.title = user.email;


    menu.innerHTML = `
      <span class="user-email">${user.email}</span>
      <button class="dropdown-item" id="my-characters-btn">📦 My Characters</button>
      <button class="dropdown-item" id="settings-btn">⚙️ Settings</button>
      <button class="dropdown-item" id="logout-btn">Log Out</button>
    `;

    document.getElementById("settings-btn").addEventListener("click", () => {
      if (window.posthog) {
        posthog.capture('settings_opened');
      }
      document.getElementById("user-menu").classList.add("hidden");
      const so = document.getElementById("settings-overlay");
      so.style.display = "flex";

      const emailEl = document.getElementById("settings-email");
      if (emailEl) emailEl.textContent = user.email;
      const createdEl = document.getElementById("settings-created");
      if (createdEl) createdEl.textContent = user.created_at ? new Date(user.created_at).toLocaleDateString() : "-";
      const verifiedEl = document.getElementById("settings-verified");
      if (verifiedEl) verifiedEl.textContent = user.email_confirmed_at ? "Verified" : "Pending verification";
      loadAccountSummary(session);
    });

    document.getElementById("my-characters-btn").addEventListener("click", () => {
      document.getElementById("user-menu").classList.add("hidden");
      openPurchasedCharacters();
    });

    document.getElementById("logout-btn").addEventListener("click", async () => {
      if (window.posthog) {
        const sessionDuration = Date.now() - sessionStartTime;
        posthog.capture('logout_clicked', {
          session_duration_ms: sessionDuration
        });
      }
      await supabase.auth.signOut();

    });


    handleCharacterPurchaseReturn(session);

  } else {

    userBtn.textContent = "👤";
    userBtn.title = "";

    menu.innerHTML = `
      <button class="dropdown-item" data-auth-open="signup">Sign Up</button>
      <button class="dropdown-item" data-auth-open="login">Log In</button>
    `;


    menu.querySelectorAll("[data-auth-open]").forEach(btn => {
      btn.addEventListener("click", () => {
        authMode = btn.dataset.authOpen;
        updateAuthUI();
        document.getElementById("auth-overlay").classList.remove("hidden");
        menu.classList.add("hidden");
      });
    });


  }
}


async function loadAccountSummary(session) {
  const countEl = document.getElementById("settings-character-count");
  const totalEl = document.getElementById("settings-total-spent");
  if (!countEl || !totalEl) return;
  countEl.textContent = "Loading…";
  totalEl.textContent = "Loading…";
  const { data, error } = await supabase
    .from("character_purchases")
    .select("amount_cents,currency")
    .eq("user_id", session.user.id)
    .eq("status", "paid");
  if (error) {
    countEl.textContent = "Unavailable";
    totalEl.textContent = "Unavailable";
    console.warn("Account purchase summary failed:", error.message);
    return;
  }
  countEl.textContent = String(data?.length || 0);
  const cents = (data || []).reduce((sum, row) => sum + (Number(row.amount_cents) || 0), 0);
  totalEl.textContent = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cents / 100);
}







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
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/html")) {
    throw new Error(`Got HTML instead of GLB for ${filename} — Cloudflare error page`);
  }

  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
async function loadAllAssets() {
  const panel = document.getElementById("basemesh-panel");
  panel.innerHTML = "<p style='color:#888;font-size:13px;padding:16px'>Loading assets...</p>";

  try {
    const { data: assets, error } = await supabase
      .from("assets")
      .select("id, name, type, r2_key, compatible_mesh, uv_map")
      .order("name");

    if (error) throw error;


    BASE_MESHES = assets
      .filter(a => a.type === "basemesh")
      .map(a => ({
        id:            a.id,
        name:          a.name,
        r2Key:         a.r2_key,
        uv_map:        a.uv_map,

      }));


    const clothingTypes = ["shirts","pants","shoes","gloves","hair",
                           "accessories","headwear","glasses","facialHair","jacket"];
    CLOTHES = assets
      .filter(a => clothingTypes.includes(a.type))
      .map(a => {

        let materialDomain = "fabric";

        if (a.type === "hair" || a.type === "facialHair") {
          materialDomain = "hair";
        } else if (a.type === "glasses") {
          materialDomain = "glass";
        } else if (a.type === "accessories") {

          materialDomain = "metal";
        } else if (a.type === "shoes") {
          materialDomain = "leather";
        } else {

          materialDomain = "fabric";
        }

        return {
          id:             a.id,
          name:           a.name,
          category:       a.type,
          baseMesh:       a.compatible_mesh,
          r2Key:          a.r2_key,
          materialDomain: materialDomain,
          uv_map:         a.uv_map
        };
      });


    ANIMATIONS = assets
      .filter(a => a.type === "animation")
      .map(a => ({
        id:       a.id,
        name:     a.name,
        baseMesh: a.compatible_mesh,
        r2Key:    a.r2_key,
        loop:     true
      }));


    const { data: textureAssets, error: textureError } = await supabase
      .from("textures")
      .select("*")
      .order("name");

    if (textureError) {
      console.error("Failed to load textures:", textureError);
    } else {
      TEXTURE_PRESETS = {};
      TEXTURES = textureAssets || [];
      for (const t of textureAssets) {
        const domain = t.material_domain || "fabric";
        if (!TEXTURE_PRESETS[domain]) TEXTURE_PRESETS[domain] = [];

        TEXTURE_PRESETS[domain].push({
          id:              t.id,
          label:           t.name,
          r2Key:           t.r2_key,
          r2KeyNormal:     t.r2_key_normal,
          r2KeyMetallic:   t.r2_key_metallic,
          r2KeyRoughness:  t.r2_key_roughness,
          r2KeyAO:         t.r2_key_ao,
          compatibleMesh:  t.compatible_mesh,
          map:             null
        });
      }
    }


    buildBaseMeshUI();
    document.getElementById("editor-status-text").textContent = BASE_MESHES.length + " base meshes · Choose one to begin";

  } catch (err) {
    console.error("Failed to load assets:", err);
    panel.innerHTML = '<p class="studio-error">The asset library could not load. Check your connection and try again.</p><button id="retry-library" type="button">Retry loading</button>';
    panel.querySelector('#retry-library').addEventListener('click', loadAllAssets);
    document.getElementById('editor-status-text').textContent = 'Library unavailable · Retry in the library panel';
  }
}



async function initPresetSystem() {
  presetSystem = new PresetSystem({ supabase });

  presetOverlay = new PresetOverlay({
    supabase,

    WORKER_URL: WORKER_URL,
    getAssetUrl: getAssetUrl,
    THREE: THREE,
    GLTFLoader: GLTFLoader,

    onLoadPreset: async (preset) => {
      await loadPresetCharacter(preset);
    },
    onStartScratch: () => {
      console.log("Starting from scratch");
    }
  });

  await presetOverlay.init();
}
async function loadPresetCharacter(preset) {
  try {
    showToast("Loading preset...");

    const config = preset.config;
    console.log("=== LOADING PRESET ===");
    console.log("Config:", config);


    if (config.baseMesh) {
      const mesh = BASE_MESHES.find(m => m.r2Key === config.baseMesh.r2Key);
      if (mesh) {
        await new Promise(resolve => loadBaseMesh(mesh, resolve));
        await new Promise(r => setTimeout(r, 1000));
      }
    }


    if (config.blendShapes) {
      Object.entries(config.blendShapes).forEach(([name, value]) => {
        morphValues[name] = value;
      });

      Object.entries(morphValues).forEach(([name, value]) => {
        if (blendShapeMap[name]) {
          blendShapeMap[name].forEach(({ mesh, index }) => {
            if (mesh.morphTargetInfluences) {
              mesh.morphTargetInfluences[index] = value;
            }
          });
        }
      });

      buildCategorizedBlendShapesUI();
    }


    if (config.clothing) {

      const clothingToEquip = Object.entries(config.clothing)
        .filter(([category, item]) => item && item.r2Key);

      for (const [category, item] of clothingToEquip) {
        const clothingItem = CLOTHES.find(c => c.r2Key === item.r2Key);

        if (clothingItem) {
          await equipClothing(clothingItem);
          await new Promise(r => setTimeout(r, 500));
        }
      }
      rebuildMaterialTargets();


      await new Promise(r => setTimeout(r, 500));


      Object.entries(morphValues).forEach(([name, value]) => {
        if (blendShapeMap[name]) {
          blendShapeMap[name].forEach(({ mesh, index }) => {
            if (mesh.morphTargetInfluences) {
              mesh.morphTargetInfluences[index] = value;
            }
          });
        }
      });
    }


    if (config.textures) {

      for (const [materialKey, texture] of Object.entries(config.textures)) {
        if (!texture || !texture.r2Key) {
          continue;
        }


        if (!materialTargets[materialKey]) {
          continue;
        }

        const textureData = TEXTURES.find(t => t.r2_key === texture.r2Key);

        if (textureData) {
          activeMaterialTarget = materialKey;

          const texturePreset = {
            id: textureData.id,
            label: textureData.name,
            r2Key: textureData.r2_key,
            r2Key_normal: textureData.r2_key_normal,
            r2Key_metallic: textureData.r2_key_metallic,
            r2Key_roughness: textureData.r2_key_roughness,
            r2Key_ao: textureData.r2_key_ao,
            compatibleMesh: textureData.compatible_mesh,
            material_domain: textureData.material_domain
          };

          try {
            await applyTexturePreset(texturePreset);
            await new Promise(r => setTimeout(r, 300));
          } catch (error) {
          }
        } else {
        }
      }
    }


    if (config.colors) {
      console.log("\n=== APPLYING COLORS ===");


      await new Promise(r => setTimeout(r, 1000));

      Object.entries(config.colors).forEach(([key, colorHex]) => {
        const target = materialTargets[key];
        if (!target) {
          console.warn(`⚠ No target for ${key}`);
          return;
        }

        console.log(`✓ Applying ${colorHex} to ${key}`);

        target.meshes.forEach(mesh => {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach(mat => {
            if (mat?.color) {
              mat.color.set(colorHex);
              mat.needsUpdate = true;
            }
          });
        });
      });

      console.log("✓ Colors applied");
    }


    if (config.materials) {

      Object.entries(config.materials).forEach(([key, props]) => {
        const target = materialTargets[key];

        if (!target) {
          return;
        }
        target.meshes.forEach(mesh => {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach(mat => {
            if (mat) {
              if (props.roughness !== undefined) mat.roughness = props.roughness;
              if (props.metalness !== undefined) mat.metalness = props.metalness;
              mat.needsUpdate = true;
            }
          });
        });
      });
    }
    showToast(`✅ Loaded: ${preset.name}`);

  } catch (error) {
    showToast(`Failed to load preset: ${error.message}`);
  }
}
async function saveCurrentAsOfficialPreset(metadata) {
  try {
    showToast("Saving preset...");

    const config = presetSystem.captureState({
      currentBaseMesh,
      morphValues,
      equippedClothes,
      loadedClothingMeshes,
      materialTargets,
    });

    const validation = presetSystem.validateConfig(config);
    if (!validation.valid) {
      showToast(`Invalid: ${validation.errors.join(', ')}`);
      return;
    }

    const result = await presetSystem.saveAsOfficialPreset(config, metadata);

    if (result.success) {
      showToast(`✅ Saved: ${metadata.name}`);
    } else {
      showToast(`Failed: ${result.error}`);
    }
  } catch (error) {
    showToast("Failed to save preset");
  }
}


window.savePreset = function(name, description, category = 'casual', tags = []) {
  saveCurrentAsOfficialPreset({ name, description, category, tags });
};


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

  topButtons.forEach(b => b.classList.remove("active"));
  document
    .querySelector(`.top-btn[data-mode="${mode}"]`)
    ?.classList.add("active");


  allPanels.forEach(id => {
    const panel = document.getElementById(id);
    if (panel) panel.classList.remove("active");
  });


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
  if (currentBaseMesh) updateCategoryCounts(currentBaseMesh.id);
}


  if (window.posthog) {
    const eventMap = {
      'base': 'base_mesh_panel_opened',
      'clothes': 'clothing_panel_opened',
      'customize': 'blendshape_panel_opened',
      'materials': 'material_panel_opened',
      'animations': 'animation_panel_opened',
      'randomizer': 'randomizer_panel_opened'
    };

    if (eventMap[mode]) {
      posthog.capture(eventMap[mode], { panel: mode });
    }
  }
}

window.addEventListener('DOMContentLoaded', async () => {

  init();


  animate();


  await loadAllAssets();


  setUIMode("base");


  initializeTexturePainterV2();


  try { await initPresetSystem(); } catch (error) { console.error('Preset startup failed', error); document.getElementById('preset-overlay').style.display = 'none'; showToast('Presets could not load. You can still use the base mesh library.'); }
});


function init() {

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x161c27);

  camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.01,
    1000
  );
  camera.position.set(0, 1.5, 3);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.getElementById("viewport").appendChild(renderer.domElement);

  setupLights();
  setupControls();
  addGroundGrid();

  loader = new GLTFLoader();

  window.addEventListener("resize", onResize);
  onResize();
  animate();
}

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


async function loadBaseMesh(meshData, onLoaded = null) {
  if (!meshData) return;


  if (window.posthog) {
    posthog.capture('base_mesh_clicked', {
      mesh_id: meshData.id,
      mesh_name: meshData.name,
      mesh_key: meshData.r2Key
    });
  }

  resetClothingUI();


  Object.keys(meshTextureData).forEach(meshId => {
    delete meshTextureData[meshId];
  });

  currentBaseMesh = meshData;


  document.querySelectorAll(".base-mesh-card").forEach(c => {
    c.classList.toggle("active", c.dataset.id === meshData.id);
  });


  updateCategoryCounts(meshData.r2Key);

  try {
    const url = await getAssetUrl("basemesh", meshData.r2Key);
    loader.load(
      url,
      gltf => {
        onModelLoaded(gltf);


        if (window.posthog) {
          posthog.capture('base_mesh_loaded', {
            mesh_id: meshData.id,
            mesh_name: meshData.name,
            success: true
          });
        }

        if (onLoaded) onLoaded();
      },
      undefined,
      err => {
        console.error("Failed to load GLB:", err?.message || err);
        showToast("Failed to load mesh — please try again");


        if (window.posthog) {
          posthog.capture('base_mesh_load_failed', {
            mesh_id: meshData.id,
            mesh_name: meshData.name,
            error: err?.message || 'Unknown error'
          });
        }

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
  document.getElementById("stage-empty").hidden = true;
  document.getElementById("editor-status-text").textContent = "Character ready · " + (currentBaseMesh?.name || "Untitled");
  frameCameraToObject(currentModel);
  rebuildMaterialTargets();
}

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











function categorizeBlendShapes(blendShapeNames) {
  const categories = {};
  const specialCategories = ['Gender'];

  blendShapeNames.forEach(name => {
    let category = 'Other';


    if (specialCategories.includes(name)) {
      category = name;
    } else if (name.includes('_')) {

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


  const allNames = [];
  for (const [name] of Object.entries(blendShapeMap)) {
    allNames.push(name);

    if (morphValues[name] === undefined) {
      morphValues[name] = 0;
    }
  }

  if (allNames.length === 0) {
    panel.innerHTML = '<p style="color: #888; padding: 20px; text-align: center;">No blend shapes available</p>';
    return;
  }


  const categorized = categorizeBlendShapes(allNames);


  if (categorized['Gender']) {
    renderBlendShapeCategory(panel, 'Gender', categorized['Gender'], true);
    delete categorized['Gender'];
  }


  const sortedCategories = Object.keys(categorized).sort();
  sortedCategories.forEach(categoryName => {
    renderBlendShapeCategory(panel, categoryName, categorized[categoryName], false);
  });

  console.log(`✅ Built categorized blend shapes: ${sortedCategories.length} categories`);
}




function renderBlendShapeCategory(panel, categoryName, blendShapeNames, isSpecial = false) {

  const categoryDiv = document.createElement('div');
  categoryDiv.className = `blend-category${isSpecial ? ' special' : ''} collapsed`;


  const header = document.createElement('div');
  header.className = 'blend-category-header';

  const iconUrl = getBlendShapeCategoryIcon(categoryName);

  header.innerHTML = `
    <img src="${iconUrl}" class="blend-category-icon" onerror="this.style.display='none'" alt="${categoryName}">
    <span class="blend-category-name">${categoryName}</span>
    <span class="blend-category-chevron">▼</span>
  `;


  const content = document.createElement('div');
  content.className = 'blend-category-content';


  blendShapeNames.forEach(shapeName => {
    const sliderItem = createBlendShapeSliderItem(shapeName);
    content.appendChild(sliderItem);
  });


  header.addEventListener('click', () => {
    categoryDiv.classList.toggle('collapsed');
  });


  categoryDiv.appendChild(header);
  categoryDiv.appendChild(content);
  panel.appendChild(categoryDiv);
}




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


const clothesCategoryButtons = document.querySelectorAll(".clothes-category");
const clothesItemsTitle = document.getElementById("clothes-items-title");
const clothesItemsGrid = document.querySelector(".clothes-items-grid");
const clothesItemsPanel = document.getElementById("clothes-items-panel");

clothesCategoryButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const category = btn.dataset.category;


    if (window.posthog) {
      posthog.capture('clothing_category_clicked', {
        category: category,
        base_mesh: currentBaseMesh?.name || 'none',
        item_count: CLOTHES.filter(c => c.baseMesh === currentBaseMesh?.r2Key && c.category === category).length
      });
    }

    clothesCategoryButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    clothesItemsPanel.classList.add("active");
    clothesItemsTitle.textContent = category;

    buildClothingList(category);
  });
});


function updateCategoryCounts(baseMeshId) {
  const categories = ["shirts", "jacket", "pants", "shoes", "gloves", "hair", "facialHair", "headwear", "glasses", "accessories"];

  categories.forEach(category => {
    const count = CLOTHES.filter(c =>
      c.baseMesh === baseMeshId && c.category === category
    ).length;


    const button = document.querySelector(`.clothes-category[data-category="${category}"]`);
    if (button) {
      const countSpan = button.querySelector('.item-count');
      if (countSpan) {
        countSpan.textContent = `(${count})`;


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


    getAssetUrl(item.category, item.r2Key).then(url => {
      preview.innerHTML = "";
      createPreview({ container: preview, gltfPath: url });
    }).catch(() => {
      preview.innerHTML = "<div style='color:#555;font-size:11px;text-align:center'>N/A</div>";
    });

    card.dataset.itemId = item.id;
    card.onclick = () => {

      panel.querySelectorAll(".clothing-card, .clothing-card-none")
        .forEach(c => c.classList.remove("active"));
      card.classList.add("active");
      equipClothing(item);
    };
    panel.appendChild(card);
  });


  const equipped = equippedClothes[category];
  if (equipped) {
    const activeCard = panel.querySelector(`[data-item-id="${equipped.id}"]`);
    activeCard?.classList.add("active");
  } else {
    panel.querySelector(".clothing-card-none")?.classList.add("active");
  }
}
async function equipClothing(item) {

  if (window.posthog) {
    posthog.capture('clothing_item_clicked', {
      item_id: item.id,
      item_name: item.name,
      category: item.category,
    });
  }


  if (equippedClothes[item.category]) {
    unequipClothing(item.category);
  }


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


    if (window.posthog) {
      posthog.capture('clothing_equip_failed', {
        item_id: item.id,
        item_name: item.name,
        category: item.category,
        error: err?.message || 'Unknown error'
      });
    }

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

      obj.bind(characterSkeleton, bindMatrix);
      obj.frustumCulled = false;
    }
  });

  currentModel.add(clothingRoot);

collectBlendShapesFromObject(clothingRoot);

Object.entries(morphValues).forEach(([name, value]) => {
  blendShapeMap[name]?.forEach(({ mesh, index }) => {
    mesh.morphTargetInfluences[index] = value;
  });
});

equippedClothes[item.category] = item.id;
  loadedClothingMeshes[item.id] = {
    root: clothingRoot,
    materialDomain: item.materialDomain || "fabric",
    r2Key: item.r2Key,
    name: item.name,
    category: item.category,
    clothing: item
};


  if (window.posthog) {
    posthog.capture('clothing_equipped', {
      item_id: item.id,
      item_name: item.name,
      category: item.category,
      base_mesh: currentBaseMesh?.name,
    });
  }
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



const exportBtn = document.getElementById("export-btn");
let pendingExportAfterSignIn = false;

if (exportBtn) {
  exportBtn.addEventListener("click", async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      pendingExportAfterSignIn = true;
      authMode = "login";
      updateAuthUI();
      document.getElementById("auth-overlay")?.classList.remove("hidden");
      return;
    }

    if (window.posthog) {
      posthog.capture('export_panel_opened', {
        base_mesh: currentBaseMesh?.name,
        has_clothes: Object.values(equippedClothes).some(c => c !== null),
        has_animation: activeAction !== null
      });
    }

  if (!currentBaseMesh) {
    showToast("Select a base mesh first");
    return;
  }

  selectedExportType = null;
  selectedFormat = null;
  document.getElementById("export-panel-overlay").classList.remove("hidden");
  await refreshCharacterPrice();
  updateExportButton();
  renderExportPreview();
  });
} else {
  console.warn("Export button not found - check HTML");
}

function renderExportPreview() {
  const container = document.getElementById("export-preview-container");
  if (!container || !currentModel) return;


  container.innerHTML = "";


  const previewScene = new THREE.Scene();
  previewScene.background = new THREE.Color(0x1e1e1e);


  const modelClone = currentModel.clone(true);


  modelClone.traverse(obj => {
    if (obj.isSkinnedMesh && obj.morphTargetInfluences) {
      const original = currentModel.getObjectByProperty('uuid', obj.uuid);
      if (original?.morphTargetInfluences) {
        obj.morphTargetInfluences = [...original.morphTargetInfluences];
      }
    }
  });

  previewScene.add(modelClone);


  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  previewScene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 10, 7.5);
  previewScene.add(dirLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
  fillLight.position.set(-5, 0, -5);
  previewScene.add(fillLight);


  const previewCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);


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


  const previewRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  previewRenderer.setSize(400, 400);
  previewRenderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(previewRenderer.domElement);


  let animFrameId;
  function animatePreview() {
    animFrameId = requestAnimationFrame(animatePreview);
    modelClone.rotation.y += 0.005;
    previewRenderer.render(previewScene, previewCamera);
  }
  animatePreview();


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

let exportInProgress = false;
async function handleExport(type, format) {
  if (format === 'fbx') { showToast('FBX conversion is temporarily disabled. Choose GLB or GLTF.'); return; }
  if (!['glb', 'gltf'].includes(format) || !['full', 'animation'].includes(type)) return;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    pendingExportAfterSignIn = true;
    authMode = "login";
    updateAuthUI();
    document.getElementById("export-panel-overlay")?.classList.add("hidden");
    document.getElementById("auth-overlay")?.classList.remove("hidden");
    showToast("Sign in to export your character or animation.");
    return;
  }
  if (!currentModel || !currentBaseMesh) { showToast('Choose a character before exporting.'); return; }
  if (type === 'animation' && !activeAction) { showToast('Select an animation before exporting.'); return; }
  if (exportInProgress) return;
  exportInProgress = true;
  updateExportButton();
  try { await performExport(type, format); } finally {
    exportInProgress = false;
    updateExportButton();
  }
}
async function performExport(type, format) {
  const overlay = document.getElementById("export-panel-overlay");
  const content = overlay?.querySelector(".export-panel-content");
  if (content) {
    content.style.opacity = "0.55";
    content.style.pointerEvents = "none";
  }
  try {
    if (type === "full") {
      await purchaseCurrentCharacter();
    } else {
      await exportAnimationOnly(format);
      showToast(`Animation exported as ${format.toUpperCase()} — free to download.`);
      overlay?.classList.add("hidden");
    }
  } catch (error) {
    console.error("Export or purchase error:", error);
    showToast(error.message || "Could not complete this action. Please try again.", 3500);
  } finally {
    if (content) {
      content.style.opacity = "1";
      content.style.pointerEvents = "auto";
    }
  }
}

async function purchaseCurrentCharacter() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    document.getElementById("auth-overlay")?.classList.remove("hidden");
    throw new Error("Sign in to buy and save a character.");
  }
  if (!currentModel || !currentBaseMesh) throw new Error("Choose a character before purchasing.");

  const blob = await exportAsGLTF("glb", true, false);
  const configuration = presetSystem.captureState({
    currentBaseMesh,
    morphValues,
    equippedClothes,
    loadedClothingMeshes,
    materialTargets
  });
  configuration.selectedAnimation = activeAction?.getClip()?.name || null;
  configuration.outputFormat = "glb";
  configuration.paintedTextureHashes = await getPaintedTextureHashes();

  const prepareResponse = await fetch(`${WORKER_URL}/prepare-character-purchase`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({
      baseMeshId: currentBaseMesh.id,
      characterName: `Customized ${currentBaseMesh.name}`,
      configuration
    })
  });
  const purchase = await prepareResponse.json();
  if (!prepareResponse.ok) throw new Error(purchase.error || "Could not prepare this character.");

  if (purchase.alreadyPurchased) {
    await downloadPurchasedCharacter(purchase.purchaseId);
    showToast("You already own this character. Downloaded it again.", 3500);
    document.getElementById("export-panel-overlay")?.classList.add("hidden");
    return;
  }

  const { error: uploadError } = await supabase.storage
    .from("character-purchases")
    .upload(purchase.filePath, blob, { contentType: "model/gltf-binary", upsert: false, cacheControl: "3600" });
  if (uploadError) throw new Error(`Could not save your character: ${uploadError.message}`);

  if (purchase.freeCharacter) {
    const completeResponse = await fetch(`${WORKER_URL}/complete-free-character`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ purchaseId: purchase.purchaseId })
    });
    const completed = await completeResponse.json();
    if (!completeResponse.ok) throw new Error(completed.error || "Could not save your first character.");
    document.getElementById("export-panel-overlay")?.classList.add("hidden");
    showToast("Your first character is saved to My Characters.", 4000);
    await downloadPurchasedCharacter(purchase.purchaseId);
    return;
  }

  const checkoutResponse = await fetch(`${WORKER_URL}/character-purchase-checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ purchaseId: purchase.purchaseId })
  });
  const checkout = await checkoutResponse.json();
  if (!checkoutResponse.ok || !checkout.url) throw new Error(checkout.error || "Could not start secure checkout.");
  window.location.assign(checkout.url);
}

async function getPaintedTextureHashes() {
  const hashes = {};
  for (const [meshId, meshData] of Object.entries(meshTextureData)) {
    for (const [textureName, textureData] of Object.entries(meshData.textures || {})) {
      if (!textureData.canvas) continue;
      const blob = await new Promise(resolve => textureData.canvas.toBlob(resolve, "image/png"));
      if (!blob) continue;
      const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      hashes[`${meshId}:${textureName}`] = fingerprint;
    }
  }
  return hashes;
}

window.handleExport = handleExport;


async function exportAnimationOnly(format) {
  return exportAnimationAsGLTF(format);
}
async function exportAsGLTF(format, includeModel = true, shouldDownload = true) {
  return new Promise(async (resolve, reject) => {
    const exporter = new GLTFExporter();
    const modelToExport = currentModel;
    const options = {
      binary: format === "glb",
      trs: false,
      onlyVisible: true,
      embedImages: true,
      includeCustomExtensions: true,
      animations: activeAction ? [activeAction.getClip()] : []
    };

    exporter.parse(
      modelToExport,
      result => {
        try {
          let blob;
          const filename = `morphara_${currentBaseMesh?.id || "character"}.${format}`;

          if (format === "glb") {
            blob = new Blob([result], { type: "model/gltf-binary" });
          } else {
            blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
          }

          if (shouldDownload) downloadBlob(blob, filename);
          resolve(blob);
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
    let firstMesh;
    currentModel.traverse(child => { if (!firstMesh && child.isSkinnedMesh) firstMesh = child; });
    if (!firstMesh?.skeleton?.bones.length) { reject(new Error('No animation skeleton found')); return; }
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

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

async function downloadPurchasedCharacter(purchaseId) {
  const { data: purchase, error: purchaseError } = await supabase
    .from("character_purchases")
    .select("id,character_name,file_path,status")
    .eq("id", purchaseId)
    .eq("status", "paid")
    .single();
  if (purchaseError || !purchase) throw new Error("This character is not ready to download yet.");

  const safeName = (purchase.character_name || "Morphara Character").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80);
  const { data, error } = await supabase.storage
    .from("character-purchases")
    .createSignedUrl(purchase.file_path, 60, { download: `${safeName}.glb` });
  if (error || !data?.signedUrl) throw new Error(error?.message || "Could not create a download link.");
  window.location.assign(data.signedUrl);
}

async function openPurchasedCharacters() {
  const overlay = document.getElementById("purchases-overlay");
  const list = document.getElementById("purchases-list");
  if (!overlay || !list) return;
  overlay.classList.remove("hidden");
  list.innerHTML = "";

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    list.textContent = "Sign in to view characters you have purchased.";
    document.getElementById("auth-overlay")?.classList.remove("hidden");
    return;
  }

  list.textContent = "Loading your characters…";
  const { data: purchases, error } = await supabase
    .from("character_purchases")
    .select("id,character_name,base_mesh_id,amount_cents,currency,created_at,file_path,status")
    .eq("status", "paid")
    .order("created_at", { ascending: false });
  list.innerHTML = "";
  if (error) {
    list.textContent = "Your library could not load. Please try again.";
    console.error("Purchased character library failed:", error);
    return;
  }
  if (!purchases?.length) {
    list.textContent = "No saved characters yet. Finished characters will stay here so you can view or download them again.";
    return;
  }

  purchases.forEach(purchase => {
    const row = document.createElement("article");
    row.className = "purchase-item";
    const detail = document.createElement("div");
    const name = document.createElement("h3");
    name.textContent = purchase.character_name || "Customized Character";
    const date = document.createElement("p");
    date.textContent = purchase.created_at ? new Date(purchase.created_at).toLocaleDateString() : "Purchased";
    detail.append(name, date);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "purchase-download-btn";
    button.textContent = "Download GLB";
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Preparing…";
      try {
        await downloadPurchasedCharacter(purchase.id);
      } catch (downloadError) {
        showToast(downloadError.message, 3500);
        button.disabled = false;
        button.textContent = "Download GLB";
      }
    });
    const viewButton = document.createElement("button");
    viewButton.type = "button";
    viewButton.className = "purchase-view-btn";
    viewButton.textContent = "View";
    viewButton.addEventListener("click", () => viewPurchasedCharacter(purchase.id));
    row.append(detail, viewButton, button);
    list.appendChild(row);
  });
}

async function viewPurchasedCharacter(purchaseId) {
  const { data: purchase, error } = await supabase
    .from("character_purchases")
    .select("file_path,character_name")
    .eq("id", purchaseId)
    .eq("status", "paid")
    .single();
  if (error || !purchase) { showToast("Could not load this character."); return; }
  const { data, error: urlError } = await supabase.storage
    .from("character-purchases")
    .createSignedUrl(purchase.file_path, 60);
  if (urlError || !data?.signedUrl) { showToast(urlError?.message || "Could not open this character."); return; }
  const overlay = document.getElementById("character-viewer-overlay");
  const canvasHost = document.getElementById("character-viewer-canvas");
  const title = document.getElementById("character-viewer-title");
  if (!overlay || !canvasHost) return;
  title.textContent = purchase.character_name || "Saved Character";
  overlay.classList.remove("hidden");
  if (canvasHost._cleanup) canvasHost._cleanup();
  canvasHost.replaceChildren();
  const viewerScene = new THREE.Scene();
  viewerScene.background = new THREE.Color(0x151923);
  const viewerCamera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  const viewerRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  viewerRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  viewerRenderer.setSize(canvasHost.clientWidth || 720, canvasHost.clientHeight || 500);
  canvasHost.appendChild(viewerRenderer.domElement);
  viewerScene.add(new THREE.HemisphereLight(0xffffff, 0x5c6074, 2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2);
  keyLight.position.set(4, 8, 6);
  viewerScene.add(keyLight);
  const viewerControls = new OrbitControls(viewerCamera, viewerRenderer.domElement);
  viewerControls.enableDamping = true;
  const loader = new GLTFLoader();
  let animationFrame = 0;
  let mixerForViewer = null;
  let loadedRoot = null;
  loader.load(data.signedUrl, gltf => {
    loadedRoot = gltf.scene;
    viewerScene.add(loadedRoot);
    const bounds = new THREE.Box3().setFromObject(loadedRoot);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const dimension = Math.max(size.x, size.y, size.z) || 1;
    loadedRoot.position.sub(center);
    viewerCamera.position.set(0, dimension * 0.25, dimension * 2.6);
    viewerCamera.near = dimension / 1000;
    viewerCamera.far = dimension * 20;
    viewerCamera.updateProjectionMatrix();
    viewerControls.target.set(0, 0, 0);
    viewerControls.update();
    if (gltf.animations.length) {
      mixerForViewer = new THREE.AnimationMixer(loadedRoot);
      mixerForViewer.clipAction(gltf.animations[0]).play();
    }
  }, undefined, error => {
    console.error("Saved character preview failed:", error);
    showToast("Could not preview this character.");
  });
  const clock = new THREE.Clock();
  const render = () => {
    animationFrame = requestAnimationFrame(render);
    mixerForViewer?.update(clock.getDelta());
    viewerControls.update();
    viewerRenderer.render(viewerScene, viewerCamera);
  };
  render();
  const resize = () => {
    const width = canvasHost.clientWidth || 720;
    const height = canvasHost.clientHeight || 500;
    viewerCamera.aspect = width / height;
    viewerCamera.updateProjectionMatrix();
    viewerRenderer.setSize(width, height);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvasHost);
  canvasHost._cleanup = () => {
    cancelAnimationFrame(animationFrame);
    resizeObserver.disconnect();
    viewerControls.dispose();
    viewerRenderer.dispose();
    viewerScene.traverse(object => {
      object.geometry?.dispose();
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        if (!material) continue;
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      }
    });
  };
}

let characterPurchaseReturnHandled = false;
async function handleCharacterPurchaseReturn(session) {
  if (characterPurchaseReturnHandled) return;
  const params = new URLSearchParams(window.location.search);
  const result = params.get("character_purchase");
  if (!result) return;
  characterPurchaseReturnHandled = true;
  const checkoutSessionId = params.get("session_id");
  window.history.replaceState({}, "", window.location.pathname);
  if (result === "cancelled") {
    showToast("Checkout cancelled. Your character is still in the editor.", 3500);
    return;
  }
  if (result !== "success" || !checkoutSessionId || !session) return;

  showToast("Payment received. Saving your character to your library…", 5000);
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data: purchase } = await supabase
      .from("character_purchases")
      .select("id,status")
      .eq("stripe_checkout_session_id", checkoutSessionId)
      .maybeSingle();
    if (purchase?.status === "paid") {
      showToast("Character purchased and saved. You can download it again from My Characters.", 5000);
      await openPurchasedCharacters();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  showToast("Payment is being confirmed. Check My Characters in a moment.", 5000);
}

document.getElementById("close-purchases")?.addEventListener("click", () => {
  document.getElementById("purchases-overlay")?.classList.add("hidden");
});
document.querySelector("#purchases-overlay .overlay-backdrop")?.addEventListener("click", () => {
  document.getElementById("purchases-overlay")?.classList.add("hidden");
});




let selectedExportType = null;
let selectedFormat = null;
let currentCharacterPriceCents = null;
let currentCharacterCurrency = "usd";

function displayCharacterPrice() {
  if (currentCharacterPriceCents == null) return "Price unavailable";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currentCharacterCurrency.toUpperCase() }).format(currentCharacterPriceCents / 100);
}

async function refreshCharacterPrice() {
  const priceLabel = document.getElementById("full-price");
  currentCharacterPriceCents = null;
  if (priceLabel) priceLabel.textContent = "Loading price…";
  if (!currentBaseMesh) return;
  try {
    const response = await fetch(`${WORKER_URL}/character-price?baseMeshId=${encodeURIComponent(currentBaseMesh.id)}`);
    const data = await response.json();
    if (!response.ok || !Number.isSafeInteger(data.amountCents) || data.amountCents < 50) throw new Error(data.error || "Price unavailable.");
    currentCharacterPriceCents = data.amountCents;
    currentCharacterCurrency = data.currency || "usd";
    if (priceLabel) priceLabel.textContent = displayCharacterPrice();
  } catch (error) {
    console.error("Could not load character price:", error);
    if (priceLabel) priceLabel.textContent = "Price unavailable";
  }
  updateExportButton();
}

window.selectExportType = function(type, cardElement) {
  if (!['full', 'animation'].includes(type)) return;
  selectedExportType = type;
  document.querySelectorAll('.export-type-card').forEach(card => {
    const selected = card === cardElement;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-pressed', String(selected));
  });
  if (type === "full") {
    selectedFormat = "glb";
    document.querySelectorAll('.format-btn').forEach(button => {
      const selected = button.dataset.format === "glb";
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }
  updateExportButton();
};

window.selectFormat = function(format, buttonElement) {
  if (format === 'fbx' || buttonElement?.disabled) {
    showToast('FBX conversion is temporarily disabled.');
    return;
  }
  if (!['glb', 'gltf'].includes(format)) return;
  if (selectedExportType === "full" && format !== "glb") {
    showToast("Full character purchases are delivered as GLB.");
    return;
  }
  selectedFormat = format;
  document.querySelectorAll('.format-btn').forEach(button => {
    const selected = button === buttonElement;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  updateExportButton();
};

function updateExportButton() {
  const btn = document.getElementById('final-export-btn');
  if (!btn) return;
  const ready = !exportInProgress && selectedExportType && selectedFormat && (selectedExportType !== "full" || currentCharacterPriceCents != null);
  btn.disabled = !ready;
  btn.style.opacity = ready ? '1' : '0.5';
  btn.style.cursor = ready ? 'pointer' : 'not-allowed';
  if (!ready) {
    btn.textContent = exportInProgress ? "Preparing your character…" : selectedExportType === "full" && currentCharacterPriceCents == null ? "Loading character price…" : "Select options above";
    btn.onclick = null;
    return;
  }
  if (selectedExportType === "full") {
    btn.textContent = `Buy Full Character · ${displayCharacterPrice()}`;
  } else {
    btn.textContent = `Download Free Animation · ${selectedFormat.toUpperCase()}`;
  }
  btn.onclick = () => handleExport(selectedExportType, selectedFormat);
}
function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(clock.getDelta(), 0.033);
  if (mixer) mixer.update(delta);

  applyMorphsPerFrame();
  controls.update();
  renderer.render(scene, camera);
}

const textureLoader = new THREE.TextureLoader();
const baseColorPicker = document.getElementById("baseColorPicker");
const textureGrid = document.getElementById("texture-grid");
const materialTargetsContainer = document.getElementById("material-targets");
async function applyTexturePreset(preset) {
  const target = materialTargets[activeMaterialTarget];
  if (!target) return;

  target.materialState.texture = preset;


  let mapUrl = null;
  if (preset.r2Key) {
    try {
      mapUrl = await getAssetUrl("textures", preset.r2Key);
    } catch (err) {
      console.error("Failed to load texture URL:", err);
    }
  }


  let normalMapUrl = null;
  let metallicMapUrl = null;
  let roughnessMapUrl = null;
  let aoMapUrl = null;

  if (preset.r2KeyNormal) {
    try {
      normalMapUrl = await getAssetUrl("textures", preset.r2KeyNormal);
    } catch (err) {
      console.error("Failed to load normal map:", err);
    }
  }

  if (preset.r2KeyMetallic) {
    try {
      metallicMapUrl = await getAssetUrl("textures", preset.r2KeyMetallic);
    } catch (err) {
      console.error("Failed to load metallic map:", err);
    }
  }

  if (preset.r2KeyRoughness) {
    try {
      roughnessMapUrl = await getAssetUrl("textures", preset.r2KeyRoughness);
    } catch (err) {
      console.error("Failed to load roughness map:", err);
    }
  }

  if (preset.r2KeyAO) {
    try {
      aoMapUrl = await getAssetUrl("textures", preset.r2KeyAO);
    } catch (err) {
      console.error("Failed to load AO map:", err);
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
        mat.map.flipY = false;
      } else {
        mat.map = null;
      }


      if (normalMapUrl) {
        mat.normalMap = textureLoader.load(normalMapUrl);
      } else {
        mat.normalMap = null;
      }


      if (metallicMapUrl) {
        mat.metalnessMap = textureLoader.load(metallicMapUrl);
        mat.metalness = 1.0;
      } else {
        mat.metalnessMap = null;
        mat.metalness = 0.0;
      }


      if (roughnessMapUrl) {
        mat.roughnessMap = textureLoader.load(roughnessMapUrl);
        mat.roughness = 1.0;
      } else {
        mat.roughnessMap = null;
        mat.roughness = 0.5;
      }


      if (aoMapUrl) {
        mat.aoMap = textureLoader.load(aoMapUrl);
        mat.aoMapIntensity = 1.0;
      } else {
        mat.aoMap = null;
      }

      mat.needsUpdate = true;
    });
  });

  showToast(`Applied: ${preset.label}`);
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


  if (baseSkinnedMeshes.length) {

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


Object.entries(loadedClothingMeshes).forEach(([id, data]) => {
  const { root, materialDomain } = data;

  const meshes = [];
  root.traverse(o => o.isSkinnedMesh && meshes.push(o));
  if (!meshes.length) return;

  materialTargets[id] = {
    label: id,
    meshes,
    domain: materialDomain || "fabric",
    clothing: data.clothing,
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


  let presets = TEXTURE_PRESETS[target.domain] || [];


  if (currentBaseMesh) {
    presets = presets.filter(preset =>
      preset.compatibleMesh === "all" ||
      preset.compatibleMesh === currentBaseMesh.r2Key ||
      !preset.compatibleMesh
    );
  }

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


    if (preset.r2Key) {

      getAssetUrl("textures", preset.r2Key).then(url => {
        item.style.backgroundImage = `url(${url})`;
        item.style.backgroundSize = "cover";
        item.style.backgroundPosition = "center";
      }).catch(() => {
        item.innerText = preset.label;
      });
    } else {
      item.innerText = preset.label;
    }

    item.onclick = () => applyTexturePreset(preset);
    textureGrid.appendChild(item);
  });
}

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




  if (randomizerConfig.baseMesh && BASE_MESHES.length) {
    const mesh = BASE_MESHES[Math.floor(Math.random() * BASE_MESHES.length)];

    await new Promise(resolve => {
      loadBaseMesh(mesh, resolve);
    });
  }

  if (!currentBaseMesh) return;


  if (randomizerConfig.colors) {

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

      if (activeMaterialTarget === "base") {
        baseColorPicker.value = `#${randColor.getHexString()}`;
      }
    }
  }


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


  if (randomizerConfig.blendShapes && Object.keys(morphValues).length > 0) {
    Object.keys(morphValues).forEach(key => {
      morphValues[key] = Math.random() * 0.6;
    });

  }


  Object.entries(materialTargets).forEach(([key, target]) => {
    if (key === "base") return;
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


  activeMaterialTarget = Object.keys(materialTargets)[0] || "base";
  syncMaterialUI();
  rebuildMaterialTargetsUI();


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


  Object.keys(morphValues).forEach(k => {
    morphValues[k] = 0;
  });


  if (mixer) {
    mixer.stopAllAction();
    activeAction = null;
  }


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

function frameCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object);

  const size = box.getSize(new THREE.Vector3());
  const height = size.y;

  const center = box.getCenter(new THREE.Vector3());


  const targetY = box.min.y + height * 0.6;

  const target = new THREE.Vector3(
    center.x,
    targetY,
    center.z
  );

  const distance = height * 8;


  camera.position.set(
    center.x,
    targetY + height * 7,
    center.z - distance
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

  if (!width || !height) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}


const painterMode = document.getElementById("texture-painter-mode");
const painterViewport = document.getElementById("painter-viewport");
const exitPainterBtn = document.getElementById("exit-painter");

let previousUIMode = "materials";

function enterPainterMode() {
  if (!currentModel || !activeMaterialTarget) return;
  isPainterMode = true;


  const activeBtn = document.querySelector(".top-btn.active");
  previousUIMode = activeBtn?.dataset.mode || "materials";


  document.getElementById("top-panel").classList.add("hidden");
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.getElementById("clothes-items-panel")?.classList.remove("active");
  painterControls = controls;

  painterMode.classList.remove("hidden");


  originalViewportParent = renderer.domElement.parentElement;
  painterViewport.appendChild(renderer.domElement);

  framePainterCamera();
  onResize();
}
function exitPainterMode() {

  if (window.posthog) {
    const paintDuration = Date.now() - (window.painterStartTime || Date.now());
    posthog.capture('painter_closed', {
      duration_ms: paintDuration,
      strokes_count: window.painterStrokesCount || 0
    });
  }

  isPainterMode = false;


  if (controls) {
    controls.enabled = true;
  }


  if (originalViewportParent) {
    originalViewportParent.appendChild(renderer.domElement);
  }

  painterMode.classList.add("hidden");


  document.getElementById("top-panel").classList.remove("hidden");


  setUIMode(previousUIMode);

  onResize();
}
document.getElementById("open-texture-painter").addEventListener("click", () => {
  const target = materialTargets[activeMaterialTarget];
  if (!target) {
    alert("No material selected");
    return;
  }


  const meshId = activeMaterialTarget;


  ensureMeshTextureData(meshId, maxAllowedResolution);


  currentPainterMesh = meshId;


  const meshData = meshTextureData[meshId];


  if (Object.keys(meshData.textures).length === 0) {
    createTextureForMesh(meshId, 'custom_1', 'Custom Texture 1', true);
    meshData.selectedTexture = 'custom_1';
  }


  currentTextureName = meshData.selectedTexture || 'custom_1';


  const texData = meshData.textures[currentTextureName];


  painterCanvas = texData.canvas;
  painterTargetMesh = target.meshes[0];


  texturePainter = new TexturePainter({
    canvas: painterCanvas,
    mesh: painterTargetMesh,
    material: painterTargetMesh.material,
    texture: texData.texture
  });


  applySelectedTexture();


  const currentColor = texturePainter.color || '#ffffff';
  document.getElementById('paint-color').value = currentColor;


  updateTextureUI(meshId);
  updateResetButtonState();


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


    document.querySelectorAll(".tool-btn").forEach(btn =>
      btn.classList.toggle("active", btn === b)
    );


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
  updateTextureView();
});
function updateTextureView() {

  const uiCanvas = document.getElementById("texture-canvas");
  if (!uiCanvas) return;

  const uiCtx = uiCanvas.getContext("2d");


  if (!painterCanvas) return;


  if (
    uiCanvas.width !== painterCanvas.width ||
    uiCanvas.height !== painterCanvas.height
  ) {
    uiCanvas.width = painterCanvas.width;
    uiCanvas.height = painterCanvas.height;
  }


  uiCtx.setTransform(1, 0, 0, 1, 0, 0);
  uiCtx.clearRect(0, 0, uiCanvas.width, uiCanvas.height);


  uiCtx.translate(
    uiCanvas.width / 2 + texOffsetX,
    uiCanvas.height / 2 + texOffsetY
  );
  uiCtx.scale(texZoom, texZoom);
  uiCtx.translate(
    -painterCanvas.width / 2,
    -painterCanvas.height / 2
  );


  uiCtx.drawImage(painterCanvas, 0, 0);



if (showUVOverlay && uvOverlayImage) {
  uiCtx.save();

  uiCtx.globalAlpha = uvOpacity;
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


  if (tool === "move") {

    return;
  }

  if (tool === "draw" || tool === "erase") {

    const brushSize = texturePainter.brushSize || 10;

    uiCtx.save();
    uiCtx.strokeStyle = tool === "erase" ? "#ff5555" : "#7c5cff";
    uiCtx.lineWidth = 2;
    uiCtx.setLineDash([4, 4]);


    uiCtx.beginPath();
    uiCtx.arc(canvasMouseX, canvasMouseY, brushSize * texZoom / 2, 0, Math.PI * 2);
    uiCtx.stroke();

    uiCtx.restore();
  } else if (tool === "bucket") {

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


  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;


  let x = mx - uiCanvas.width / 2;
  let y = my - uiCanvas.height / 2;


  x -= texOffsetX;
  y -= texOffsetY;


  x /= texZoom;
  y /= texZoom;


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





let isPaintingLocal = false;
let lastPaintX = null;
let lastPaintY = null;


uiCanvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (!texturePainter) return;

  const tool = texturePainter.tool;


  if (tool === "move") {
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    uiCanvas.style.cursor = "grabbing";
    return;
  }


  const coords = getTextureCoordsFromMouse(e, uiCanvas);
  if (!coords) return;


  if (currentPainterMesh && currentTextureName) {
    saveToHistory(currentPainterMesh, currentTextureName);
  }

  isPaintingLocal = true;
  lastPaintX = coords.x;
  lastPaintY = coords.y;


  texturePainter.startDraw(coords.x, coords.y);


  updateTextureView();
});


uiCanvas.addEventListener("mousemove", (e) => {
  if (!texturePainter) return;

  const tool = texturePainter.tool;


  if (tool === "move" && isPanning) {
    texOffsetX += e.clientX - panStartX;
    texOffsetY += e.clientY - panStartY;
    panStartX = e.clientX;
    panStartY = e.clientY;
    updateTextureView();
    return;
  }


  if (!isPaintingLocal) return;

  const coords = getTextureCoordsFromMouse(e, uiCanvas);
  if (!coords) return;


  texturePainter.draw(coords.x, coords.y);

  lastPaintX = coords.x;
  lastPaintY = coords.y;


  updateTextureView();
});


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


async function getUVMapForActiveTarget() {

  let targetAsset = null;
  let assetType = "base mesh";


  const target = materialTargets[activeMaterialTarget];
  if (target && target.clothing) {

    targetAsset = target.clothing;
    assetType = target.clothing.type || "clothing";
  } else {

    targetAsset = currentBaseMesh;
  }


  if (!targetAsset?.uv_map) {
    console.warn(`No UV map defined for ${assetType}:`, targetAsset?.id);
    return null;
  }

  try {

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



const userBtn = document.getElementById("user-btn");
const userMenu = document.getElementById("user-menu");
const purchasesBtn = document.getElementById("purchases-btn");

userBtn.onclick = (e) => {
  e.stopPropagation();
  userMenu.classList.toggle("hidden");
};

purchasesBtn.onclick = (e) => {
  e.stopPropagation();
  userMenu.classList.add("hidden");
  openPurchasedCharacters();
};

document.addEventListener("click", () => {
  userMenu.classList.add("hidden");
});

userMenu.addEventListener("click", e => e.stopPropagation());




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


      const authOverlay = document.getElementById("auth-overlay");
      if (authOverlay) {
        authOverlay.classList.remove("hidden");
        document.body.style.overflow = "hidden";

        document.querySelectorAll("[data-auth-tab]").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".auth-panel").forEach(p => p.classList.remove("active"));
        document.querySelector("[data-auth-tab='signup']")?.classList.add("active");
        document.getElementById("signup-panel")?.classList.add("active");
      }
    });
  }
}


const authOverlay = document.getElementById("auth-overlay");
const closeAuthBtn = document.getElementById("close-auth");

const authTabs = document.querySelectorAll(".auth-tab");
const authSubmit = document.getElementById("auth-submit");
const authTitle = document.getElementById("auth-title");
const authError = document.getElementById("auth-error");

let authMode = "signup";




closeAuthBtn.addEventListener("click", () => {
  authOverlay.classList.add("hidden");
});


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


  const signupCheckboxes = document.getElementById("signup-checkboxes");
  if (signupCheckboxes) {
    signupCheckboxes.style.display = authMode === "signup" ? "block" : "none";
  }
}


updateAuthUI();




authSubmit.addEventListener("click", async () => {
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;

  authError.textContent = "";

  if (!email || !password) {
    authError.textContent = "Please enter your email and password.";
    return;
  }


  if (authMode === "signup") {
    const termsCheckbox = document.getElementById("terms-checkbox");
    if (termsCheckbox && !termsCheckbox.checked) {
      authError.textContent = "You must agree to the Terms of Service and Privacy Policy";
      return;
    }
  }

  try {
    if (authMode === "signup") {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;


      const newsletterCheckbox = document.getElementById("newsletter-checkbox");
      if (newsletterCheckbox && newsletterCheckbox.checked) {
        try {
          await supabase.from("newsletter").upsert({ email }, { onConflict: "email" });
        } catch (newsError) {
          console.error("Newsletter subscription failed:", newsError);

        }
      }


      if (!data.session) {
        authError.style.color = "#4caf50";
        authError.textContent = "Check your email to confirm your account!";
        return;
      }


    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

    }

    document.getElementById("auth-overlay").classList.add("hidden");
    showToast("Welcome to Morphara 🎉");

  } catch (err) {
    authError.style.color = "";
    authError.textContent = err.message;
  }
});



document.getElementById("github-auth").addEventListener("click", async () => {
  await supabase.auth.signInWithOAuth({
    provider: "github",
    options: {
      redirectTo: window.location.origin
    }
  });
});



const settingsOverlay = document.getElementById("settings-overlay");
const closeSettingsBtn = document.getElementById("close-settings");

if (closeSettingsBtn) {
  closeSettingsBtn.addEventListener("click", () => {
    settingsOverlay.style.display = "none";
  });
}


settingsOverlay?.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.style.display = "none";
});


document.getElementById("change-password-btn")?.addEventListener("click", async () => {
  const password = document.getElementById("settings-new-password")?.value || "";
  const message = document.getElementById("settings-password-message");
  if (password.length < 8) {
    if (message) message.textContent = "Use at least 8 characters for your new password.";
    return;
  }
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    if (message) message.textContent = error.message;
    return;
  }
  document.getElementById("settings-new-password").value = "";
  if (message) message.textContent = "Password updated.";
});

document.getElementById("settings-library-btn")?.addEventListener("click", () => {
  settingsOverlay.style.display = "none";
  openPurchasedCharacters();
});

document.getElementById("settings-signout-btn")?.addEventListener("click", async () => {
  const { error } = await supabase.auth.signOut();
  if (error) { showToast(error.message); return; }
  settingsOverlay.style.display = "none";
  showToast("Signed out.");
});


document.getElementById("delete-account-btn")?.addEventListener("click", async () => {
  const confirmed = prompt('Type "DELETE" to confirm account deletion:');

  if (confirmed !== "DELETE") {
    showToast("Account deletion cancelled");
    return;
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;


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
  if (session && pendingExportAfterSignIn) {
    pendingExportAfterSignIn = false;
    document.getElementById("auth-overlay")?.classList.add("hidden");
    document.getElementById("export-panel-overlay")?.classList.remove("hidden");
    refreshCharacterPrice();
    updateExportButton();
    renderExportPreview();
  }
  if (session && !document.getElementById("purchases-overlay")?.classList.contains("hidden")) {
    openPurchasedCharacters();
  }
});

document.getElementById("close-character-viewer")?.addEventListener("click", () => {
  const overlay = document.getElementById("character-viewer-overlay");
  const host = document.getElementById("character-viewer-canvas");
  if (host?._cleanup) host._cleanup();
  host?.replaceChildren();
  overlay?.classList.add("hidden");
});




async function initializeTexturePainterV2() {
  maxAllowedResolution = 4096;
  document.querySelectorAll('#texture-resolution-select option').forEach(option => {
    option.disabled = false;
  });
  const hint = document.getElementById('resolution-upgrade-hint');
  if (hint) hint.style.display = 'none';
  setupTexturePainterListeners();
}
function setupTexturePainterListeners() {

  document.getElementById('texture-resolution-select')
    .addEventListener('change', async (e) => {
      const newRes = parseInt(e.target.value);
      if (!currentPainterMesh) { showToast('No mesh selected'); e.target.value = 1024; return; }
      if (newRes > maxAllowedResolution) { showToast('Maximum texture size is 4096px.'); e.target.value = maxAllowedResolution; return; }
      if (isPainterMode) { showToast('Exit texture painter before changing resolution'); e.target.value = meshTextureData[currentPainterMesh]?.resolution || 1024; return; }
      await changeTextureResolution(currentPainterMesh, newRes, materialTargets);
      showToast(`Resolution changed to ${newRes}x${newRes}`);
    });

  document.getElementById('active-texture-select')
    .addEventListener('change', (e) => {
      if (!currentPainterMesh) return;
      selectTexture(currentPainterMesh, e.target.value, materialTargets, (name) => {
        currentTextureName = name;
        updateTextureUI(currentPainterMesh);
        showToast(`Switched to ${meshTextureData[currentPainterMesh].textures[name].name}`);
      });
    });

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


  document.addEventListener('keydown', (e) => {
    if (!isPainterMode) return;
    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(currentPainterMesh, currentTextureName, () => updateTextureView()); }
    if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(currentPainterMesh, currentTextureName, () => updateTextureView()); }
  });


  document.getElementById('roughness-slider').addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    document.getElementById('roughness-value').textContent = value.toFixed(2);
    if (currentPainterMesh && currentTextureName)
      updateMaterialProperty(currentPainterMesh, currentTextureName, 'roughness', value, materialTargets);
  });


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
